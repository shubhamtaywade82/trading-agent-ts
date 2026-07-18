import { fetchCandlesRange, runFuturesBacktest } from "../src/tools/backtest-tools.js";
import { ConceptsEngine } from "../src/concepts/adapter.js";
import { Candle } from "../src/backtest/types.js";
import { HTFContext } from "trading-concepts-ts";

// Split-sample validation of the two edge-backtester findings (htfAligned,
// liquiditySweptNearZone — see tools/edge-backtester's design spec) BEFORE
// either is considered for promotion into strategies.json. Prints only —
// never writes the pool file. A human reviews this output and manually
// promotes any survivor, matching every prior finding in strategies.json's
// _verification block (never applied automatically).
//
// Candidates below map each concepts_* base condition onto the SAME
// symbol/tf/stopPct/targetPct/maxHoldBars as the closest already-validated
// pool entry of the same family (bearish_fvg/bullish_liq_fvg -> FVG;
// bearish_liq_sweep -> sellside sweep), reusing calibrated risk numbers
// rather than inventing new ones. Strategies with no concepts_* equivalent
// (RSI/ADX/Ichimoku/OB-retest) are intentionally excluded — forcing an
// approximate mapping there would be exactly the "reimplemented, drifted
// logic" this codebase's own history warns against.

const LEVERAGE = 5, MARGIN_PCT = 0.05, SLIPPAGE_BPS = 3, FEE_BPS = 5, INITIAL_CAPITAL = 10000;
const LOOKBACK_DAYS = 365;
const MIN_TRADES_PER_HALF = 15;

const HTF_FOR_TF: Record<string, string> = { "30m": "4h", "1h": "4h", "2h": "1d", "4h": "1d" };

type Direction = "long" | "short";
type Base = "concepts_bullish_fvg" | "concepts_bearish_fvg" | "concepts_buyside_sweep" | "concepts_sellside_sweep";

interface Candidate {
  symbol: string; tf: string; direction: Direction; base: Base;
  stopPct: number; targetPct: number; maxHoldBars: number;
  sourceStrategyId: string; // the pool entry this risk plan is borrowed from, for traceability
}

const CANDIDATES: Candidate[] = [
  { symbol: "XRPUSDT", tf: "1h", direction: "short", base: "concepts_bearish_fvg", stopPct: 0.03, targetPct: 0.06, maxHoldBars: 48, sourceStrategyId: "xrp-bearish-fvg-1h" },
  { symbol: "XRPUSDT", tf: "1h", direction: "short", base: "concepts_sellside_sweep", stopPct: 0.03, targetPct: 0.06, maxHoldBars: 48, sourceStrategyId: "xrp-liq-sweep-short-1h" },
  { symbol: "XRPUSDT", tf: "30m", direction: "short", base: "concepts_bearish_fvg", stopPct: 0.02, targetPct: 0.04, maxHoldBars: 48, sourceStrategyId: "xrp-liq-fvg-short-30m" },
  { symbol: "XRPUSDT", tf: "1h", direction: "long", base: "concepts_bullish_fvg", stopPct: 0.01, targetPct: 0.04, maxHoldBars: 48, sourceStrategyId: "xrp-liq-fvg-long-1h" },
  { symbol: "XRPUSDT", tf: "2h", direction: "short", base: "concepts_sellside_sweep", stopPct: 0.02, targetPct: 0.06, maxHoldBars: 36, sourceStrategyId: "xrp-liq-sweep-short-2h" },
  { symbol: "ETHUSDT", tf: "4h", direction: "long", base: "concepts_bullish_fvg", stopPct: 0.02, targetPct: 0.04, maxHoldBars: 42, sourceStrategyId: "eth-liq-fvg-long-4h" },
  { symbol: "ETHUSDT", tf: "1h", direction: "short", base: "concepts_bearish_fvg", stopPct: 0.02, targetPct: 0.02, maxHoldBars: 48, sourceStrategyId: "eth-bearish-fvg-1h" },
  { symbol: "ETHUSDT", tf: "30m", direction: "short", base: "concepts_bearish_fvg", stopPct: 0.008, targetPct: 0.04, maxHoldBars: 48, sourceStrategyId: "eth-liq-fvg-short-30m" },
  { symbol: "SOLUSDT", tf: "1h", direction: "short", base: "concepts_bearish_fvg", stopPct: 0.01, targetPct: 0.02, maxHoldBars: 48, sourceStrategyId: "sol-bearish-fvg-1h" },
  { symbol: "SOLUSDT", tf: "1h", direction: "short", base: "concepts_sellside_sweep", stopPct: 0.02, targetPct: 0.06, maxHoldBars: 48, sourceStrategyId: "sol-liq-sweep-short-1h" },
  { symbol: "SOLUSDT", tf: "1h", direction: "long", base: "concepts_bullish_fvg", stopPct: 0.01, targetPct: 0.02, maxHoldBars: 48, sourceStrategyId: "sol-liq-fvg-long-1h" },
  { symbol: "SOLUSDT", tf: "2h", direction: "short", base: "concepts_sellside_sweep", stopPct: 0.03, targetPct: 0.05, maxHoldBars: 36, sourceStrategyId: "sol-liq-sweep-short-2h" },
];

const cache: Record<string, Candle[]> = {};
async function getCandles(symbol: string, tf: string): Promise<Candle[]> {
  const key = `${symbol}:${tf}`;
  if (cache[key]) return cache[key];
  const endTime = Date.now();
  const startTime = endTime - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const fetched = await fetchCandlesRange(symbol, tf, startTime, endTime);
  if ("error" in fetched) throw new Error(`${key}: ${fetched.message}`);
  cache[key] = fetched.candles;
  return fetched.candles;
}

function htfContextFor(htfCandles: Candle[], asOfTime: number): HTFContext {
  const visible = htfCandles.filter(c => c.openTime <= asOfTime);
  if (visible.length === 0) return {};
  return new ConceptsEngine(visible).toHTFContext();
}

function fmt(m: any): string {
  return `trades=${m.totalTrades} WR=${(m.winRate * 100).toFixed(0)}% PF=${m.profitFactor.toFixed(2)} pnl=$${Math.round(m.totalPnlUsd)}`;
}

async function main() {
  const summary: { symbol: string; tf: string; base: string; variant: string; sourceStrategyId: string; passes: boolean }[] = [];

  for (const c of CANDIDATES) {
    const ltf = await getCandles(c.symbol, c.tf);
    const htfTf = HTF_FOR_TF[c.tf] ?? "4h";
    const htf = await getCandles(c.symbol, htfTf);

    const half = Math.floor(ltf.length / 2);
    const train = ltf.slice(0, half);
    const test = ltf.slice(half);

    console.log(`\n=== ${c.symbol} ${c.tf} ${c.direction} (base: ${c.base}, risk from ${c.sourceStrategyId}) ===`);

    const variants: { label: string; evalFor: (candles: Candle[]) => (i: number) => boolean }[] = [
      { label: "baseline", evalFor: (candles) => new ConceptsEngine(candles).evaluator([{ type: c.base }]) },
      {
        label: `+htf_aligned_${c.direction === "long" ? "bullish" : "bearish"}`,
        evalFor: (candles) => {
          const asOf = candles[candles.length - 1]?.openTime ?? 0;
          const htfContext = htfContextFor(htf, asOf);
          return new ConceptsEngine(candles, { htfContext }).evaluator([
            { type: c.base },
            { type: `concepts_htf_aligned_${c.direction === "long" ? "bullish" : "bearish"}` },
          ]);
        },
      },
      {
        label: "+liquidity_swept_near",
        evalFor: (candles) => new ConceptsEngine(candles).evaluator([{ type: c.base }, { type: "concepts_liquidity_swept_near" }]),
      },
    ];

    for (const v of variants) {
      const trainMetrics: any = runFuturesBacktest(
        train, v.evalFor(train), c.direction, c.stopPct, c.targetPct, FEE_BPS, c.maxHoldBars,
        INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS,
      ).metrics;
      const testMetrics: any = runFuturesBacktest(
        test, v.evalFor(test), c.direction, c.stopPct, c.targetPct, FEE_BPS, c.maxHoldBars,
        INITIAL_CAPITAL, LEVERAGE, MARGIN_PCT, SLIPPAGE_BPS,
      ).metrics;

      const passes = trainMetrics.totalPnlUsd > 0 && testMetrics.totalPnlUsd > 0
        && trainMetrics.totalTrades >= MIN_TRADES_PER_HALF && testMetrics.totalTrades >= MIN_TRADES_PER_HALF;

      console.log(`  ${v.label}:`);
      console.log(`    train: ${fmt(trainMetrics)}`);
      console.log(`    test:  ${fmt(testMetrics)}`);
      console.log(`    SPLIT-SAMPLE PASS: ${passes}`);

      summary.push({ symbol: c.symbol, tf: c.tf, base: c.base, variant: v.label, sourceStrategyId: c.sourceStrategyId, passes });
    }
  }

  console.log("\n\n=== SUMMARY (survivors only) ===");
  for (const row of summary.filter(r => r.passes)) {
    console.log(`  ${row.symbol} ${row.tf} ${row.base} ${row.variant} (risk from ${row.sourceStrategyId})`);
  }
  if (summary.every(r => !r.passes)) console.log("  (none)");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
