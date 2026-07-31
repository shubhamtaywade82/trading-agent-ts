import { readFileSync, existsSync } from "node:fs";

import { Box, Text, useApp, useInput, useStdout } from "ink";
import React, { useEffect, useState, useRef } from "react";

import { BinanceStreamManager } from "../exchange/binance-stream.js";
import type { LivePaperRunner } from "../paper-trading/live-runner.js";
import type { FillNotifier } from "../paper-trading/notifier.js";
import type { ReadinessMonitor, StrategyReadiness, PortfolioReadiness } from "../paper-trading/readiness.js";
import type { SymbolPosition } from "../paper-trading/symbol-position.js";
import type { TradeAnalyst } from "../paper-trading/trade-analyst.js";
import type { TradeEvaluator, TradeEvaluation } from "../paper-trading/trade-evaluator.js";

interface RowStatus {
  id: string; symbol: string; tf: string; direction: "long" | "short";
  attributedPnl: number; trades: number; wins: number; losses: number;
  winRate: number | null; mode?: string; note?: string;
}

interface FeedEvent {
  ts: string; type: string; strategyId?: string; symbol?: string; tf?: string;
  action?: string; direction?: "long" | "short"; reason?: string; price?: number;
  qty?: number; realizedPnl?: number; message?: string; approved?: boolean; rationale?: string;
}

interface RiskLadderOpts {
  dir: "long" | "short";
  now: number;
  tp: number | null;
  sl: number | null;
  liq: number | null;
}

const BULLET = { live: "●", connecting: "◐", stale: "◑", error: "✕" } as const;

function fmtMoney(n: number): string {
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

function pnlColor(n: number): string {
  return n > 0 ? "green" : n < 0 ? "red" : "gray";
}

function renderSparkline(prices: number[]): string {
  if (prices.length === 0) return "─";
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const chars = ["▂", "▃", "▅", "▆", "█", "▁"];
  if (min === max) return "▅".repeat(prices.length);
  return prices
    .map((p) => {
      const idx = Math.min(chars.length - 1, Math.floor(((p - min) / (max - min || 1)) * chars.length));
      return chars[idx] ?? "▅";
    })
    .join("");
}

function renderProgressBar(pct: number, width = 20): string {
  const filled = Math.min(width, Math.max(0, Math.round((Math.abs(pct) / 100) * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

function renderRiskLadder(opts: RiskLadderOpts): string {
  const { dir, now, tp, sl, liq } = opts;
  if (!tp || !sl) return "┃─●─┃─✕";
  const minP = dir === "short" ? tp : (liq ?? sl * 0.9);
  const maxP = dir === "short" ? (liq ?? sl * 1.1) : tp;
  const range = maxP - minP;
  if (range <= 0) return "┃─●─┃─✕";
  const rel = Math.min(1, Math.max(0, (now - minP) / range));
  if (rel < 0.33) return "┃●──┃─✕";
  if (rel < 0.66) return "┃─●─┃─✕";
  return "┃──●┃─✕";
}

function renderAttributedBar(pnl: number): string {
  if (pnl === 0) return "·│·";
  if (pnl > 0) return pnl > 100 ? "·│██·" : "·│█·";
  return pnl < -100 ? "·██│·" : "·█│·";
}

function readLastJournalEvents(journalFile: string, n: number): FeedEvent[] {
  if (!existsSync(journalFile)) return [];
  try {
    const lines = readFileSync(journalFile, "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function formatCompactSummary(summary: string, maxLines: number, maxChars = 1000): string {
  const rawLines = summary.trim().split("\n");
  const nonEmptyLines = rawLines.filter((l) => l.trim().length > 0);
  if (nonEmptyLines.length === 0) return "";
  const sliced = nonEmptyLines.slice(0, maxLines);
  let text = sliced.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars - 3) + "...";
  if (nonEmptyLines.length > maxLines || summary.length > maxChars) {
    return `${text}\n... (see .trading-agent/paper-trading-insights.md)`;
  }
  return text;
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

function Col({ width, align = "left", color, bold, children }: {
  width: number; align?: "left" | "right"; color?: string; bold?: boolean; children?: React.ReactNode;
}): JSX.Element {
  return (
    <Box width={width} marginRight={2} justifyContent={align === "right" ? "flex-end" : "flex-start"}>
      <Text wrap="truncate" {...(color !== undefined && { color })} {...(bold !== undefined && { bold })}>{children ?? ""}</Text>
    </Box>
  );
}

function Separator({ width }: { width: number }): JSX.Element {
  return (
    <Box marginBottom={1}>
      <Text color="gray">{"─".repeat(Math.max(10, width))}</Text>
    </Box>
  );
}

function MarketsPanel({ symbols, livePrices, wsStatus, priceHistory }: {
  symbols: string[];
  livePrices: Record<string, { price: number; time: number; changePct24h?: number }>;
  wsStatus: Record<string, "connecting" | "live" | "stale" | "error">;
  priceHistory: Record<string, number[]>;
}): JSX.Element {
  return (
    <Panel title={`MARKETS · dot = feed health`} borderColor="cyan">
      <Box flexDirection="row" flexWrap="wrap">
        {symbols.map((sym) => {
          const p = livePrices[sym];
          const st = wsStatus[sym] ?? "connecting";
          const chg = p?.changePct24h;
          const prices = priceHistory[sym] ?? (p ? [p.price] : []);
          const priceStr = p ? (p.price >= 1000 ? p.price.toFixed(2) : p.price.toFixed(4)) : "-.----";
          return (
            <Box key={sym} marginRight={3}>
              <Text>
                <Text color={st === "live" ? "green" : st === "error" ? "red" : "yellow"}>{BULLET[st]}</Text>
                {" "}<Text bold>{sym.replace("USDT", "")}</Text>
                {" "}<Text bold color="white">{priceStr}</Text>
                {" "}<Text color="cyan">{renderSparkline(prices)}</Text>
                {chg !== undefined && !Number.isNaN(chg) && (
                  <Text color={chg >= 0 ? "green" : "red"}>{" "}{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</Text>
                )}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}

function SessionTempoPanel({ scalps = 4, grad = 10, swings = 0, dirBrk = 79, scratch = 6, regime = "TRENDING", regimePct = 80 }: {
  scalps?: number; grad?: number; swings?: number; dirBrk?: number; scratch?: number; regime?: string; regimePct?: number;
}): JSX.Element {
  return (
    <Panel title="SESSION TEMPO · adaptive targets: Scalp 1-5% › Intra 10% › Swing 20%" borderColor="magenta">
      <Box flexDirection="row" justifyContent="space-between">
        <Text color="gray">
          <Text bold color="white">SCALPS (1-5%)</Text> {scalps}  <Text bold color="white">GRAD (10%)</Text> {grad}  <Text bold color="white">SWINGS (20%)</Text> {swings}  <Text bold color="white">DIR-BRK</Text> {dirBrk}  <Text bold color="white">SCRATCH</Text> {scratch}   │  regime: <Text bold color="cyan">{regime}</Text> <Text color="cyan">{renderProgressBar(regimePct, 16)}</Text>
        </Text>
      </Box>
    </Panel>
  );
}

function PortfolioAccountPanels({ portfolio, totalRealized, totalUnrealized, totalTrades, wins, losses, winRate, lastTick, nextTickIn, ticking, error, equityHistory, peakEquity, halfWidth }: {
  portfolio: { totalInitialCapital: number; availableBalance: number; usedMargin: number; leverage: number; openPositions: number; symbolCount: number };
  totalRealized: number; totalUnrealized: number; totalTrades: number; wins: number; losses: number;
  winRate: number; lastTick: Date | null; nextTickIn: number; ticking: boolean; error: string | null;
  equityHistory: number[]; peakEquity: number; halfWidth: number;
}): JSX.Element {
  const totalEquity = portfolio.totalInitialCapital + totalRealized + totalUnrealized;
  const avail = portfolio.availableBalance;
  const marginPct = totalEquity > 0 ? (portfolio.usedMargin / totalEquity) * 100 : 0;
  const ddPct = peakEquity > 0 ? ((totalEquity - peakEquity) / peakEquity) * 100 : 0;

  return (
    <Box flexDirection="row" marginBottom={1} justifyContent="space-between">
      <Box width={halfWidth}>
        <Panel title="PORTFOLIO" borderColor="cyan">
          <Box><Text>Total Equity <Text bold color={pnlColor(totalRealized + totalUnrealized)}>${totalEquity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>   Avail <Text bold>${avail.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text></Text></Box>
          <Box><Text color="gray">Margin <Text bold color={portfolio.usedMargin > 0 ? "yellow" : "gray"}>${portfolio.usedMargin.toFixed(0)}</Text> ({marginPct.toFixed(1)}%) Lev {portfolio.leverage}x  Open {portfolio.openPositions}/{portfolio.symbolCount}</Text></Box>
          <Box><Text color="cyan">{renderSparkline(equityHistory.length > 0 ? equityHistory : [totalEquity])}</Text></Box>
          <Box><Text color="gray">Drawdown {ddPct >= 0 ? "0.00%" : `${ddPct.toFixed(2)}%`}  <Text color="cyan">{renderProgressBar(ddPct, 20)}</Text></Text></Box>
        </Panel>
      </Box>
      <Box width={halfWidth}>
        <Panel title="ACCOUNT · session" borderColor="cyan">
          <Box><Text>Realized <Text bold color={pnlColor(totalRealized)}>{fmtMoney(totalRealized)}</Text>   Unreal <Text bold color={pnlColor(totalUnrealized)}>{fmtMoney(totalUnrealized)}</Text></Text></Box>
          <Box><Text color="gray">Mode mix <Text bold color="white">1S 0I 0W</Text>  Closed {totalTrades} W{wins} L{losses} WR {winRate}%</Text></Box>
          <Box><Text color="gray">{ticking ? "⟳ checking..." : lastTick ? `⟳ ${lastTick.toLocaleTimeString()} · ${totalTrades} eval · next ${nextTickIn}s` : "starting..."}</Text></Box>
          {error && <Text color="red">⚠ {error}</Text>}
        </Panel>
      </Box>
    </Box>
  );
}

function OpenPositionsPanel({ positions, livePrices, totalEquity, leverage, symbolCount, innerWidth }: {
  positions: SymbolPosition[]; livePrices: Record<string, { price: number }>; totalEquity: number; leverage: number; symbolCount: number; innerWidth: number;
}): JSX.Element {
  if (positions.length === 0) return <></>;
  return (
    <Panel title={`OPEN POSITIONS (${positions.length}) · ${positions.length}/${symbolCount} · lev ${leverage}x · SCALP (1-5%) › INTRA (10%) › SWING (20%)`} borderColor="yellow">
      <Box marginBottom={0}>
        <Col width={10} color="gray">SIDE/SYM</Col>
        <Col width={8} align="right" color="gray">QTY</Col>
        <Col width={7} align="right" color="gray">MGN%</Col>
        <Col width={9} align="right" color="gray">ENTRY</Col>
        <Col width={10} color="gray">MODE</Col>
        <Col width={12} align="right" color="gray">UNREAL</Col>
        <Col width={24} color="gray">CONTRIBUTOR</Col>
        <Box flexGrow={1} />
        <Col width={35} color="gray">LADDER: TP┃ ●now ┃stop sl0 ✕liq</Col>
      </Box>
      <Separator width={innerWidth} />
      {positions.map((p) => {
        const live = livePrices[p.symbol]?.price ?? p.avgEntryPrice;
        const u = (p.direction === "short" ? (p.avgEntryPrice - live) : (live - p.avgEntryPrice)) * p.qty;
        const uPct = p.margin > 0 ? (u / p.margin) * 100 : 0;
        const mgnPct = totalEquity > 0 ? (p.margin / totalEquity) * 100 : 0;
        const dSl = p.governingStopPrice && live > 0 ? (Math.abs(live - p.governingStopPrice) / live * 100).toFixed(1) : null;
        const fmtPrice = (num: number | null): string => {
          if (!num) return "-";
          return num >= 1000 ? num.toFixed(2) : num.toFixed(4);
        };
        return (
          <Box key={p.symbol} flexDirection="column" marginBottom={1}>
            <Box>
              <Col width={10} color={p.direction === "short" ? "red" : "green"}>{`${p.direction === "short" ? "▼ SH" : "▲ LG"}  ${p.symbol.replace("USDT", "")}/PERP`}</Col>
              <Col width={8} align="right">{p.qty.toFixed(2)}</Col>
              <Col width={7} align="right">{mgnPct.toFixed(1)}%</Col>
              <Col width={9} align="right">{fmtPrice(p.avgEntryPrice)}</Col>
              <Col width={10} color="cyan">[SCALP]</Col>
              <Col width={12} align="right" color={pnlColor(u)} bold>{`${fmtMoney(u)} (${uPct.toFixed(1)}%)`}</Col>
              <Col width={24} color="gray">{p.governingStrategyId ?? p.contributingStrategyIds[0] ?? "-"}</Col>
              <Box flexGrow={1} />
            </Box>
            <Box>
              <Text color="gray">
                {"  "}LADDER <Text color="yellow">{renderRiskLadder({ dir: p.direction ?? "long", now: live, tp: p.governingTargetPrice, sl: p.governingStopPrice, liq: p.liqPrice })}</Text>
                {"  "}TP {fmtPrice(p.governingTargetPrice)} ┃stop {fmtPrice(p.governingStopPrice)} ┊sl0 {fmtPrice(p.governingStopPrice)} ✕{fmtPrice(p.liqPrice)}{dSl ? ` d→stop ${dSl}%` : ""}
              </Text>
            </Box>
            <Box>
              <Text color="gray">
                {"  "}GATE [<Text color="green">dir ✓</Text>][<Text color="green">struct ✓</Text>][<Text color="green">pnl&gt;0 ✓</Text>][<Text color="red">bars≥3 ✗</Text>]   ⧗ <Text color="cyan">{renderProgressBar(60, 8)}</Text> 3m   trail -2.00%   SIS  ›
              </Text>
            </Box>
          </Box>
        );
      })}
    </Panel>
  );
}

function StrategiesPanel({ rows, activeContributorIds, innerWidth }: { rows: RowStatus[]; activeContributorIds: Set<string>; innerWidth: number }): JSX.Element {
  return (
    <Panel title={`STRATEGIES (${rows.length}) — state · signals · attributed PnL`} borderColor="magenta">
      <Box marginBottom={0}>
        <Col width={10} color="gray">STATE</Col>
        <Col width={36} color="gray">STRATEGY</Col>
        <Col width={8} align="right" color="gray">SIG</Col>
        <Col width={12} align="right" color="gray">PNL</Col>
        <Col width={14} color="gray">ATTRIBUTED</Col>
        <Box flexGrow={1} />
        <Col width={32} color="gray">MODE / NOTE</Col>
      </Box>
      <Separator width={innerWidth} />
      {rows.map((r) => {
        const isLive = activeContributorIds.has(r.id);
        const stateTag = isLive ? "[live]" : r.trades > 0 ? "[idle]" : "[armed]";
        const stateColor = isLive ? "green" : r.trades > 0 ? "gray" : "yellow";
        const modeNote = isLive
          ? "[SCALP 1-5%] INTRA · trailing"
          : stateTag === "[armed]"
          ? "1 bar confirm"
          : r.attributedPnl > 100
          ? "scalp-only day"
          : "graduated 1× hist";
        return (
          <Box key={r.id}>
            <Col width={10} color={stateColor}>{stateTag}</Col>
            <Col width={36}>{r.id}</Col>
            <Col width={8} align="right" color="gray">{r.trades}</Col>
            <Col width={12} align="right" color={pnlColor(r.attributedPnl)}>{fmtMoney(r.attributedPnl)}</Col>
            <Col width={14} color="cyan">{renderAttributedBar(r.attributedPnl)}</Col>
            <Box flexGrow={1} />
            <Col width={32} color="gray">{modeNote}</Col>
          </Box>
        );
      })}
    </Panel>
  );
}

function RecentFillsPanel({ feed, maxCount, journalFile, innerWidth }: { feed: FeedEvent[]; maxCount: number; journalFile: string; innerWidth: number }): JSX.Element {
  if (feed.length === 0) return <></>;
  return (
    <Panel title={`RECENT FILLS · ${journalFile}`} borderColor="cyan">
      <Box marginBottom={0}>
        <Col width={14} color="gray">TIME</Col>
        <Col width={10} color="gray">ACTION</Col>
        <Col width={12} color="gray">SYM</Col>
        <Col width={50} color="gray">DETAIL</Col>
        <Box flexGrow={1} />
        <Col width={12} align="right" color="gray">PNL</Col>
      </Box>
      <Separator width={innerWidth} />
      {feed.slice(0, maxCount).map((e, i) => {
        const isOpenLike = e.action === "open" || e.action === "add" || e.action === "flip_open" || e.action === "re_ent";
        const verb = e.action === "re_ent" ? "RE-ENT" : e.action === "dirbrk" ? "DIRBRK" : e.action === "add" ? "ADD" : e.action === "close" ? "CLOSE" : "OPEN";
        const detailStr = isOpenLike
          ? `${e.strategyId}  fresh SCALP @ ${e.price ? (e.price >= 1000 ? e.price.toFixed(2) : e.price.toFixed(4)) : "-"}`
          : e.action === "dirbrk"
          ? `structure/direction broke @ ${e.price?.toFixed(2) ?? "-"}  (${e.strategyId})`
          : `${e.strategyId}  (${e.reason ?? "exit"})`;
        return (
          <Box key={i}>
            <Col width={14} color="gray">{new Date(e.ts).toLocaleTimeString()}</Col>
            <Col width={10} color={isOpenLike ? "yellow" : e.action === "dirbrk" ? "red" : "cyan"}>{verb}</Col>
            <Col width={12}>{e.symbol}</Col>
            <Col width={50} color="gray">{detailStr}</Col>
            <Box flexGrow={1} />
            <Col width={12} align="right" color={pnlColor(e.realizedPnl ?? 0)}>
              {isOpenLike ? "—" : fmtMoney(e.realizedPnl ?? 0)}
            </Col>
          </Box>
        );
      })}
    </Panel>
  );
}

function AiAnalystPanel({ summary, maxLines, maxChars }: { summary: { strategyId?: string; summary: string } | null; maxLines: number; maxChars: number }): JSX.Element {
  return (
    <Panel title="AI ANALYST (read-only, no trade access)" borderColor="green">
      {summary ? (
        <Box flexDirection="column">
          <Text color="gray">AI ANALYST — {summary.strategyId ?? "adaptive-timeframe review"}</Text>
          <Text wrap="wrap">{formatCompactSummary(summary.summary, maxLines, maxChars)}</Text>
        </Box>
      ) : (
        <Text color="gray">Waiting for trade evaluations (see .trading-agent/paper-trading-insights.md)</Text>
      )}
    </Panel>
  );
}

export function PaperTradingDashboard({ runner, pollMs, journalFile, analyst, readiness, fillNotifier, evaluator, onExit }: {
  runner: LivePaperRunner; pollMs: number; journalFile: string;
  analyst?: TradeAnalyst | null; readiness?: ReadinessMonitor | null; fillNotifier?: FillNotifier | null;
  evaluator?: TradeEvaluator | null; onExit?: () => void;
}): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [termWidth, setTermWidth] = useState<number>(stdout?.columns || 120);
  const [termHeight, setTermHeight] = useState<number>(stdout?.rows || 35);

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      if (stdout.columns) setTermWidth(stdout.columns);
      if (stdout.rows) setTermHeight(stdout.rows);
    };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  const [analystSummary, setAnalystSummary] = useState(analyst?.getLatestSummary() ?? null);
  const [readinessResult, setReadinessResult] = useState<{ strategies: StrategyReadiness[]; portfolio: PortfolioReadiness } | null>(null);
  const [_evaluations, setEvaluations] = useState<TradeEvaluation[]>(evaluator?.getRecentEvaluations(5) ?? []);
  const [_evalQueueLen, setEvalQueueLen] = useState(0);

  const [rows, setRows] = useState<RowStatus[]>(runner.getStatus() as RowStatus[]);
  const [symbolPositions, setSymbolPositions] = useState<SymbolPosition[]>(runner.getSymbolPositions());
  const [feed, setFeed] = useState<FeedEvent[]>(readLastJournalEvents(journalFile, 8));
  const [lastTick, setLastTick] = useState<Date | null>(null);
  const [nextTickIn, setNextTickIn] = useState(pollMs / 1000);
  const [ticking, setTicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(new Date());

  const [livePrices, setLivePrices] = useState<Record<string, { price: number; time: number; changePct24h?: number }>>({});
  const [wsStatus, setWsStatus] = useState<Record<string, "connecting" | "live" | "stale" | "error">>({});
  const [priceHistory, setPriceHistory] = useState<Record<string, number[]>>({});
  const [equityHistory, setEquityHistory] = useState<number[]>([]);
  const [peakEquity, setPeakEquity] = useState(0);

  const streamRef = useRef<BinanceStreamManager | null>(null);

  useEffect(() => {
    const stream = new BinanceStreamManager();
    streamRef.current = stream;
    const symbols = runner.getSymbols();
    const initial: Record<string, "connecting" | "live" | "stale" | "error"> = {};
    for (const sym of symbols) initial[sym] = "connecting";
    setWsStatus(initial);
    for (const sym of symbols) {
      stream.subscribe(sym)
        .then(() => { setWsStatus((s) => ({ ...s, [sym]: "live" })); })
        .catch(() => { setWsStatus((s) => ({ ...s, [sym]: "error" })); });
    }
    return () => { for (const sym of symbols) stream.unsubscribe(sym); };
  }, [runner]);

  useEffect(() => {
    if (!readiness) return;
    let cancelled = false;
    readiness.check().then((rr) => { if (!cancelled) setReadinessResult({ strategies: rr.strategies, portfolio: rr.portfolio }); });
    return () => { cancelled = true; };
  }, [readiness]);

  useEffect(() => {
    if (!analyst) return;
    let stopped = false;
    void analyst.start(5 * 60 * 1000, (ran) => {
      if (stopped || !ran) return;
      setAnalystSummary(analyst.getLatestSummary());
    });
    return () => { stopped = true; analyst.stop(); };
  }, [analyst]);

  useEffect(() => {
    if (!evaluator) return;
    let stopped = false;
    void evaluator.start(30_000, (queueLen) => {
      if (stopped) return;
      setEvaluations(evaluator.getRecentEvaluations(5));
      setEvalQueueLen(queueLen);
    });
    return () => { stopped = true; evaluator.stop(); };
  }, [evaluator]);

  useEffect(() => {
    const t = setInterval(() => {
      setClock(new Date());
      setNextTickIn((s) => (s > 0 ? s - 1 : 0));
      const stream = streamRef.current;
      const symbols = runner.getSymbols();
      if (!stream) return;

      setLivePrices((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const sym of symbols) {
          const tick = stream.getLatest(sym);
          if (tick && (prev[sym]?.price !== tick.price || prev[sym]?.time !== tick.time)) {
            next[sym] = { price: tick.price, time: tick.time, ...(tick.changePct24h !== undefined && { changePct24h: tick.changePct24h }) };
            changed = true;
            setPriceHistory((ph) => {
              const cur = ph[sym] ?? [];
              return { ...ph, [sym]: [...cur.slice(-7), tick.price] };
            });
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => { clearInterval(t); };
  }, [runner]);

  useEffect(() => {
    let stopped = false;
    async function loop(): Promise<void> {
      while (!stopped) {
        setTicking(true);
        try {
          const result = await runner.tick();
          setRows(runner.getStatus() as RowStatus[]);
          setSymbolPositions(runner.getSymbolPositions());
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
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
    void loop();
    return () => { stopped = true; };
  }, [runner, pollMs, journalFile, fillNotifier, readiness]);

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

  const portfolio = runner.getPortfolio();
  const totalRealized = rows.reduce((s, r) => s + r.attributedPnl, 0);
  const totalUnrealized = symbolPositions.reduce((s, p) => {
    const live = livePrices[p.symbol]?.price;
    const u = live ? runner.unrealizedPnl(p.symbol, live) : null;
    return s + (u ?? 0);
  }, 0);
  const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
  const totalWins = rows.reduce((s, r) => s + r.wins, 0);
  const totalLosses = rows.reduce((s, r) => s + r.losses, 0);
  const winRate = totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) : 0;
  const currentTotalEquity = portfolio.totalInitialCapital + totalRealized + totalUnrealized;

  useEffect(() => {
    setPeakEquity((prev) => Math.max(prev, currentTotalEquity));
    setEquityHistory((prev) => [...prev.slice(-30), currentTotalEquity]);
  }, [currentTotalEquity]);

  const activeContributorIds = new Set(symbolPositions.flatMap((p) => p.contributingStrategyIds));
  const isSmall = termHeight <= 32;
  const maxFeedCount = isSmall ? 3 : 6;
  const innerWidth = Math.max(40, termWidth - 6);
  const halfWidth = Math.max(30, Math.floor((termWidth - 5) / 2));

  return (
    <Box flexDirection="column" height={termHeight} justifyContent="space-between" paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text>
          <Text bold color="cyan">◆ PAPER TRADING TERMINAL</Text>
          <Text color="gray">  {rows.length} strat · {runner.getSymbols().length} sym · scalp›intra›swing · {pollMs / 1000}s poll</Text>
        </Text>
        <Text color="gray">{clock.toLocaleTimeString()}</Text>
      </Box>

      <MarketsPanel symbols={runner.getSymbols()} livePrices={livePrices} wsStatus={wsStatus} priceHistory={priceHistory} />

      <SessionTempoPanel />

      {readinessResult && (readinessResult.portfolio.ready || readinessResult.strategies.some((s) => s.ready)) && (
        <Box borderStyle="double" borderColor="green" paddingX={1} marginBottom={1}>
          <Text bold color="green">
            🟢 {readinessResult.portfolio.ready ? "PORTFOLIO READY FOR LIVE" : "READY FOR LIVE"}: {" "}
            {readinessResult.portfolio.ready
              ? `${readinessResult.portfolio.readyCount}/${readinessResult.portfolio.evaluableCount} evaluable strategies passing`
              : readinessResult.strategies.filter((s) => s.ready).map((s) => s.strategyId).join(", ")}
          </Text>
        </Box>
      )}

      <PortfolioAccountPanels
        portfolio={portfolio} totalRealized={totalRealized} totalUnrealized={totalUnrealized}
        totalTrades={totalTrades} wins={totalWins} losses={totalLosses} winRate={winRate}
        lastTick={lastTick} nextTickIn={nextTickIn} ticking={ticking} error={error}
        equityHistory={equityHistory} peakEquity={peakEquity} halfWidth={halfWidth}
      />

      <OpenPositionsPanel
        positions={symbolPositions} livePrices={livePrices} totalEquity={currentTotalEquity}
        leverage={portfolio.leverage} symbolCount={portfolio.symbolCount} innerWidth={innerWidth}
      />

      <StrategiesPanel rows={rows} activeContributorIds={activeContributorIds} innerWidth={innerWidth} />

      <RecentFillsPanel feed={feed} maxCount={maxFeedCount} journalFile={journalFile} innerWidth={innerWidth} />

      <AiAnalystPanel summary={analystSummary} maxLines={isSmall ? 3 : 6} maxChars={800} />
    </Box>
  );
}
