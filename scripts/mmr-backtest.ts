import { parseKlineRows, type Candle } from "../src/backtest/types.js";
import { atrSeries } from "../src/tools/indicators.js";

// ── Config ──
const DIVISOR = 2.6;
const SYMBOLS = ["SOLUSDT", "ETHUSDT", "BTCUSDT", "XRPUSDT", "BNBUSDT"];
const TF_30M = { interval: "30m", days: 180, maxHoldBars: 48 };
const MIN_IMPULSE_CANDLES = 3;
const MAX_IMPULSE_CANDLES = 21;
const MIN_IMPULSE_RANGE_PCT = 0.5;
const MIN_IMPULSE_ATR = 1.5;
const ENTRY_TOLERANCE_PCT = 0.1;
const RISK_REWARD_RATIO = 2;
const INITIAL_CAPITAL = 10000;

interface ImpulseLeg {
  startIdx: number; endIdx: number; low: number; high: number; range: number; direction: "BULLISH" | "BEARISH";
}
interface Trade {
  entryTime: number; exitTime: number; entryPrice: number; exitPrice: number;
  direction: "LONG" | "SHORT"; pnl: number; pnlPct: number; exitReason: string;
  impulseLow: number; impulseHigh: number; impulseRange: number;
  mmrEntry: number; stopLoss: number; takeProfit: number; holdBars: number;
}
interface Metrics { totalTrades: number; winningTrades: number; losingTrades: number; winRate: number; totalPnlUsd: number; totalReturnPct: number; maxDrawdownPct: number; profitFactor: number; avgWinPct: number; avgLossPct: number; expectancyPct: number; sharpeRatio: number; avgHoldBars: number; finalCapital: number; }

const fetchCache = new Map<string, Promise<Candle[]>>();

async function fetchCandles(symbol: string, interval: string, days: number): Promise<Candle[]> {
  const cacheKey = `${symbol}:${interval}:${days}`;
  const cached = fetchCache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    const all: unknown[][] = [];
    const endTime = Date.now();
    const startTime = endTime - days * 24 * 60 * 60 * 1000;
    let from = startTime;
    while (from < endTime) {
      const url = new URL("/api/v3/klines", "https://api.binance.com");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("limit", "1000");
      url.searchParams.set("startTime", String(from));
      const resp = await fetch(url);
      const rows = (await resp.json()) as unknown[][];
      if (rows.length === 0) break;
      all.push(...rows);
      from = Number(rows[rows.length - 1][0]) + 1;
    }
    return parseKlineRows(all);
  })();
  fetchCache.set(cacheKey, promise);
  return promise;
}

// ── Impulse detection (uses global MIN/MAX params, accepts divisor) ──
// Pass precomputed ATR to avoid O(n²) recomputation
function findImpulse(candles: Candle[], lookbackStart: number, atrValues: Float64Array): ImpulseLeg | null {
  const startBound = Math.max(MAX_IMPULSE_CANDLES, lookbackStart - 5);
  for (let endIdx = lookbackStart; endIdx >= startBound; endIdx--) {
    const minStart = Math.max(0, endIdx - MAX_IMPULSE_CANDLES);
    for (let startIdx = endIdx - MIN_IMPULSE_CANDLES; startIdx >= minStart; startIdx--) {
      const len = endIdx - startIdx + 1;
      if (len < MIN_IMPULSE_CANDLES) continue;
      let lowIdx = 0, highIdx = 0, low = Infinity, high = -Infinity;
      let totalBody = 0, totalOppositeWick = 0, counterCandles = 0;
      for (let k = startIdx; k <= endIdx; k++) {
        const c = candles[k];
        if (c.low < low) { low = c.low; lowIdx = k - startIdx; }
        if (c.high > high) { high = c.high; highIdx = k - startIdx; }
        const body = Math.abs(c.close - c.open);
        totalBody += body;
      }
      const range = high - low;
      if (range <= 0) continue;
      const direction = lowIdx < highIdx ? "BULLISH" : "BEARISH";
      const rangePct = (range / low) * 100;
      if (rangePct < MIN_IMPULSE_RANGE_PCT) continue;
      if (atrValues[endIdx] > 0 && range < MIN_IMPULSE_ATR * atrValues[endIdx]) continue;
      for (let k = startIdx; k <= endIdx; k++) {
        const c = candles[k];
        if (direction === "BULLISH") totalOppositeWick += c.high - Math.max(c.open, c.close);
        else totalOppositeWick += Math.min(c.open, c.close) - c.low;
        if ((direction === "BULLISH" && c.close <= c.open) || (direction === "BEARISH" && c.close > c.open)) counterCandles++;
      }
      if (totalBody / range < 0.4) continue;
      if (totalOppositeWick / range > 0.3) continue;
      if (counterCandles / len > 0.4) continue;
      return { startIdx, endIdx, low, high, range, direction };
    }
  }
  return null;
}

function calcEntry(impulse: ImpulseLeg, divisor: number): number {
  const pullbackDepth = impulse.range / divisor;
  return impulse.direction === "BULLISH" ? impulse.high - pullbackDepth : impulse.low + pullbackDepth;
}

function validatePullback(candles: Candle[], impulse: ImpulseLeg, entryPrice: number): { valid: boolean; score: number; reason?: string } {
  const pullbackCandles = candles.slice(impulse.endIdx + 1);
  if (pullbackCandles.length === 0) return { valid: false, score: 0, reason: "no pullback yet" };
  let score = 50;
  if (pullbackCandles.length >= 2) {
    const returns: number[] = [];
    for (let i = 1; i < pullbackCandles.length; i++) returns.push((pullbackCandles[i].close - pullbackCandles[i - 1].close) / pullbackCandles[i - 1].close);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const vol = Math.min(1, Math.sqrt(variance) * 100);
    if (vol < 0.3) score += 15; else if (vol > 0.7) score -= 20;
  }
  if (pullbackCandles.length > 0) {
    const last = pullbackCandles[pullbackCandles.length - 1];
    const nearEntry = Math.abs(last.close - entryPrice) < entryPrice * 0.002;
    if (nearEntry) {
      if (impulse.direction === "BULLISH") { const lw = Math.min(last.open, last.close) - last.low; if (lw > Math.abs(last.close - last.open) * 0.5) score += 20; }
      else { const uw = last.high - Math.max(last.open, last.close); if (uw > Math.abs(last.close - last.open) * 0.5) score += 20; }
    }
  }
  const avgImpulseVol = candles.slice(impulse.startIdx, impulse.endIdx + 1).reduce((s, c) => s + c.volume, 0) / (impulse.endIdx - impulse.startIdx + 1);
  const avgPullbackVol = pullbackCandles.reduce((s, c) => s + c.volume, 0) / pullbackCandles.length;
  if (avgPullbackVol < avgImpulseVol * 0.8) score += 10;
  let maxPullback = 0;
  for (const c of pullbackCandles) maxPullback = Math.max(maxPullback, impulse.direction === "BULLISH" ? impulse.high - c.low : c.high - impulse.low);
  if (maxPullback / impulse.range > 0.6) return { valid: false, score: 0, reason: "pullback too deep" };
  return { valid: score >= 50, score };
}

// ── Configurable backtest (accepts divisor) ──
function backtestMMR(candles: Candle[], divisor: number, maxHoldBars = 96): { trades: Trade[]; metrics: Metrics } {
  const trades: Trade[] = [];
  let capital = INITIAL_CAPITAL, peakCapital = INITIAL_CAPITAL, maxDrawdown = 0;
  let inPosition: { direction: "LONG" | "SHORT"; entryPrice: number; entryTime: number; stopLoss: number; takeProfit: number; impulseLow: number; impulseHigh: number; impulseRange: number; mmrEntry: number; entryIdx: number; } | null = null;
  const minIdx = MAX_IMPULSE_CANDLES + 10;

  // Precompute ATR once for all candles to avoid O(n²) recomputation
  const atr = atrSeries(candles, 14);
  const atrValues = new Float64Array(candles.length);
  for (let i = 0; i < candles.length; i++) atrValues[i] = atr[i] ?? NaN;

  for (let i = minIdx; i < candles.length; i++) {
    const candle = candles[i];
    if (inPosition) {
      const { direction, entryPrice, stopLoss, takeProfit, entryIdx } = inPosition;
      let exitPrice: number, exitReason: string;
      const holdBars = i - entryIdx;
      if (holdBars >= maxHoldBars) { exitPrice = candle.close; exitReason = "timeout"; }
      else if (direction === "LONG") { if (candle.low <= stopLoss) { exitPrice = stopLoss; exitReason = "stop"; } else if (candle.high >= takeProfit) { exitPrice = takeProfit; exitReason = "target"; } else continue; }
      else { if (candle.high >= stopLoss) { exitPrice = stopLoss; exitReason = "stop"; } else if (candle.low <= takeProfit) { exitPrice = takeProfit; exitReason = "target"; } else continue; }
      const rawPnl = direction === "LONG" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
      const pnlPct = rawPnl - 0.0005;
      const pnl = capital * pnlPct;
      capital += pnl;
      peakCapital = Math.max(peakCapital, capital);
      maxDrawdown = Math.max(maxDrawdown, (peakCapital - capital) / peakCapital);
      trades.push({ entryTime: inPosition.entryTime, exitTime: candle.openTime, entryPrice, exitPrice, direction, pnl, pnlPct, exitReason, impulseLow: inPosition.impulseLow, impulseHigh: inPosition.impulseHigh, impulseRange: inPosition.impulseRange, mmrEntry: inPosition.mmrEntry, stopLoss, takeProfit, holdBars });
      inPosition = null;
      continue;
    }
    const impulse = findImpulse(candles, i, atrValues);
    if (!impulse) continue;
    if (i - impulse.endIdx > 10) continue;
    const entryPrice = calcEntry(impulse, divisor);
    const tolerance = entryPrice * (ENTRY_TOLERANCE_PCT / 100);
    if (candle.high < entryPrice - tolerance || candle.low > entryPrice + tolerance) continue;
    const validation = validatePullback(candles.slice(0, i + 1), impulse, entryPrice);
    if (!validation.valid) continue;
    let stopLoss: number, takeProfit: number;
    if (impulse.direction === "BULLISH") { stopLoss = Math.min(impulse.low, entryPrice - impulse.range * 0.1); takeProfit = entryPrice + (entryPrice - stopLoss) * RISK_REWARD_RATIO; }
    else { stopLoss = Math.max(impulse.high, entryPrice + impulse.range * 0.1); takeProfit = entryPrice - (stopLoss - entryPrice) * RISK_REWARD_RATIO; }
    inPosition = { direction: impulse.direction === "BULLISH" ? "LONG" : "SHORT", entryPrice, entryTime: candle.openTime, stopLoss, takeProfit, impulseLow: impulse.low, impulseHigh: impulse.high, impulseRange: impulse.range, mmrEntry: entryPrice, entryIdx: i };
  }
  if (inPosition) {
    const last = candles[candles.length - 1];
    const rawPnl = inPosition.direction === "LONG" ? (last.close - inPosition.entryPrice) / inPosition.entryPrice : (inPosition.entryPrice - last.close) / inPosition.entryPrice;
    const pnlPct = rawPnl - 0.0005;
    capital += capital * pnlPct;
    trades.push({ entryTime: inPosition.entryTime, exitTime: last.openTime, entryPrice: inPosition.entryPrice, exitPrice: last.close, direction: inPosition.direction, pnl: capital * pnlPct, pnlPct, exitReason: "end-of-data", impulseLow: inPosition.impulseLow, impulseHigh: inPosition.impulseHigh, impulseRange: inPosition.impulseRange, mmrEntry: inPosition.mmrEntry, stopLoss: inPosition.stopLoss, takeProfit: inPosition.takeProfit, holdBars: candles.length - 1 - inPosition.entryIdx });
  }
  const totalPnl = capital - INITIAL_CAPITAL;
  const winning = trades.filter(t => t.pnl > 0);
  const losing = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length > 0 ? winning.length / trades.length : 0;
  const grossProfit = winning.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losing.reduce((s, t) => s + t.pnl, 0));
  const avgWin = winning.length > 0 ? winning.reduce((s, t) => s + t.pnlPct, 0) / winning.length : 0;
  const avgLoss = losing.length > 0 ? losing.reduce((s, t) => s + t.pnlPct, 0) / losing.length : 0;
  const returns = trades.map(t => t.pnlPct);
  const avgR = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((s, v) => s + (v - avgR) ** 2, 0) / (returns.length - 1) : 0;
  const sharpe = Math.sqrt(365 * 24) * avgR / (Math.sqrt(variance) || 1);
  return { trades, metrics: { totalTrades: trades.length, winningTrades: winning.length, losingTrades: losing.length, winRate, totalPnlUsd: totalPnl, totalReturnPct: totalPnl / INITIAL_CAPITAL, maxDrawdownPct: maxDrawdown, profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0, avgWinPct: avgWin, avgLossPct: avgLoss, expectancyPct: avgR, sharpeRatio: sharpe, avgHoldBars: trades.length > 0 ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length : 0, finalCapital: capital } };
}

// ── Helpers ──
function fmtPct(v: number): string { const s = (v * 100).toFixed(2); return v >= 0 ? `+${s}%` : `${s}%`; }
function fmtUsd(v: number): string { return v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`; }
function metricRow(label: string, m: Metrics, extra = ""): string {
  return `  ${label.padEnd(10)} ${String(m.totalTrades).padEnd(7)} ${(m.winRate * 100).toFixed(1).padEnd(6)}% ${fmtUsd(m.totalPnlUsd).padEnd(10)} ${fmtPct(m.totalReturnPct).padEnd(9)} ${(m.maxDrawdownPct * 100).toFixed(2).padEnd(7)}% ${m.profitFactor.toFixed(3).padEnd(8)} ${m.sharpeRatio.toFixed(2).padEnd(8)}${extra}`;
}

// ── 1. SPLIT-SAMPLE VALIDATION ──
async function validateSplitSample(): Promise<void> {
  console.log(`\n${"=".repeat(96)}`);
  console.log(`  1. SPLIT-SAMPLE VALIDATION  |  ${TF_30M.interval}  |  ${TF_30M.days}d`);
  console.log(`${"=".repeat(96)}`);
  console.log(`  ${"Symbol".padEnd(10)} ${"Trades".padEnd(7)} ${"Win%".padEnd(6)} ${"Full PnL".padEnd(10)} ${"H1 PnL".padEnd(10)} ${"H2 PnL".padEnd(10)} ${"Both+?".padEnd(8)} ${"Verdict".padEnd(14)}`);
  console.log(`  ${"-".repeat(75)}`);

  for (const symbol of SYMBOLS) {
    const candles = await fetchCandles(symbol, TF_30M.interval, TF_30M.days);
    const full = backtestMMR(candles, DIVISOR, TF_30M.maxHoldBars);
    const midIdx = Math.floor(candles.length / 2);
    const h1 = backtestMMR(candles.slice(0, midIdx), DIVISOR, TF_30M.maxHoldBars);
    const h2 = backtestMMR(candles.slice(midIdx), DIVISOR, TF_30M.maxHoldBars);
    const bothPos = h1.metrics.totalPnlUsd > 0 && h2.metrics.totalPnlUsd > 0;
    const enoughTrades = full.metrics.totalTrades >= 10;
    const verdict = !enoughTrades ? "LOW_SAMPLE" : bothPos ? "SURVIVES" : "REGIME_FRAGILE";
    console.log(`  ${symbol.padEnd(10)} ${String(full.metrics.totalTrades).padEnd(7)} ${(full.metrics.winRate * 100).toFixed(1).padEnd(5)}% ${fmtUsd(full.metrics.totalPnlUsd).padEnd(10)} ${fmtUsd(h1.metrics.totalPnlUsd).padEnd(10)} ${fmtUsd(h2.metrics.totalPnlUsd).padEnd(10)} ${bothPos ? "✓ BOTH+".padEnd(8) : "✗".padEnd(8)} ${verdict.padEnd(14)}`);
  }
}

// ── 2. PARAMETER SWEEP (divisor) ──
async function paramSweep(): Promise<void> {
  const DIVISORS = [2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.5];
  const SWEEP_SYMBOLS = ["SOLUSDT", "ETHUSDT", "BTCUSDT"];
  console.log(`\n${"=".repeat(96)}`);
  console.log(`  2. PARAMETER SWEEP — DIVISOR  |  ${TF_30M.interval}  |  ${TF_30M.days}d`);
  console.log(`  Symbols: ${SWEEP_SYMBOLS.join(", ")}`);
  console.log(`${"=".repeat(96)}`);

  for (const symbol of SWEEP_SYMBOLS) {
    const candles = await fetchCandles(symbol, TF_30M.interval, TF_30M.days);
    console.log(`\n  ${symbol}:`);
    console.log(`  ${"Divisor".padEnd(8)} ${"Trades".padEnd(7)} ${"Win%".padEnd(6)} ${"PnL".padEnd(10)} ${"Ret%".padEnd(9)} ${"MaxDD".padEnd(8)} ${"PF".padEnd(8)} ${"Sharpe".padEnd(8)} ${"AvgWin".padEnd(8)} ${"AvgLoss".padEnd(8)}`);
    console.log(`  ${"-".repeat(82)}`);
    for (const d of DIVISORS) {
      const r = backtestMMR(candles, d, TF_30M.maxHoldBars);
      const m = r.metrics;
      console.log(`  ${`÷${d.toFixed(1)}`.padEnd(8)} ${String(m.totalTrades).padEnd(7)} ${(m.winRate * 100).toFixed(1).padEnd(5)}% ${fmtUsd(m.totalPnlUsd).padEnd(10)} ${fmtPct(m.totalReturnPct).padEnd(9)} ${(m.maxDrawdownPct * 100).toFixed(2).padEnd(7)}% ${m.profitFactor.toFixed(3).padEnd(8)} ${m.sharpeRatio.toFixed(2).padEnd(8)} ${fmtPct(m.avgWinPct).padEnd(8)} ${fmtPct(m.avgLossPct).padEnd(8)}`);
    }
  }

  // Best divisor per symbol
  console.log(`\n  BEST DIVISOR PER SYMBOL (by Sharpe):`);
  for (const symbol of SWEEP_SYMBOLS) {
    const candles = await fetchCandles(symbol, TF_30M.interval, TF_30M.days);
    let bestD = 0, bestS = -Infinity, bestM: Metrics | null = null;
    for (const d of DIVISORS) {
      const r = backtestMMR(candles, d, TF_30M.maxHoldBars);
      if (r.metrics.sharpeRatio > bestS) { bestS = r.metrics.sharpeRatio; bestD = d; bestM = r.metrics; }
    }
    if (bestM) console.log(`  ${symbol.padEnd(10)} → ÷${bestD.toFixed(1)}  Sharpe: ${bestS.toFixed(2)}  PnL: ${fmtUsd(bestM.totalPnlUsd)}  Trades: ${bestM.totalTrades}`);
  }
}

// ── 3. MONTE CARLO SIMULATION ──
async function runMonteCarlo(): Promise<void> {
  const SIMULATIONS = 5000;
  const MC_SYMBOLS = ["SOLUSDT", "ETHUSDT", "BTCUSDT"];
  console.log(`\n${"=".repeat(96)}`);
  console.log(`  3. MONTE CARLO SIMULATION (${SIMULATIONS}x bootstrap resamples)`);
  console.log(`  Symbols: ${MC_SYMBOLS.join(", ")}`);
  console.log(`${"=".repeat(96)}`);

  for (const symbol of MC_SYMBOLS) {
    const candles = await fetchCandles(symbol, TF_30M.interval, TF_30M.days);
    const base = backtestMMR(candles, DIVISOR, TF_30M.maxHoldBars);
    const returns = base.trades.map(t => t.pnlPct);
    if (returns.length < 5) { console.log(`  ${symbol}: insufficient trades (${returns.length})`); continue; }

    const N = returns.length;
    const eqCurves: number[] = [];
    eqCurves.length = SIMULATIONS;
    for (let s = 0; s < SIMULATIONS; s++) {
      let mult = 1;
      for (let t = 0; t < N; t++) mult *= (1 + returns[Math.floor(Math.random() * N)]);
      eqCurves[s] = INITIAL_CAPITAL * mult;
    }
    eqCurves.sort((a, b) => a - b);

    const median = eqCurves[Math.floor(SIMULATIONS / 2)];
    const p5 = eqCurves[Math.floor(SIMULATIONS * 0.05)];
    const p95 = eqCurves[Math.floor(SIMULATIONS * 0.95)];
    const p1 = eqCurves[Math.floor(SIMULATIONS * 0.01)];
    const lossProb = eqCurves.filter(c => c < INITIAL_CAPITAL).length / SIMULATIONS;

    console.log(`  ${symbol}:  actual=${fmtUsd(base.metrics.totalPnlUsd)} (${fmtPct(base.metrics.totalReturnPct)})`);
    console.log(`    MC median: ${fmtUsd(median - INITIAL_CAPITAL)}  P5: ${fmtUsd(p5 - INITIAL_CAPITAL)}  P95: ${fmtUsd(p95 - INITIAL_CAPITAL)}  P1: ${fmtUsd(p1 - INITIAL_CAPITAL)}`);
    console.log(`    Loss prob: ${(lossProb * 100).toFixed(1)}%  |  P5-P95 spread: ${((p95 - median) / median * 100).toFixed(0)}%`);
  }
}

// ── 4. MORE SYMBOLS (30m only) ──
async function runMoreSymbols(): Promise<void> {
  console.log(`\n${"=".repeat(96)}`);
  console.log(`  4. 30m BACKTEST — ALL SYMBOLS`);
  console.log(`${"=".repeat(96)}`);
  console.log(`  ${"Symbol".padEnd(10)} ${"Trades".padEnd(7)} ${"Win%".padEnd(6)} ${"PnL".padEnd(10)} ${"Ret%".padEnd(9)} ${"MaxDD".padEnd(8)} ${"PF".padEnd(8)} ${"Sharpe".padEnd(8)} ${"AvgWin".padEnd(8)} ${"AvgLoss".padEnd(8)} ${"LONG".padEnd(8)} ${"SHORT".padEnd(8)}`);
  console.log(`  ${"-".repeat(104)}`);

  let totalTrades = 0, totalWins = 0, totalPnl = 0, peak = INITIAL_CAPITAL, maxDD = 0, capital = INITIAL_CAPITAL;

  for (const symbol of SYMBOLS) {
    const candles = await fetchCandles(symbol, TF_30M.interval, TF_30M.days);
    const r = backtestMMR(candles, DIVISOR, TF_30M.maxHoldBars);
    const m = r.metrics;
    const longs = r.trades.filter(t => t.direction === "LONG");
    const shorts = r.trades.filter(t => t.direction === "SHORT");
    const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
    const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
    console.log(metricRow(symbol, m, ` ${fmtUsd(longPnl).padEnd(8)} ${fmtUsd(shortPnl).padEnd(8)}`));
    totalTrades += m.totalTrades; totalWins += m.winningTrades; totalPnl += m.totalPnlUsd;
    capital = INITIAL_CAPITAL + totalPnl; peak = Math.max(peak, capital);
    maxDD = Math.max(maxDD, (peak - capital) / peak);
  }

  const wr = totalTrades > 0 ? totalWins / totalTrades : 0;
  const ret = totalPnl / INITIAL_CAPITAL;
  console.log(`  ${"-".repeat(104)}`);
  console.log(`  ${"TOTAL".padEnd(10)} ${String(totalTrades).padEnd(7)} ${(wr * 100).toFixed(1).padEnd(5)}% ${fmtUsd(totalPnl).padEnd(10)} ${fmtPct(ret).padEnd(9)} ${(maxDD * 100).toFixed(2).padEnd(7)}%`);
}

// ── MAIN ──
async function main() {
  console.log(`\nMMR ÷${DIVISOR} — VALIDATION SUITE`);
  console.log(`Interval: ${TF_30M.interval}  |  Lookback: ${TF_30M.days}d  |  Capital: $${INITIAL_CAPITAL}`);
  console.log(`Symbols: ${SYMBOLS.join(", ")}`);

  const start = Date.now();

  await validateSplitSample();
  await paramSweep();
  await runMonteCarlo();
  await runMoreSymbols();

  console.log(`\n${"=".repeat(96)}`);
  console.log(`  Done in ${((Date.now() - start) / 1000).toFixed(0)}s`);
  console.log();
}

main().catch(console.error);
