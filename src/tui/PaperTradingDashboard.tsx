import React, { useEffect, useState, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { readFileSync, existsSync } from "fs";
import { LivePaperRunner } from "../paper-trading/live-runner.js";
import { BinanceStreamManager } from "../exchange/binance-stream.js";

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

export function PaperTradingDashboard({ runner, pollMs, journalFile }: { runner: LivePaperRunner; pollMs: number; journalFile: string }): JSX.Element {
  const { exit } = useApp();
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
    const priceInterval = setInterval(() => {
      setLivePrices(prev => {
        const next = { ...prev };
        for (const sym of symbols) {
          const tick = stream.getLatest(sym);
          if (tick) next[sym] = { price: tick.price, time: tick.time, changePct24h: tick.changePct24h };
        }
        return next;
      });
      setWsStatus(prev => {
        const next = { ...prev };
        for (const sym of symbols) {
          if (next[sym] === "error") continue;
          const tick = stream.getLatest(sym);
          next[sym] = tick && Date.now() - tick.time < 15_000 ? "live" : next[sym] === "connecting" ? "connecting" : "stale";
        }
        return next;
      });
    }, 1000);
    return () => {
      clearInterval(priceInterval);
      for (const sym of symbols) stream.unsubscribe(sym);
    };
  }, [runner]);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  if (process.stdin.isTTY) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useInput((input, key) => {
      if (input === "q" || key.escape || (key.ctrl && input === "c")) {
        runner.stop();
        exit();
        process.exit(0);
      }
    });
  }

  useEffect(() => {
    let stopped = false;
    let countdown: ReturnType<typeof setInterval>;
    async function loop() {
      while (!stopped) {
        setTicking(true);
        try {
          const result = await runner.tick();
          setRows(runner.getStatus() as RowStatus[]);
          setLastEval(result.evaluations);
          setLastTick(new Date());
          setError(null);
          if (result.fills > 0) setFeed(readLastJournalEvents(journalFile, 8));
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
    countdown = setInterval(() => setNextTickIn(s => (s > 0 ? s - 1 : 0)), 1000);
    return () => { stopped = true; clearInterval(countdown); };
  }, [runner, pollMs]);

  const unrealized = (r: RowStatus): number | null => {
    if (!r.openPosition) return null;
    const live = livePrices[r.symbol];
    if (!live) return null;
    return runner.unrealizedPnl(r.id, live.price);
  };

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

      {/* Account summary */}
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
            <Text color="gray">
              {"SIDE".padEnd(7)}{"STRATEGY".padEnd(idW)}{"SYM".padEnd(4)}{"ENTRY".padStart(8)}{"CURRENT".padStart(9)}{"UNREAL".padStart(9)}{"SINCE".padStart(8)}
            </Text>
          </Box>
          {openPositions.map(r => {
            const live = livePrices[r.symbol];
            const u = unrealized(r);
            const since = r.openPosition ? new Date(r.openPosition.entryTime) : null;
            return (
              <Box key={r.id}>
                <Text>
                  <Text color={r.direction === "short" ? "red" : "green"}>{(r.direction === "short" ? DOWN + " SHORT" : UP + " LONG ").padEnd(7)}</Text>
                  {r.id.padEnd(idW)}
                  {r.symbol.replace("USDT", "").padEnd(4)}
                  <Text color="gray">{(r.openPosition?.entryPrice.toFixed(4) ?? "-").padStart(8)}</Text>
                  <Text bold>{(live ? live.price.toFixed(4) : "-").padStart(9)}</Text>
                  <Text bold color={pnlColor(u ?? 0)}>{(u !== null ? fmtMoney(u) : "-").padStart(9)}</Text>
                  <Text color="gray">{(since ? since.toLocaleTimeString() : "-").padStart(8)}</Text>
                </Text>
              </Box>
            );
          })}
        </Panel>
      )}

      {/* Per-symbol strategy performance */}
      {[...bySymbol.entries()].map(([symbol, symRows]) => {
        const symPnl = symRows.reduce((s, r) => s + r.pnl + (unrealized(r) ?? 0), 0);
        return (
          <Panel key={symbol} title={`${symbol}  ${fmtMoney(symPnl)}`} borderColor="magenta">
            {symRows.map(r => (
              <Box key={r.id}>
                <Text>
                  <Text color={r.direction === "short" ? "red" : "green"}>{r.direction === "short" ? DOWN : UP}</Text>
                  {" "}
                  {r.id.padEnd(idW)}
                  <Text color="gray">{r.tf.padStart(3).padEnd(4)}</Text>
                  <Text color={pnlColor(r.pnl)}>{fmtMoney(r.pnl).padStart(10)}</Text>
                  {"  "}
                  <Text color="gray">{String(r.trades).padStart(3)} tr</Text>
                  {r.winRate !== null && <Text color="gray"> {(r.winRate * 100).toFixed(0)}%WR</Text>}
                  {r.openPosition && <Text color="yellow"> {BULLET.live} OPEN</Text>}
                </Text>
              </Box>
            ))}
          </Panel>
        );
      })}

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

      <Text color="gray" dimColor>
        {BULLET.live} live  {BULLET.connecting} connecting  {BULLET.stale} stale  {BULLET.error} error   ·   q / Ctrl+C to stop (state saved every tick)
      </Text>
    </Box>
  );
}
