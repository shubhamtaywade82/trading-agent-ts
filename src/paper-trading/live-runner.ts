import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { fetchCandlesRange, buildSignalEvaluator } from "../tools/backtest-tools.js";
import { Candle } from "../backtest/types.js";
import { BinanceStreamManager } from "../exchange/binance-stream.js";

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
  paused?: boolean; // set externally (circuit-breaker); blocks new entries only, exits still managed
}

export interface RunnerConfig {
  initialCapitalPerStrategy: number;
  leverage: number;
  marginPerTradePct: number;
  feeBps: number;
  slippageBps: number;
  volSizing: boolean;   // scale margin down when current ATR% runs hot vs the lookback average
  funding: boolean;     // charge/credit real Binance funding rates on exit
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
  volSizing: true,
  funding: true,
  stateFile: ".trading-agent/paper-state.json",
  journalFile: ".trading-agent/paper-trades.jsonl",
  // generous warmup margin over the longest indicator lookback in the pool (ichimoku=52 bars)
  lookbackDaysByTf: { "15m": 8, "30m": 15, "1h": 25, "2h": 50, "4h": 100, "1d": 400 },
};

// Volatility-aware sizing scale. Compares recent ATR% (last `period` true
// ranges) against the average over the whole candle window: when current
// volatility runs hot, a fixed-% stop is more likely to be tagged by noise,
// so size down proportionally. Downsize-only (clamped to [0.5, 1]) — never
// sizes UP in quiet regimes, so live stays conservatively comparable to the
// fixed-size backtest.
export function volScale(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 1;
  const trs: number[] = [];
  for (let j = 1; j < candles.length; j++) {
    const c = candles[j], pc = candles[j - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)) / pc);
  }
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const cur = avg(trs.slice(-period));
  const ref = avg(trs);
  if (cur <= 0 || ref <= 0) return 1;
  return Math.min(1, Math.max(0.5, ref / cur));
}

// Funding PnL over a held position: longs PAY when the rate is positive,
// shorts RECEIVE. `rates` are the per-event funding rates (e.g. 0.0001)
// that occurred while the position was open.
// ponytail: applied to entry notional, not per-event mark notional — the
// error is a rounding term at 8h funding granularity.
export function fundingPnl(rates: number[], notional: number, direction: "long" | "short"): number {
  const sum = rates.reduce((s, r) => s + r, 0);
  return (direction === "long" ? -1 : 1) * sum * notional;
}

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
  // Portfolio-wide daily-loss halt, set by StrategyCircuitBreaker. Blocks
  // new entries only; exits still managed. In-memory on purpose: the breaker
  // recomputes today's realized loss from the journal every check, so a
  // restart re-derives the halt instead of trusting stale persisted state.
  private globalHalt = false;

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
          qty: st.position.qty, notional: st.position.notional, margin: st.position.margin,
          stopPrice: st.position.stopPrice, targetPrice: st.position.targetPrice,
        } : null,
      };
    });
  }

  getSymbols(): string[] {
    return [...new Set(this.strategies.map(s => s.symbol))];
  }

  // Called by CircuitBreaker (in-process, same daemon) to pause/resume new
  // entries for a strategy. Mutates in-memory state directly and persists —
  // going through the file would race with this class's own saveState()
  // calls on every tick. Blocks new entries only; open positions still exit
  // normally (see processGroup()'s exit-management block, unconditional).
  setPaused(strategyId: string, paused: boolean): void {
    const st = this.state[strategyId];
    if (!st) return;
    st.paused = paused;
    this.saveState();
  }

  isPaused(strategyId: string): boolean {
    return !!this.state[strategyId]?.paused;
  }

  setGlobalHalt(on: boolean): void {
    this.globalHalt = on;
  }

  isGlobalHalted(): boolean {
    return this.globalHalt;
  }

  // Picks up strategies newly appended to strategies.json (e.g. by
  // ResearchPipeline's auto-promotion) without a process restart. Only
  // ADDS — never removes or mutates an existing strategy's definition or
  // state, so open positions and history are untouched. Each newly-added
  // strategy starts with its own fresh isolated capital bucket, same as
  // every strategy already does.
  reloadPool(poolPath = "strategies.json"): number {
    const fresh = loadStrategiesFromPool(poolPath);
    const existingIds = new Set(this.strategies.map(s => s.id));
    const added = fresh.filter(s => !existingIds.has(s.id));
    for (const s of added) {
      this.strategies.push(s);
      this.state[s.id] = { capital: this.cfg.initialCapitalPerStrategy, position: null, trades: 0, wins: 0, losses: 0, lastEvalOpenTime: 0 };
    }
    if (added.length > 0) this.saveState();
    return added.length;
  }

  // Portfolio-level rollup across every strategy's isolated capital bucket —
  // each strategy still trades its own $10k slice (see class comment above),
  // this just sums them into the account-level numbers a broker UI shows.
  getPortfolio() {
    let totalCapital = 0, usedMargin = 0;
    let openCount = 0;
    for (const s of this.strategies) {
      const st = this.state[s.id];
      totalCapital += st.capital;
      if (st.position) { usedMargin += st.position.margin; openCount++; }
    }
    const totalInitial = this.strategies.length * this.cfg.initialCapitalPerStrategy;
    const totalRealizedPnl = totalCapital - totalInitial;
    return {
      totalInitialCapital: totalInitial,
      totalRealizedPnl,
      usedMargin,
      availableBalance: totalCapital - usedMargin,
      openPositions: openCount,
      strategyCount: this.strategies.length,
      leverage: this.cfg.leverage,
      marginPerTradePct: this.cfg.marginPerTradePct,
      // totalEquity intentionally excludes unrealized PnL — caller adds it in
      // (unrealized requires live prices, which this class doesn't track).
      totalCapitalNoUnrealized: totalCapital,
    };
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

  private groupMap(): Map<string, StrategyDef[]> {
    const groups = new Map<string, StrategyDef[]>();
    for (const s of this.strategies) {
      const key = `${s.symbol}:${s.tf}`;
      const arr = groups.get(key);
      if (arr) arr.push(s); else groups.set(key, [s]);
    }
    return groups;
  }

  // Fetch + evaluate/manage every strategy in one (symbol, tf) group. Shared
  // by the REST poll safety net (tick()) and the event-driven WS trigger
  // (attachStream()) — identical decision logic either way, only the trigger
  // differs (fixed timer vs. a closed-kline push).
  private async processGroup(symbol: string, tf: string, strats: StrategyDef[]): Promise<{ hadCandles: boolean; fills: number; evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] }> {
    const lookbackDays = this.cfg.lookbackDaysByTf[tf] ?? 30;
    const endTime = Date.now();
    const startTime = endTime - lookbackDays * 24 * 60 * 60 * 1000;
    const fetched = await fetchCandlesRange(symbol, tf, startTime, endTime);
    if ("error" in fetched) {
      this.journal({ type: "fetch_error", symbol, tf, message: fetched.message });
      return { hadCandles: false, fills: 0, evaluations: [] };
    }
    let candles: Candle[] = fetched.candles;
    // Drop the still-forming candle (Binance includes it as the last row).
    const tfMs = tfToMs(tf);
    if (candles.length > 0 && candles[candles.length - 1].openTime + tfMs > Date.now()) {
      candles = candles.slice(0, -1);
    }
    if (candles.length === 0) return { hadCandles: false, fills: 0, evaluations: [] };
    const lastClosed = candles[candles.length - 1];

    let fills = 0;
    const evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] = [];
    for (const strat of strats) {
      const st = this.state[strat.id];
      const isNew = lastClosed.openTime > st.lastEvalOpenTime;

      // Manage an open position against the newest closed candle (same
      // per-bar check the backtest engine does). Runs regardless of pause
      // state — pause only blocks NEW entries, never exits.
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
          let pnl = (exitPrice - pos.entryPrice) * (dir === "long" ? 1 : -1) * pos.qty - pos.notional * feeFrac;
          // Position lives from entry-candle close to exit-bar close; charge
          // any funding events (every 8h) that fell inside that span.
          let funding = 0;
          const heldFrom = pos.entryTime + tfMs, heldTo = bar.openTime + tfMs;
          if (this.cfg.funding && Math.floor(heldTo / EIGHT_H) > Math.floor(heldFrom / EIGHT_H)) {
            try {
              const rates = await fetchFundingRates(symbol, heldFrom, heldTo);
              funding = fundingPnl(rates, pos.notional, dir);
              pnl += funding;
            } catch (e) {
              this.journal({ type: "funding_fetch_error", strategyId: strat.id, symbol, message: (e as Error).message });
            }
          }
          st.capital += pnl;
          st.trades++; if (pnl > 0) st.wins++; else st.losses++;
          st.position = null;
          fills++;
          this.journal({ type: "exit", strategyId: strat.id, symbol, tf, direction: dir, reason, exitPrice, pnl: Math.round(pnl * 100) / 100, funding: Math.round(funding * 100) / 100, capitalAfter: Math.round(st.capital * 100) / 100 });
        }
      }

      // Look for a new entry only if flat, this candle hasn't been checked
      // yet, and the strategy isn't paused (circuit-breaker sets this flag —
      // see circuit-breaker.ts; buildSignalEvaluator itself never changes).
      let fired = false;
      if (!st.position && isNew && !st.paused && !this.globalHalt) {
        const evaluator = buildSignalEvaluator(candles, strat.entry);
        const i = candles.length - 1;
        fired = evaluator(i);
        if (fired) {
          const slipFrac = this.cfg.slippageBps / 10000;
          const rawEntry = candles[i].close;
          const entryPrice = strat.direction === "long" ? rawEntry * (1 + slipFrac) : rawEntry * (1 - slipFrac);
          const scale = this.cfg.volSizing ? volScale(candles) : 1;
          const margin = st.capital * this.cfg.marginPerTradePct * scale;
          const notional = margin * this.cfg.leverage;
          const qty = notional / entryPrice;
          const stopPrice = strat.direction === "long" ? entryPrice * (1 - strat.stopPct) : entryPrice * (1 + strat.stopPct);
          const targetPrice = strat.direction === "long" ? entryPrice * (1 + strat.targetPct) : entryPrice * (1 - strat.targetPct);
          const liqPrice = strat.direction === "long" ? entryPrice * (1 - 1 / this.cfg.leverage + 0.005) : entryPrice * (1 + 1 / this.cfg.leverage - 0.005);
          st.position = { entryPrice, entryTime: candles[i].openTime, entryBarIdx: i, qty, margin, notional, stopPrice, targetPrice, liqPrice };
          fills++;
          this.journal({ type: "entry", strategyId: strat.id, symbol, tf, direction: strat.direction, entryPrice, stopPrice, targetPrice, margin: Math.round(margin * 100) / 100, volScale: Math.round(scale * 100) / 100 });
        }
      }

      evaluations.push({ strategyId: strat.id, symbol, tf, checked: isNew, fired, lastClosedCandleTime: lastClosed.openTime });
      if (isNew) st.lastEvalOpenTime = lastClosed.openTime;
    }

    return { hadCandles: true, fills, evaluations };
  }

  // One polling cycle: fetch latest candles per (symbol, tf) group once,
  // then evaluate/manage every strategy in that group against them. Safety
  // net for stop/target/liquidation checks (must see every bar) and fallback
  // entry path if a kline stream drops — see attachStream() for the faster,
  // event-driven entry path.
  async tick(): Promise<{ groupsChecked: number; newCandles: number; fills: number; evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] }> {
    const groups = this.groupMap();
    let newCandles = 0, fills = 0;
    const evaluations: { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }[] = [];
    for (const [key, strats] of groups) {
      const [symbol, tf] = key.split(":");
      const result = await this.processGroup(symbol, tf, strats);
      if (result.hadCandles) newCandles++;
      fills += result.fills;
      evaluations.push(...result.evaluations);
    }

    this.saveState();
    return { groupsChecked: groups.size, newCandles, fills, evaluations };
  }

  // Subscribes a kline WS stream per (symbol, tf) group so entry evaluation
  // fires the instant Binance reports a closed candle, instead of waiting up
  // to pollMs for the next tick(). tick()'s REST poll keeps running
  // unchanged as the safety net for stop/target/liquidation checks and as a
  // fallback if a stream drops. Purely additive — no decision logic here,
  // just an earlier trigger into the same processGroup().
  async attachStream(stream: BinanceStreamManager): Promise<void> {
    const groups = this.groupMap();
    await Promise.all([...groups].map(([key, strats]) => {
      const [symbol, tf] = key.split(":");
      return stream.subscribeKline(symbol, tf, () => {
        this.processGroup(symbol, tf, strats)
          .then(() => this.saveState())
          .catch(e => this.journal({ type: "stream_tick_error", symbol, tf, message: (e as Error).message }));
      });
    }));
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

const EIGHT_H = 8 * 3_600_000; // Binance funding interval

async function fetchFundingRates(symbol: string, startTime: number, endTime: number): Promise<number[]> {
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fundingRate HTTP ${res.status}`);
  const rows = (await res.json()) as { fundingRate: string }[];
  return rows.map(r => Number(r.fundingRate));
}

function tfToMs(tf: string): number {
  const unit = tf.slice(-1);
  const n = Number(tf.slice(0, -1));
  const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
  return n * mult;
}
