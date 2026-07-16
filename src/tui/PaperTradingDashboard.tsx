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

function fmtMoney(n: number): string {
  const s = n.toFixed(2);
  return n >= 0 ? `+$${s}` : `-$${Math.abs(n).toFixed(2)}`;
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

export function PaperTradingDashboard({ runner, pollMs, journalFile }: { runner: LivePaperRunner; pollMs: number; journalFile: string }): JSX.Element {
  const { exit } = useApp();
  const [rows, setRows] = useState<RowStatus[]>(runner.getStatus() as RowStatus[]);
  const [feed, setFeed] = useState<FeedEvent[]>(readLastJournalEvents(journalFile, 8));
  const [lastEval, setLastEval] = useState<EvalResult[]>([]);
  const [lastTick, setLastTick] = useState<Date | null>(null);
  const [nextTickIn, setNextTickIn] = useState(pollMs / 1000);
  const [ticking, setTicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live WS price feed — DISPLAY ONLY. Entries/exits still only ever
  // evaluate on closed candles inside runner.tick(), identical to the
  // backtest engine. This never influences a trading decision — it exists
  // purely so the dashboard shows a moving current price and mark-to-market
  // unrealized PnL between candle closes, instead of looking frozen for
  // up to `pollMs`.
  const streamRef = useRef<BinanceStreamManager | null>(null);
  const [livePrices, setLivePrices] = useState<Record<string, { price: number; time: number }>>({});
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
          if (tick) next[sym] = { price: tick.price, time: tick.time };
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

  // useInput requires raw-mode stdin (a real TTY) — skip wiring it when run
  // detached (nohup/systemd/CI); SIGINT/SIGTERM still exit cleanly in that case.
  if (process.stdin.isTTY) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useInput((input, key) => {
      if (input === "q" || key.escape || (key.ctrl && input === "c")) {
        runner.stop();
        streamRef.current?.stop?.();
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
  const openCount = rows.filter(r => r.openPosition).length;
  const firedThisTick = lastEval.filter(e => e.fired);

  const bySymbol = new Map<string, RowStatus[]>();
  for (const r of rows) {
    const arr = bySymbol.get(r.symbol);
    if (arr) arr.push(r); else bySymbol.set(r.symbol, [r]);
  }

  const idW = Math.max(...rows.map(r => r.id.length), 24) + 1;
  const wsColor = (s: string) => s === "live" ? "green" : s === "connecting" ? "yellow" : s === "stale" ? "yellow" : "red";
  const wsSymbol = (s: string) => s === "live" ? "●" : s === "connecting" ? "◐" : s === "stale" ? "◑" : "✕";

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold color="cyan">Autonomous Paper Trading</Text>
        <Text color="gray">  {rows.length} strategies · poll {pollMs / 1000}s</Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          {Object.entries(livePrices).map(([sym, p], i) => (
            <Text key={sym}>
              {i > 0 && "  "}
              <Text color={wsColor(wsStatus[sym] ?? "connecting")}>{wsSymbol(wsStatus[sym] ?? "connecting")}</Text>
              {" "}{sym.replace("USDT", "")} <Text bold>${p.price.toFixed(4)}</Text>
            </Text>
          ))}
          {Object.keys(livePrices).length === 0 && <Text color="gray">connecting to live price feed...</Text>}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>
          Realized: <Text bold color={pnlColor(totalRealized)}>{fmtMoney(totalRealized)}</Text>
          {"  "}Unrealized: <Text bold color={pnlColor(totalUnrealized)}>{fmtMoney(totalUnrealized)}</Text>
          {"  "}Trades: <Text bold>{totalTrades}</Text>
          {totalTrades > 0 && <Text color="gray"> ({((totalWins / totalTrades) * 100).toFixed(0)}% WR)</Text>}
          {"  "}Open: <Text bold color={openCount > 0 ? "yellow" : "gray"}>{openCount}</Text>
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="gray">
          {ticking ? "checking strategies..." : lastTick ? `last check ${lastTick.toLocaleTimeString()} (${lastEval.length} strategies evaluated${firedThisTick.length > 0 ? `, ${firedThisTick.length} fired` : ""}), next in ${nextTickIn}s` : "starting..."}
        </Text>
      </Box>
      {error && <Box marginBottom={1}><Text color="red">Last tick error: {error}</Text></Box>}

      {[...bySymbol.entries()].map(([symbol, symRows]) => {
        const symPnl = symRows.reduce((s, r) => s + r.pnl + (unrealized(r) ?? 0), 0);
        return (
          <Box key={symbol} flexDirection="column" marginBottom={1}>
            <Text bold underline color="magenta">{symbol}  <Text color={pnlColor(symPnl)}>{fmtMoney(symPnl)}</Text></Text>
            {symRows.map(r => {
              const u = unrealized(r);
              return (
                <Box key={r.id}>
                  <Text>
                    {"  "}
                    <Text color={r.direction === "short" ? "red" : "green"}>{r.direction === "short" ? "▼" : "▲"}</Text>
                    {" "}
                    {r.id.padEnd(idW)}
                    <Text color="gray">{r.tf.padStart(3).padEnd(4)}</Text>
                    <Text color={pnlColor(r.pnl)}>{fmtMoney(r.pnl).padStart(10)}</Text>
                    {"  "}
                    <Text color="gray">{String(r.trades).padStart(3)} tr</Text>
                    {r.winRate !== null && <Text color="gray"> {(r.winRate * 100).toFixed(0)}%WR</Text>}
                    {r.openPosition && (
                      <Text color="yellow">
                        {" ● OPEN @ "}{r.openPosition.entryPrice.toFixed(4)}
                        {u !== null && <Text color={pnlColor(u)}> ({fmtMoney(u)} unrealized)</Text>}
                      </Text>
                    )}
                  </Text>
                </Box>
              );
            })}
          </Box>
        );
      })}

      {feed.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="cyan">Recent fills</Text>
          {feed.map((e, i) => (
            <Box key={i}>
              <Text color="gray">
                {"  "}{new Date(e.ts).toLocaleTimeString()}{"  "}
                {e.type === "entry" && <Text color="yellow">ENTRY {e.strategyId} @ {e.entryPrice?.toFixed(4)}</Text>}
                {e.type === "exit" && <Text color={pnlColor(e.pnl ?? 0)}>EXIT {e.strategyId} ({e.reason}) {fmtMoney(e.pnl ?? 0)}</Text>}
                {e.type === "fetch_error" && <Text color="red">FETCH ERROR {e.symbol}: {e.message}</Text>}
                {e.type === "tick_error" && <Text color="red">TICK ERROR: {e.message}</Text>}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      <Text color="gray" dimColor>
        {"● live WS  ◐ connecting  ◑ stale  ✕ error"}  ·  Press q or Ctrl+C to stop (state saved every tick).
      </Text>
    </Box>
  );
}
