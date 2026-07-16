import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { fetchCandlesRange, buildSignalEvaluator } from "../tools/backtest-tools.js";
import { Candle } from "../backtest/types.js";

// Autonomous paper-trading runner. Polls Binance REST for newly-closed
// candles per (symbol, timeframe) group, evaluates every pool strategy's
// entry condition via buildSignalEvaluator — the SAME function
// runFuturesBacktest uses — and simulates fills/exits with the strategy's
// own stated stop/target/maxHoldBars. Each strategy trades its own isolated
// virtual capital bucket (not a shared/fusion pool — matches how every
// strategy's numbers in strategies.json were individually validated, so
// live results are directly comparable to the backtest per strategy).
//
// State persists to disk so a restart resumes cleanly. Every fill (entry or
// exit) is appended to a JSONL trade journal for post-hoc comparison against
// the backtested WR/PF/Sharpe.

export interface StrategyDef {
  id: string; symbol: string; tf: string; direction: "long" | "short";
  entry: { type: string; period?: number; value?: number }[];
  stopPct: number; targetPct: number; maxHoldBars: number;
}

interface OpenPosition {
  entryPrice: number; entryTime: number; entryBarIdx: number;
  qty: number; margin: number; notional: number;
  stopPrice: number; targetPrice: number; liqPrice: number;
}

interface StratState {
  capital: number;
  position: OpenPosition | null;
  trades: number; wins: number; losses: number;
  lastEvalOpenTime: number; // last candle openTime this strategy was evaluated against
}

export interface RunnerConfig {
  initialCapitalPerStrategy: number;
  leverage: number;
  marginPerTradePct: number;
  feeBps: number;
  slippageBps: number;
  stateFile: string;
  journalFile: string;
  lookbackDaysByTf: Record<string, number>;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  initialCapitalPerStrategy: 10000,
  leverage: 5,
  marginPerTradePct: 0.05,
  feeBps: 5,
  slippageBps: 3,
  stateFile: ".trading-agent/paper-state.json",
  journalFile: ".trading-agent/paper-trades.jsonl",
  // generous warmup margin over the longest indicator lookback in the pool (ichimoku=52 bars)
  lookbackDaysByTf: { "15m": 8, "30m": 15, "1h": 25, "2h": 50, "4h": 100, "1d": 400 },
};

function loadStrategiesFromPool(poolPath = "strategies.json"): StrategyDef[] {
  const cfg = JSON.parse(readFileSync(poolPath, "utf-8"));
  const out: StrategyDef[] = [];
  for (const [symbol, strats] of Object.entries(cfg.symbols) as [string, any[]][]) {
    for (const s of strats) {
      out.push({
        id: s.id, symbol, tf: s.tf ?? "1h", direction: s.direction,
        entry: s.entry, stopPct: s.risk.stopPct, targetPct: s.risk.targetPct,
        maxHoldBars: s.maxHoldBars ?? 48,
      });
    }
  }
  return out;
}

export class LivePaperRunner {
  private strategies: StrategyDef[];
  private state: Record<string, StratState> = {};
  private cfg: RunnerConfig;
  private running = false;

  constructor(cfg: Partial<RunnerConfig> = {}, poolPath = "strategies.json") {
    this.cfg = { ...DEFAULT_RUNNER_CONFIG, ...cfg };
    this.strategies = loadStrategiesFromPool(poolPath);
    this.loadState();
  }

  private loadState() {
    if (existsSync(this.cfg.stateFile)) {
      try {
        this.state = JSON.parse(readFileSync(this.cfg.stateFile, "utf-8"));
      } catch {
        this.state = {};
      }
    }
    for (const s of this.strategies) {
      if (!this.state[s.id]) {
        this.state[s.id] = { capital: this.cfg.initialCapitalPerStrategy, position: null, trades: 0, wins: 0, losses: 0, lastEvalOpenTime: 0 };
      }
    }
  }

  private saveState() {
    const dir = dirname(this.cfg.stateFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.cfg.stateFile, JSON.stringify(this.state, null, 2));
  }

  private journal(event: Record<string, unknown>) {
    const dir = dirname(this.cfg.journalFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.cfg.journalFile, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  }

  getStatus() {
    return this.strategies.map(s => {
      const st = this.state[s.id];
      return {
        id: s.id, symbol: s.symbol, tf: s.tf, direction: s.direction,
        capital: Math.round(st.capital * 100) / 100,
        pnl: Math.round((st.capital - this.cfg.initialCapitalPerStrategy) * 100) / 100,
        trades: st.trades, wins: st.wins, losses: st.losses,
        winRate: st.trades > 0 ? st.wins / st.trades : null,
        openPosition: st.position ? {
          entryPrice: st.position.entryPrice, entryTime: new Date(st.position.entryTime).toISOString(),
          qty: st.position.qty, notional: st.position.notional,
          stopPrice: st.position.stopPrice, targetPrice: st.position.targetPrice,
        } : null,
      };
    });
  }

  getSymbols(): string[] {
    return [...new Set(this.strategies.map(s => s.symbol))];
  }

  // Display-only mark-to-market — NOT used by any trading decision. Actual
  // entries/exits only ever evaluate on closed candles (see tick() below),
  // matching the backtest engine bar-for-bar. This exists purely so the
  // dashboard can show unrealized PnL between candle closes without the
  // live price ever influencing what the bot does.
  unrealizedPnl(strategyId: string, livePrice: number): number | null {
    const s = this.strategies.find(x => x.id === strategyId);
    const st = s && this.state[s.id];
    if (!s || !st?.position) return null;
    const feeFrac = this.cfg.feeBps / 10000;
    const raw = (livePrice - st.position.entryPrice) * (s.direction === "long" ? 1 : -1) * st.position.qty;
    return raw - st.position.notional * feeFrac;
  }

  // One polling cycle: fetch latest candles per (symbol, tf) group once,
  // then evaluate/manage every strategy in that group against them.
  async tick(): Promise<{ groupsChecked: number; newCandles: number; fills: number; evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] }> {
    const groups = new Map<string, StrategyDef[]>();
    for (const s of this.strategies) {
      const key = `${s.symbol}:${s.tf}`;
      const arr = groups.get(key);
      if (arr) arr.push(s); else groups.set(key, [s]);
    }

    let newCandles = 0, fills = 0;
    const evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] = [];
    for (const [key, strats] of groups) {
      const [symbol, tf] = key.split(":");
      const lookbackDays = this.cfg.lookbackDaysByTf[tf] ?? 30;
      const endTime = Date.now();
      const startTime = endTime - lookbackDays * 24 * 60 * 60 * 1000;
      const fetched = await fetchCandlesRange(symbol, tf, startTime, endTime);
      if ("error" in fetched) {
        this.journal({ type: "fetch_error", symbol, tf, message: fetched.message });
        continue;
      }
      let candles: Candle[] = fetched.candles;
      // Drop the still-forming candle (Binance includes it as the last row).
      const tfMs = tfToMs(tf);
      if (candles.length > 0 && candles[candles.length - 1].openTime + tfMs > Date.now()) {
        candles = candles.slice(0, -1);
      }
      if (candles.length === 0) continue;
      const lastClosed = candles[candles.length - 1];

      for (const strat of strats) {
        const st = this.state[strat.id];
        const isNew = lastClosed.openTime > st.lastEvalOpenTime;

        // Manage an open position against the newest closed candle (same
        // per-bar check the backtest engine does).
        if (st.position && isNew) {
          const pos = st.position;
          const bar = lastClosed;
          const dir = strat.direction;
          const hitLiq = dir === "long" ? bar.low <= pos.liqPrice : bar.high >= pos.liqPrice;
          const hitStop = dir === "long" ? bar.low <= pos.stopPrice : bar.high >= pos.stopPrice;
          const hitTarget = dir === "long" ? bar.high >= pos.targetPrice : bar.low <= pos.targetPrice;
          const barsHeld = candles.length - 1 - pos.entryBarIdx;
          const timedOut = barsHeld >= strat.maxHoldBars;

          if (hitLiq || hitStop || hitTarget || timedOut) {
            let exitPrice: number, reason: string;
            if (hitLiq) { exitPrice = pos.liqPrice; reason = "liquidation"; }
            else if (hitStop) { exitPrice = pos.stopPrice; reason = "stop"; }
            else if (hitTarget) { exitPrice = pos.targetPrice; reason = "target"; }
            else { exitPrice = bar.close; reason = "timeout"; }
            const feeFrac = this.cfg.feeBps / 10000;
            const pnl = (exitPrice - pos.entryPrice) * (dir === "long" ? 1 : -1) * pos.qty - pos.notional * feeFrac;
            st.capital += pnl;
            st.trades++; if (pnl > 0) st.wins++; else st.losses++;
            st.position = null;
            fills++;
            this.journal({ type: "exit", strategyId: strat.id, symbol, tf, direction: dir, reason, exitPrice, pnl: Math.round(pnl * 100) / 100, capitalAfter: Math.round(st.capital * 100) / 100 });
          }
        }

        // Look for a new entry only if flat and this candle hasn't been checked yet.
        let fired = false;
        if (!st.position && isNew) {
          const evaluator = buildSignalEvaluator(candles, strat.entry);
          const i = candles.length - 1;
          fired = evaluator(i);
          if (fired) {
            const slipFrac = this.cfg.slippageBps / 10000;
            const rawEntry = candles[i].close;
            const entryPrice = strat.direction === "long" ? rawEntry * (1 + slipFrac) : rawEntry * (1 - slipFrac);
            const margin = st.capital * this.cfg.marginPerTradePct;
            const notional = margin * this.cfg.leverage;
            const qty = notional / entryPrice;
            const stopPrice = strat.direction === "long" ? entryPrice * (1 - strat.stopPct) : entryPrice * (1 + strat.stopPct);
            const targetPrice = strat.direction === "long" ? entryPrice * (1 + strat.targetPct) : entryPrice * (1 - strat.targetPct);
            const liqPrice = strat.direction === "long" ? entryPrice * (1 - 1 / this.cfg.leverage + 0.005) : entryPrice * (1 + 1 / this.cfg.leverage - 0.005);
            st.position = { entryPrice, entryTime: candles[i].openTime, entryBarIdx: i, qty, margin, notional, stopPrice, targetPrice, liqPrice };
            fills++;
            this.journal({ type: "entry", strategyId: strat.id, symbol, tf, direction: strat.direction, entryPrice, stopPrice, targetPrice, margin: Math.round(margin * 100) / 100 });
          }
        }

        evaluations.push({ strategyId: strat.id, symbol, tf, checked: isNew, fired, lastClosedCandleTime: lastClosed.openTime });
        if (isNew) st.lastEvalOpenTime = lastClosed.openTime;
      }
      newCandles++;
    }

    this.saveState();
    return { groupsChecked: groups.size, newCandles, fills, evaluations };
  }

  async start(pollMs = 60_000, onTick?: (result: { groupsChecked: number; newCandles: number; fills: number; evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] }) => void) {
    this.running = true;
    while (this.running) {
      try {
        const result = await this.tick();
        onTick?.(result);
      } catch (e) {
        this.journal({ type: "tick_error", message: (e as Error).message });
      }
      if (!this.running) break;
      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  stop() {
    this.running = false;
  }
}

function tfToMs(tf: string): number {
  const unit = tf.slice(-1);
  const n = Number(tf.slice(0, -1));
  const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
  return n * mult;
}
