import React, { useEffect, useState, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { readFileSync, existsSync } from "fs";
import { LivePaperRunner } from "../paper-trading/live-runner.js";
import { BinanceStreamManager } from "../exchange/binance-stream.js";
import { TradeAnalyst } from "../paper-trading/trade-analyst.js";
import { ReadinessMonitor, StrategyReadiness, PortfolioReadiness } from "../paper-trading/readiness.js";
import { FillNotifier } from "../paper-trading/notifier.js";

interface RowStatus {
  id: string; symbol: string; tf: string; direction: "long" | "short";
  capital: number; pnl: number; trades: number; wins: number; losses: number;
  winRate: number | null;
  openPosition: { entryPrice: number; entryTime: string; qty: number; notional: number; stopPrice: number; targetPrice: number } | null;
}

interface FeedEvent { ts: string; type: string; strategyId?: string; symbol?: string; reason?: string; pnl?: number; entryPrice?: number; message?: string; }
interface EvalResult { strategyId: string; symbol: string; tf: string; checked: boolean; fired: boolean; lastClosedCandleTime: number }

const UP = "▲", DOWN = "▼";
const BULLET = { live: "●", connecting: "◐", stale: "◑", error: "✕" } as const;

function fmtMoney(n: number): string {
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}
function pnlColor(n: number): string {
  return n > 0 ? "green" : n < 0 ? "red" : "gray";
}
function readLastJournalEvents(journalFile: string, n: number): FeedEvent[] {
  if (!existsSync(journalFile)) return [];
  try {
    const lines = readFileSync(journalFile, "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).reverse().map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

function Panel({ title, borderColor, children }: { title: string; borderColor: string; children: React.ReactNode }): JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginBottom={1}>
      <Box marginTop={-1}>
        <Text> <Text bold color={borderColor}>{title}</Text> </Text>
      </Box>
      {children}
    </Box>
  );
}

// Fixed-width grid column — guarantees a real gutter between cells
// regardless of content length, unlike string padStart/padEnd concatenation
// (which silently loses its gap the moment content reaches the column
// width). Every table in this dashboard is built from these.
function Col({ width, align = "left", color, bold, children }: {
  width: number; align?: "left" | "right"; color?: string; bold?: boolean; children: React.ReactNode;
}): JSX.Element {
  return (
    <Box width={width} marginRight={2} justifyContent={align === "right" ? "flex-end" : "flex-start"}>
      <Text color={color} bold={bold} wrap="truncate">{children}</Text>
    </Box>
  );
}

export function PaperTradingDashboard({ runner, pollMs, journalFile, analyst, readiness, fillNotifier, onExit }: {
  runner: LivePaperRunner; pollMs: number; journalFile: string;
  analyst?: TradeAnalyst | null; readiness?: ReadinessMonitor | null; fillNotifier?: FillNotifier | null;
  onExit?: () => void;
}): JSX.Element {
  const { exit } = useApp();
  const [analystSummary, setAnalystSummary] = useState(analyst?.getLatestSummary() ?? null);
  const [readinessResult, setReadinessResult] = useState<{ strategies: StrategyReadiness[]; portfolio: PortfolioReadiness } | null>(null);
  const [rows, setRows] = useState<RowStatus[]>(runner.getStatus() as RowStatus[]);
  const [feed, setFeed] = useState<FeedEvent[]>(readLastJournalEvents(journalFile, 8));
  const [lastEval, setLastEval] = useState<EvalResult[]>([]);
  const [lastTick, setLastTick] = useState<Date | null>(null);
  const [nextTickIn, setNextTickIn] = useState(pollMs / 1000);
  const [ticking, setTicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(new Date());

  // Live WS price feed — DISPLAY ONLY. Entries/exits still only ever
  // evaluate on closed candles inside runner.tick(), identical to the
  // backtest engine. This never influences a trading decision — it exists
  // purely so the dashboard shows a moving current price and mark-to-market
  // unrealized PnL between candle closes, instead of looking frozen for
  // up to `pollMs`.
  const streamRef = useRef<BinanceStreamManager | null>(null);
  const [livePrices, setLivePrices] = useState<Record<string, { price: number; time: number; changePct24h?: number }>>({});
  const [wsStatus, setWsStatus] = useState<Record<string, "connecting" | "live" | "stale" | "error">>({});

  useEffect(() => {
    const stream = new BinanceStreamManager();
    streamRef.current = stream;
    const symbols = runner.getSymbols();
    const initial: Record<string, "connecting" | "live" | "stale" | "error"> = {};
    for (const sym of symbols) initial[sym] = "connecting";
    setWsStatus(initial);
    for (const sym of symbols) {
      stream.subscribe(sym)
        .then(() => setWsStatus(s => ({ ...s, [sym]: "live" })))
        .catch(() => setWsStatus(s => ({ ...s, [sym]: "error" })));
    }
    return () => {
      for (const sym of symbols) stream.unsubscribe(sym);
    };
  }, [runner]);

  // Single 1s heartbeat driving every per-second concern (clock, countdown,
  // WS price poll) — was 3 separate setInterval callbacks each calling
  // setState independently, which Ink/React would render as 2-3 separate
  // full-terminal repaints per second (visible flicker). One interval means
  // one batched render per second. Also skips setState entirely when a
  // symbol's price/status hasn't actually changed, so the diff Ink repaints
  // stays as small as possible even on the one render/sec that does happen.
  useEffect(() => {
    const t = setInterval(() => {
      setClock(new Date());
      setNextTickIn(s => (s > 0 ? s - 1 : 0));

      const stream = streamRef.current;
      const symbols = runner.getSymbols();
      if (!stream) return;

      setLivePrices(prev => {
        let changed = false;
        const next = { ...prev };
        for (const sym of symbols) {
          const tick = stream.getLatest(sym);
          if (tick && (prev[sym]?.price !== tick.price || prev[sym]?.time !== tick.time)) {
            next[sym] = { price: tick.price, time: tick.time, changePct24h: tick.changePct24h };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setWsStatus(prev => {
        let changed = false;
        const next = { ...prev };
        for (const sym of symbols) {
          if (next[sym] === "error") continue;
          const tick = stream.getLatest(sym);
          const computed = tick && Date.now() - tick.time < 15_000 ? "live" : next[sym] === "connecting" ? "connecting" : "stale";
          if (computed !== prev[sym]) { next[sym] = computed; changed = true; }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [runner]);

  // Deterministic readiness gate (not LLM-judged, see readiness.ts) — run
  // once on mount so the panel isn't blank until the first new fill.
  useEffect(() => {
    if (!readiness) return;
    let cancelled = false;
    readiness.check().then(rr => { if (!cancelled) setReadinessResult({ strategies: rr.strategies, portfolio: rr.portfolio }); });
    return () => { cancelled = true; };
  }, [readiness]);

  // Read-only LLM analyst — checks its own schedule (min trade count + min
  // interval, see trade-analyst.ts) and only calls the model when due. This
  // never touches runner/trading state; it only reads the journal file and
  // appends to its own log. analystRunning just drives a spinner in the UI.
  useEffect(() => {
    if (!analyst) return;
    let stopped = false;
    void analyst.start(5 * 60 * 1000, (ran) => {
      if (stopped || !ran) return;
      setAnalystSummary(analyst.getLatestSummary());
    });
    return () => { stopped = true; analyst.stop(); };
  }, [analyst]);

  if (process.stdin.isTTY) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useInput((input, key) => {
      if (input === "q" || key.escape || (key.ctrl && input === "c")) {
        runner.stop();
        exit();
        if (onExit) onExit(); else process.exit(0);
      }
    });
  }

  useEffect(() => {
    let stopped = false;
    async function loop() {
      while (!stopped) {
        setTicking(true);
        try {
          const result = await runner.tick();
          setRows(runner.getStatus() as RowStatus[]);
          setLastEval(result.evaluations);
          setLastTick(new Date());
          setError(null);
          if (result.fills > 0) {
            setFeed(readLastJournalEvents(journalFile, 8));
            void fillNotifier?.checkAndNotify();
            if (readiness) {
              const rr = await readiness.check();
              setReadinessResult({ strategies: rr.strategies, portfolio: rr.portfolio });
            }
          }
        } catch (e) {
          setError((e as Error).message);
        }
        setTicking(false);
        setNextTickIn(pollMs / 1000);
        if (stopped) break;
        await new Promise(r => setTimeout(r, pollMs));
      }
    }
    void loop();
    return () => { stopped = true; };
  }, [runner, pollMs]);

  const unrealized = (r: RowStatus): number | null => {
    if (!r.openPosition) return null;
    const live = livePrices[r.symbol];
    if (!live) return null;
    return runner.unrealizedPnl(r.id, live.price);
  };

  const portfolio = runner.getPortfolio();
  const totalRealized = rows.reduce((s, r) => s + r.pnl, 0);
  const totalUnrealized = rows.reduce((s, r) => s + (unrealized(r) ?? 0), 0);
  const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
  const totalWins = rows.reduce((s, r) => s + r.wins, 0);
  const openPositions = rows.filter(r => r.openPosition);
  const firedThisTick = lastEval.filter(e => e.fired);
  const anyStale = Object.values(wsStatus).some(s => s !== "live");

  const bySymbol = new Map<string, RowStatus[]>();
  for (const r of rows) {
    const arr = bySymbol.get(r.symbol);
    if (arr) arr.push(r); else bySymbol.set(r.symbol, [r]);
  }
  const idW = Math.max(...rows.map(r => r.id.length), 24) + 1;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header bar */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text>
          <Text bold color="cyan">◆ PAPER TRADING TERMINAL</Text>
          <Text color="gray">  {rows.length} strategies · 3 symbols · {pollMs / 1000}s poll</Text>
        </Text>
        <Text color="gray">{clock.toLocaleTimeString()}</Text>
      </Box>

      {/* Price ticker strip */}
      <Box marginBottom={1}>
        {runner.getSymbols().map(sym => {
          const p = livePrices[sym];
          const st = wsStatus[sym] ?? "connecting";
          const chg = p?.changePct24h;
          return (
            <Box key={sym} borderStyle="single" borderColor={st === "live" ? "green" : st === "error" ? "red" : "yellow"} paddingX={1} marginRight={1}>
              <Text>
                <Text color={st === "live" ? "green" : st === "error" ? "red" : "yellow"}>{BULLET[st]}</Text>
                {" "}<Text bold>{sym.replace("USDT", "")}</Text>
                {"  "}<Text bold color="white">{p ? p.price.toFixed(4) : "-.----"}</Text>
                {chg !== undefined && !Number.isNaN(chg) && (
                  <Text color={chg >= 0 ? "green" : "red"}>{"  "}{chg >= 0 ? "▲" : "▼"}{Math.abs(chg).toFixed(2)}%</Text>
                )}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Readiness gate — deterministic (not LLM-judged), see readiness.ts.
          Only strategies/pool clearing minTrades + PF + WR-vs-backtest bar. */}
      {readinessResult && (readinessResult.portfolio.ready || readinessResult.strategies.some(s => s.ready)) && (
        <Box borderStyle="double" borderColor="green" paddingX={1} marginBottom={1}>
          <Text bold color="green">
            🟢 {readinessResult.portfolio.ready ? "PORTFOLIO READY FOR LIVE" : "READY FOR LIVE"}: {" "}
            {readinessResult.portfolio.ready
              ? `${readinessResult.portfolio.readyCount}/${readinessResult.portfolio.evaluableCount} evaluable strategies passing`
              : readinessResult.strategies.filter(s => s.ready).map(s => s.strategyId).join(", ")}
            <Text color="gray"> (at current {runner.getPortfolio().leverage}x / {(runner.getPortfolio().marginPerTradePct*100).toFixed(0)}% sizing only)</Text>
          </Text>
        </Box>
      )}

      {/* Portfolio — broker-style account balance rollup across all strategy buckets */}
      <Panel title="PORTFOLIO" borderColor="blueBright">
        <Box>
          <Text>
            Total Equity <Text bold color={pnlColor(totalRealized + totalUnrealized)}>${(portfolio.totalInitialCapital + totalRealized + totalUnrealized).toFixed(2)}</Text>
            {"   "}Available <Text bold>${portfolio.availableBalance.toFixed(2)}</Text>
            {"   "}Used Margin <Text bold color={portfolio.usedMargin > 0 ? "yellow" : "gray"}>${portfolio.usedMargin.toFixed(2)}</Text>
            {"   "}Margin Util <Text bold>{((portfolio.usedMargin / portfolio.totalInitialCapital) * 100).toFixed(1)}%</Text>
          </Text>
        </Box>
        <Box>
          <Text color="gray">
            Starting Capital ${portfolio.totalInitialCapital.toLocaleString()} ({portfolio.strategyCount} × $10,000 isolated buckets)
            {"   "}Leverage {portfolio.leverage}x{"  "}Margin/Trade {(portfolio.marginPerTradePct * 100).toFixed(0)}%
            {"   "}Open {portfolio.openPositions}/{portfolio.strategyCount}
          </Text>
        </Box>
      </Panel>

      {/* Account P&L summary */}
      <Panel title="ACCOUNT" borderColor="blueBright">
        <Box>
          <Text>
            Realized <Text bold color={pnlColor(totalRealized)}>{fmtMoney(totalRealized)}</Text>
            {"   "}Unrealized <Text bold color={pnlColor(totalUnrealized)}>{fmtMoney(totalUnrealized)}</Text>
            {"   "}Equity Δ <Text bold color={pnlColor(totalRealized + totalUnrealized)}>{fmtMoney(totalRealized + totalUnrealized)}</Text>
            {"   "}Trades <Text bold>{totalTrades}</Text>
            {totalTrades > 0 && <Text color="gray"> ({((totalWins / totalTrades) * 100).toFixed(0)}%WR)</Text>}
          </Text>
        </Box>
        <Box>
          <Text color="gray">
            {ticking ? "⟳ checking strategies..." : lastTick ? `⟳ last check ${lastTick.toLocaleTimeString()} · ${lastEval.length} evaluated${firedThisTick.length > 0 ? `, ${firedThisTick.length} fired` : ""} · next in ${nextTickIn}s` : "starting..."}
            {anyStale && <Text color="yellow">  ⚠ price feed degraded</Text>}
          </Text>
        </Box>
        {error && <Text color="red">⚠ tick error: {error}</Text>}
      </Panel>

      {/* Open positions blotter */}
      {openPositions.length > 0 && (
        <Panel title={`OPEN POSITIONS (${openPositions.length})`} borderColor="yellow">
          <Box>
            <Col width={9} color="gray">SIDE</Col>
            <Col width={idW} color="gray">STRATEGY</Col>
            <Col width={5} color="gray">SYM</Col>
            <Col width={10} align="right" color="gray">ENTRY</Col>
            <Col width={10} align="right" color="gray">CURRENT</Col>
            <Col width={10} align="right" color="gray">UNREAL</Col>
            <Col width={10} align="right" color="gray">SINCE</Col>
          </Box>
          {openPositions.map(r => {
            const live = livePrices[r.symbol];
            const u = unrealized(r);
            const since = r.openPosition ? new Date(r.openPosition.entryTime) : null;
            return (
              <Box key={r.id}>
                <Col width={9} color={r.direction === "short" ? "red" : "green"}>
                  {r.direction === "short" ? `${DOWN} SHORT` : `${UP} LONG`}
                </Col>
                <Col width={idW}>{r.id}</Col>
                <Col width={5}>{r.symbol.replace("USDT", "")}</Col>
                <Col width={10} align="right" color="gray">{r.openPosition?.entryPrice.toFixed(4) ?? "-"}</Col>
                <Col width={10} align="right" bold>{live ? live.price.toFixed(4) : "-"}</Col>
                <Col width={10} align="right" color={pnlColor(u ?? 0)} bold>{u !== null ? fmtMoney(u) : "-"}</Col>
                <Col width={10} align="right" color="gray">{since ? since.toLocaleTimeString() : "-"}</Col>
              </Box>
            );
          })}
        </Panel>
      )}

      {/* Strategy performance — one merged table (not one panel per symbol,
          which burns 2 border lines + a title line per symbol for no
          information gain). Idle strategies (no position, never traded)
          collapse to a single summary line per symbol so the panel height
          tracks actual activity instead of always rendering all 17 rows —
          on a real terminal height, 17 mostly-empty rows push the header
          off the top of the visible viewport (this is a real report from
          testing: content taller than the terminal scrolls the top out of
          view, same as any TUI without pagination). */}
      <Panel title={`STRATEGIES (${rows.length})`} borderColor="magenta">
        {[...bySymbol.entries()].map(([symbol, symRows]) => {
          const symPnl = symRows.reduce((s, r) => s + r.pnl + (unrealized(r) ?? 0), 0);
          const active = symRows.filter(r => r.openPosition || r.trades > 0);
          const idle = symRows.filter(r => !r.openPosition && r.trades === 0);
          return (
            <Box key={symbol} flexDirection="column" marginBottom={1}>
              <Text bold color="cyan">{symbol}  <Text color={pnlColor(symPnl)}>{fmtMoney(symPnl)}</Text></Text>
              {active.map(r => (
                <Box key={r.id}>
                  <Col width={2} color={r.direction === "short" ? "red" : "green"}>{r.direction === "short" ? DOWN : UP}</Col>
                  <Col width={idW}>{r.id}</Col>
                  <Col width={4} color="gray">{r.tf}</Col>
                  <Col width={11} align="right" color={pnlColor(r.pnl)}>{fmtMoney(r.pnl)}</Col>
                  <Col width={7} color="gray">{`${r.trades} tr`}</Col>
                  <Col width={6} color="gray">{r.winRate !== null ? `${(r.winRate * 100).toFixed(0)}%WR` : ""}</Col>
                  <Col width={8} color="yellow">{r.openPosition ? `${BULLET.live} OPEN` : ""}</Col>
                </Box>
              ))}
              {idle.length > 0 && (
                <Text color="gray" dimColor wrap="truncate-end">
                  {"  "}{idle.length} idle (no signal yet): {idle.map(r => r.id).join(", ")}
                </Text>
              )}
            </Box>
          );
        })}
      </Panel>

      {/* Activity feed */}
      {feed.length > 0 && (
        <Panel title="RECENT FILLS" borderColor="cyan">
          {feed.map((e, i) => (
            <Box key={i}>
              <Text color="gray">
                {new Date(e.ts).toLocaleTimeString()}{"  "}
                {e.type === "entry" && <Text color="yellow">ENTRY {e.strategyId} @ {e.entryPrice?.toFixed(4)}</Text>}
                {e.type === "exit" && <Text color={pnlColor(e.pnl ?? 0)}>EXIT {e.strategyId} ({e.reason}) {fmtMoney(e.pnl ?? 0)}</Text>}
                {e.type === "fetch_error" && <Text color="red">FETCH ERROR {e.symbol}: {e.message}</Text>}
                {e.type === "tick_error" && <Text color="red">TICK ERROR: {e.message}</Text>}
              </Text>
            </Box>
          ))}
        </Panel>
      )}

      {/* Read-only LLM analyst — reviews accumulated trade history on its own
          schedule (see trade-analyst.ts), never places or modifies trades */}
      {analyst && (
        <Panel title="AI ANALYST (read-only, no trade access)" borderColor="green">
          {analystSummary ? (
            <>
              <Text color="gray">Last analysis: {new Date(analystSummary.ts).toLocaleString()} · {analystSummary.tradesAnalyzed} trades reviewed</Text>
              <Text wrap="wrap">{analystSummary.summary}</Text>
            </>
          ) : (
            <Text color="gray">Waiting for enough closed trades to run first analysis (see .trading-agent/paper-trading-insights.md for full history)</Text>
          )}
        </Panel>
      )}

      <Text color="gray" dimColor>
        {BULLET.live} live  {BULLET.connecting} connecting  {BULLET.stale} stale  {BULLET.error} error   ·   q / Ctrl+C to stop (state saved every tick)
      </Text>
    </Box>
  );
}
