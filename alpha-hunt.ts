#!/usr/bin/env tsx
/**
 * Alpha Hunt — Systematic intraday strategy discovery for SOLUSDT, ETHUSDT, XRPUSDT
 * Tests 6 strategy families across multiple timeframes and parameter sets.
 * Validates with walk-forward + Monte Carlo.
 */
import "dotenv/config";
import { Agent } from "./src/cli/agent.js";

const SYMBOLS = ["SOLUSDT", "ETHUSDT", "XRPUSDT"];
const TF = "15m";           // intraday
const LONG_TF = "1h";
const CANDLE_LIMIT = 500;   // ~5-8 days of 15m data
const RISK_DEFAULT = { risk: { stopPct: 0.015, targetPct: 0.03 }, feeBps: 5, maxHoldBars: 48 };

type StratResult = {
  symbol: string; strategy: string; params: string;
  trades: number; winRate: number; pf: number | null; expectancy: number | null;
  maxDD: number | null;
};

const results: StratResult[] = [];

async function main() {
  const agent = new Agent({
    config: { workspaceRoot: process.cwd(), tier: "local", model: "qwen2.5:0.5b" }
  });
  const val = await agent.validateModel();
  if (val !== true) console.log("Model validation:", val);

  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  ALPHA HUNT — Intraday Strategy Discovery`);
  console.log(`  Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`  Timeframes: ${TF} / ${LONG_TF}`);
  console.log(`  Date: ${new Date().toISOString().slice(0,10)}`);
  console.log(`══════════════════════════════════════════════════════════\n`);

  // ── Phase 0: Market State ──
  console.log("── Market State ──\n");
  for (const sym of SYMBOLS) {
    const [ind, fut] = await Promise.all([
      agent.tools.registry.invoke("binance_technical_indicators", { symbol: sym, interval: TF, limit: 100, indicators: ["sma", "ema", "rsi", "macd", "bollinger"] }),
      agent.tools.registry.invoke("binance_futures_stats", { symbol: sym }),
    ]);
    if (!ind.error) {
      const i = ind.indicators;
      const signal = i.rsi14 < 35 ? "OVERSOLD" : i.rsi14 > 65 ? "OVERBOUGHT" : "neutral";
      console.log(`  ${sym}:`);
      console.log(`    RSI(14)=${i.rsi14?.toFixed(1)}  ${signal}`);
      console.log(`    SMA(20)=${i.sma20?.toFixed(2)}  EMA(20)=${i.ema20?.toFixed(2)}`);
      console.log(`    MACD=${i.macd?.macd?.toFixed(2)}  Hist=${i.macd?.histogram?.toFixed(2)}`);
      if (!fut.error) console.log(`    Funding=${(fut.lastFundingRate*100).toFixed(4)}%  OI=${Number(fut.openInterest).toLocaleString()}`);
    }
    console.log();
  }

  // ── Strategy Families ──
  for (const sym of SYMBOLS) {
    console.log(`╔══════════════════════════════════════════════════════════╗`);
    console.log(`║  ${sym} — Systematic Strategy Scan`);
    console.log(`╚══════════════════════════════════════════════════════════╝\n`);

    // Strategy 1: RSI Mean Reversion (long)
    await testStrat(agent, sym, "RSI long MR", {
      direction: "long", entry: [{ type: "rsi_below", period: 14, value: 30 }], ...RISK_DEFAULT,
    });
    await testStrat(agent, sym, "RSI long MR 25", {
      direction: "long", entry: [{ type: "rsi_below", period: 14, value: 25 }], ...RISK_DEFAULT,
    });
    await testStrat(agent, sym, "RSI long MR 35", {
      direction: "long", entry: [{ type: "rsi_below", period: 14, value: 35 }], ...RISK_DEFAULT,
    });

    // Strategy 2: RSI Mean Reversion (short)
    await testStrat(agent, sym, "RSI short MR", {
      direction: "short", entry: [{ type: "rsi_above", period: 14, value: 70 }], ...RISK_DEFAULT,
    });
    await testStrat(agent, sym, "RSI short MR 75", {
      direction: "short", entry: [{ type: "rsi_above", period: 14, value: 75 }], ...RISK_DEFAULT,
    });

    // Strategy 3: Trend following — price above SMA
    await testStrat(agent, sym, "Price>EMA long", {
      direction: "long", entry: [{ type: "price_above_ema", period: 20 }], ...RISK_DEFAULT,
    });
    await testStrat(agent, sym, "Price>SMA long", {
      direction: "long", entry: [{ type: "price_above_sma", period: 20 }], ...RISK_DEFAULT,
    });
    await testStrat(agent, sym, "Price<EMA short", {
      direction: "short", entry: [{ type: "price_below_ema", period: 20 }], ...RISK_DEFAULT,
    });
    await testStrat(agent, sym, "Price<SMA short", {
      direction: "short", entry: [{ type: "price_below_sma", period: 20 }], ...RISK_DEFAULT,
    });

    // Strategy 4: MACD crosses
    await testStrat(agent, sym, "MACD bullish cross", {
      direction: "long", entry: [{ type: "macd_bullish_cross" }], ...RISK_DEFAULT,
    });
    await testStrat(agent, sym, "MACD bearish cross", {
      direction: "short", entry: [{ type: "macd_bearish_cross" }], ...RISK_DEFAULT,
    });

    // Strategy 5: Bollinger mean reversion
    await testStrat(agent, sym, "Bollinger touch lower", {
      direction: "long", entry: [{ type: "bollinger_touch_lower" }], ...RISK_DEFAULT,
    });
    await testStrat(agent, sym, "Bollinger touch upper", {
      direction: "short", entry: [{ type: "bollinger_touch_upper" }], ...RISK_DEFAULT,
    });

    // Strategy 6: Combined RSI + Trend filter
    await testStrat(agent, sym, "RSI<30 + Price>EMA long", {
      direction: "long", 
      entry: [{ type: "rsi_below", period: 14, value: 30 }, { type: "price_above_ema", period: 20 }],
      ...RISK_DEFAULT,
    });
    await testStrat(agent, sym, "RSI>70 + Price<EMA short", {
      direction: "short",
      entry: [{ type: "rsi_above", period: 14, value: 70 }, { type: "price_below_ema", period: 20 }],
      ...RISK_DEFAULT,
    });

    console.log();
  }

  // ── Parameter Sweeps on best candidates ──
  console.log(`\n── Parameter Optimization (RSI sweeps on ${LONG_TF}) ──\n`);
  for (const sym of SYMBOLS) {
    const r = await agent.tools.registry.invoke("binance_param_sweep", {
      symbol: sym, interval: LONG_TF, limit: CANDLE_LIMIT,
      strategy: { direction: "long", entry: [{ type: "rsi_below", period: 14, value: 30 }], ...RISK_DEFAULT },
      ranges: [
        { conditionIndex: 0, field: "period", values: [7, 10, 14, 18, 21] },
        { conditionIndex: 0, field: "value", values: [20, 25, 30, 35, 40] },
      ],
    });
    if (!r.error) {
      console.log(`  ${sym} RSI period/threshold sweep (${r.combinationsTested} combos):`);
      const sorted = [...r.top].sort((a: any, b: any) => (b.metrics.expectancyPct ?? -999) - (a.metrics.expectancyPct ?? -999));
      for (const p of sorted.slice(0, 5)) {
        const period = p.overrides.find((o: any) => o.field === "period")?.value ?? "?";
        const value = p.overrides.find((o: any) => o.field === "value")?.value ?? "?";
        console.log(`    period=${period} threshold=${value}  E=${p.metrics.expectancyPct?.toFixed(4)}  WR=${p.metrics.winRate != null ? (p.metrics.winRate*100).toFixed(1)+"%" : "?"}  trades=${p.metrics.totalTrades}`);
      }
      console.log();
    }
  }

  // ── Walk-Forward on best ──
  console.log(`\n── Walk-Forward Validation (best candidates) ──\n`);
  for (const sym of SYMBOLS) {
    const wf = await agent.tools.registry.invoke("binance_walk_forward", {
      symbol: sym, interval: LONG_TF, limit: CANDLE_LIMIT, folds: 5,
      strategy: { direction: "long", entry: [{ type: "rsi_below", period: 14, value: 30 }], ...RISK_DEFAULT },
    });
    if (!wf.error) {
      const wis = (wf.windows || []).filter((w: any) => w.metrics.totalTrades > 0);
      if (wis.length > 0) {
        const dir = wf.consistentDirection;
        const stab = wf.expectancyStability;
        console.log(`  ${sym} RSI<30 walk-forward (${wf.windows.length} folds, ${wis.length} active):`);
        for (const w of wis) console.log(`    Fold ${w.fromIndex}-${w.toIndex}: ${w.metrics.totalTrades} trades  WR=${(w.metrics.winRate*100).toFixed(1)}%  E=${w.metrics.expectancyPct?.toFixed(4)}`);
        console.log(`    Stability: ${stab?.toFixed(4)}  Consistent: ${dir}`);
        console.log(`    Verdict: ${stab != null && stab < 0.5 && dir ? "⭐ POTENTIAL EDGE" : "⚠️  Weak/No edge"}`);
      } else {
        console.log(`  ${sym}: No active trade windows for walk-forward\n`);
      }
    }
  }

  // ── Monte Carlo on best ──
  console.log(`\n── Monte Carlo Robustness ──\n`);
  for (const sym of SYMBOLS) {
    const mc = await agent.tools.registry.invoke("binance_monte_carlo", {
      symbol: sym, interval: LONG_TF, limit: CANDLE_LIMIT, simulations: 1000,
      strategy: { direction: "long", entry: [{ type: "rsi_below", period: 14, value: 30 }], ...RISK_DEFAULT },
    });
    if (!mc.error) {
      const lossP = mc.probabilityOfLoss ?? 0;
      const medR = mc.medianReturnPct ?? 0;
      console.log(`  ${sym} RSI<30 Monte Carlo (${mc.tradesInSample} trades × ${mc.simulations} sims):`);
      console.log(`    Median return: ${(medR*100).toFixed(2)}%`);
      console.log(`    P5: ${(mc.p5ReturnPct*100).toFixed(2)}%  P95: ${(mc.p95ReturnPct*100).toFixed(2)}%`);
      console.log(`    Loss probability: ${(lossP*100).toFixed(1)}%`);
      console.log(`    Verdict: ${lossP < 0.3 ? "⭐ ROBUST EDGE" : lossP < 0.5 ? "📊 MODERATE" : "⚠️  HIGH LOSS RISK"}`);
      console.log();
    }
  }

  // ── Summary ──
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  ALPHA HUNT RESULTS`);
  console.log(`══════════════════════════════════════════════════════════\n`);

  const ranked = [...results].filter(r => r.trades >= 3).sort((a, b) => (b.expectancy ?? 0) - (a.expectancy ?? 0));
  console.log(`  Strategies with >=3 trades, ranked by expectancy:\n`);
  console.log(`  ${"SYMBOL".padEnd(9)} ${"STRATEGY".padEnd(25)} ${"TRADES".padEnd(6)} ${"WIN%".padEnd(6)} ${"PF".padEnd(8)} ${"EXPECT".padEnd(8)}`);
  console.log(`  ${"──────".padEnd(9)} ${"────────".padEnd(25)} ${"──────".padEnd(6)} ${"────".padEnd(6)} ${"────".padEnd(8)} ${"──────".padEnd(8)}`);
  for (const r of ranked.slice(0, 15)) {
    console.log(`  ${r.symbol.padEnd(9)} ${(r.strategy+" "+r.params).padEnd(25)} ${String(r.trades).padEnd(6)} ${(r.winRate*100).toFixed(0)+"%".padEnd(4)} ${r.pf != null ? r.pf.toFixed(2).padEnd(8) : "N/A".padEnd(8)} ${r.expectancy != null ? r.expectancy.toFixed(4).padEnd(8) : "N/A".padEnd(8)}`);
  }

  await agent.flushLearning();
}

async function testStrat(agent: Agent, sym: string, label: string, strategy: any) {
  const r = await agent.tools.registry.invoke("binance_backtest", {
    symbol: sym, interval: TF, limit: CANDLE_LIMIT, strategy,
  });
  if (r.error) {
    console.log(`  ${sym.padEnd(9)} ${label.padEnd(25)} ERROR: ${r.message}`);
  } else if (r.metrics) {
    results.push({
      symbol: sym, strategy: label, params: "",
      trades: r.metrics.totalTrades, winRate: r.metrics.winRate,
      pf: r.metrics.profitFactor ?? null, expectancy: r.metrics.expectancyPct ?? null,
      maxDD: r.metrics.maxDrawdownPct ?? null,
    });
    if (r.metrics.totalTrades > 0) {
      console.log(`  ${sym.padEnd(9)} ${label.padEnd(25)} trades=${String(r.metrics.totalTrades).padEnd(3)} WR=${(r.metrics.winRate*100).toFixed(0).padEnd(3)} PF=${r.metrics.profitFactor?.toFixed(2) || "?"}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
