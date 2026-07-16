import { fetchCandlesRange, runFuturesBacktest, BinanceSignalFusionTool } from "../src/tools/backtest-tools.js";
import { readFileSync, writeFileSync } from "fs";

const cfg = JSON.parse(readFileSync("strategies.json", "utf-8"));
const LEVERAGE = 5, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, CAP = 10000;
const endTime = Date.now();
const startTime = endTime - 365 * 24 * 60 * 60 * 1000;

const candleCache: Record<string, any[]> = {};
async function getCandles(symbol: string, tf: string) {
  const key = `${symbol}:${tf}`;
  if (candleCache[key]) return candleCache[key];
  const f = await fetchCandlesRange(symbol, tf, startTime, endTime);
  if ("error" in f) throw new Error(`${key}: ${f.message}`);
  candleCache[key] = f.candles;
  return f.candles;
}

// ── Phase 1: every strategy solo, exact stated params, 1yr, realistic sizing ──
console.log("═══ PHASE 1: SINGLE-STRATEGY 1YR VERIFICATION (5x lev, 5% margin, 3bps slip) ═══\n");
const soloResults: any[] = [];
for (const [sym, strats] of Object.entries(cfg.symbols) as [string, any[]][]) {
  for (const s of strats) {
    const tf = s.tf ?? "1h";
    const mh = s.maxHoldBars ?? 48;
    const candles = await getCandles(sym, tf);
    const mid = Math.floor(candles.length / 2);
    const full: any = runFuturesBacktest(candles, s.entry, s.direction, s.risk.stopPct, s.risk.targetPct, FEE_BPS, mh, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
    const h1: any = runFuturesBacktest(candles.slice(0, mid), s.entry, s.direction, s.risk.stopPct, s.risk.targetPct, FEE_BPS, mh, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
    const h2: any = runFuturesBacktest(candles.slice(mid), s.entry, s.direction, s.risk.stopPct, s.risk.targetPct, FEE_BPS, mh, CAP, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS);
    const m = full.metrics;
    const both = h1.metrics.totalPnlUsd > 0 && h2.metrics.totalPnlUsd > 0;
    const verdict = m.totalTrades < 15 ? "LOW_SAMPLE" : m.totalPnlUsd <= 0 ? "NET_NEGATIVE" : !both ? "REGIME_FRAGILE" : "OK";
    console.log(`${sym} ${s.id} @ ${tf} stop=${(s.risk.stopPct*100).toFixed(1)}% tgt=${(s.risk.targetPct*100).toFixed(1)}%:`);
    console.log(`  trades=${m.totalTrades} WR=${(m.winRate*100).toFixed(0)}% PF=${m.profitFactor.toFixed(2)} sharpe=${m.sharpeRatio.toFixed(1)} pnl=$${Math.round(m.totalPnlUsd)} maxDD=${(m.maxDrawdownPct*100).toFixed(1)}% [H1 $${Math.round(h1.metrics.totalPnlUsd)} | H2 $${Math.round(h2.metrics.totalPnlUsd)}] -> ${verdict}`);
    soloResults.push({ sym, id: s.id, tf, verdict, trades: m.totalTrades, winRate: m.winRate, pf: m.profitFactor, sharpe: m.sharpeRatio, pnlUsd: Math.round(m.totalPnlUsd), maxDDPct: m.maxDrawdownPct, h1: Math.round(h1.metrics.totalPnlUsd), h2: Math.round(h2.metrics.totalPnlUsd) });
  }
}

// ── Phase 2: fusion (FIFO entry + same-side confluence adds), grouped by timeframe ──
// Fusion tool takes ONE interval per call, so group strategies by tf.
console.log("\n═══ PHASE 2: FUSION FIFO (per-timeframe groups, then per-symbol) ═══");
const tool = new BinanceSignalFusionTool();
const byTf: Record<string, Record<string, any[]>> = {};
for (const [sym, strats] of Object.entries(cfg.symbols) as [string, any[]][]) {
  for (const s of strats) {
    const tf = s.tf ?? "1h";
    byTf[tf] ??= {};
    byTf[tf][sym] ??= [];
    byTf[tf][sym].push({
      id: s.id, label: s.label, direction: s.direction,
      signalType: s.entry[0].type, signalPeriod: s.entry[0].period, signalValue: s.entry[0].value,
      stopPct: s.risk.stopPct, targetPct: s.risk.targetPct,
    });
  }
}

const fusionResults: any[] = [];
async function runFusion(label: string, strategies: Record<string, any[]>, interval: string) {
  const r: any = await tool.call({
    strategies, initialCapital: CAP, leverage: LEVERAGE, marginPerTradePct: MARGIN_PCT,
    confluentAddPct: 0.5, interval, startTime, endTime,
  });
  if (r.error) { console.log(`  ${label}: ERROR ${r.message}`); return; }
  const exits = (r.trades as any[]).filter(t => t.type === "exit");
  const wins = exits.filter(t => t.pnl > 0).length;
  const confTrades = exits.filter(t => t.confluences > 0);
  const confAvg = confTrades.length ? confTrades.reduce((s, t) => s + t.pnl, 0) / confTrades.length : 0;
  const noConf = exits.filter(t => t.confluences === 0);
  const noConfAvg = noConf.length ? noConf.reduce((s, t) => s + t.pnl, 0) / noConf.length : 0;
  console.log(`  ${label} @ ${interval}: entries=${r.totalTrades} WR=${exits.length ? (wins/exits.length*100).toFixed(0) : "?"}% pnl=$${Math.round(r.totalPnlUsd)} return=${(r.totalReturnPct*100).toFixed(1)}% maxDD=${(r.maxDrawdownPct*100).toFixed(1)}% | conf-adds on ${confTrades.length}/${exits.length} exits, avgPnL with-conf $${confAvg.toFixed(0)} vs no-conf $${noConfAvg.toFixed(0)}`);
  fusionResults.push({ label, interval, entries: r.totalTrades, pnlUsd: Math.round(r.totalPnlUsd), returnPct: r.totalReturnPct, maxDDPct: r.maxDrawdownPct, wr: exits.length ? wins/exits.length : null, confTrades: confTrades.length, avgPnlWithConf: Math.round(confAvg), avgPnlNoConf: Math.round(noConfAvg), entryCounts: r.strategyEntryCounts });
}

for (const [tf, group] of Object.entries(byTf)) {
  const nStrats = Object.values(group).reduce((s, a) => s + a.length, 0);
  console.log(`\n── ${tf} group (${nStrats} strategies across ${Object.keys(group).length} symbols) ──`);
  // All symbols together (multi-active-strategy FIFO)
  await runFusion(`ALL-SYMBOLS (${nStrats} strats)`, group, tf);
  // Each symbol alone (single-symbol multi-strategy FIFO)
  for (const [sym, strats] of Object.entries(group)) {
    if (strats.length >= 2) await runFusion(`${sym} only (${strats.length} strats)`, { [sym]: strats }, tf);
  }
}

writeFileSync("scripts/verify-1yr-output.json", JSON.stringify({ solo: soloResults, fusion: fusionResults }, null, 2));
console.log("\nWrote scripts/verify-1yr-output.json");
