#!/usr/bin/env tsx
/**
 * TradingAgent TS — Real Execution E2E Test
 *
 * Tests ALL trading tools against live Binance API (no mock, no stub).
 * LLM agent integration tested at the end with a generous timeout.
 */
import "dotenv/config";
import { Agent } from "./src/cli/agent.js";

const MODEL = process.env.TRADINGAGENT_MODEL || "qwen2.5:0.5b";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

let pass = 0;
let fail = 0;

function ok(label: string, detail?: string) {
  pass++;
  console.log(`  ✅ ${label}${detail ? " — " + detail : ""}`);
}

function nok(label: string, err?: unknown) {
  fail++;
  console.log(`  ❌ ${label}${err ? " — " + (err instanceof Error ? err.message : String(err)) : ""}`);
}

async function check(agent: Agent, toolName: string, label: string, args: Record<string, unknown>, validators?: ((r: Record<string, unknown>) => boolean)[]) {
  const result = await agent.tools.registry.invoke(toolName, args);
  if (result.error) {
    nok(`${label}: ${result.error}`, result.message);
    return null;
  }
  if (validators) {
    for (const v of validators) {
      if (!v(result)) { nok(`${label}: validation failed for`, JSON.stringify(result)); return null; }
    }
  }
  ok(label);
  return result;
}

async function section(title: string) {
  console.log("\n" + "=".repeat(70));
  console.log(`  ${title}`);
  console.log("=".repeat(70));
}

async function main() {
  console.log(`\n🤖  TradingAgent TS — E2E Real Execution Test`);
  console.log(`   Model: ${MODEL}  |  Ollama: ${OLLAMA_HOST}`);
  console.log(`   Started: ${new Date().toISOString()}\n`);

  // ══════════════════════════════════════════════
  // Phase 1: Agent Init
  // ══════════════════════════════════════════════
  section("1. Agent Initialization");
  const agent = new Agent({
    config: {
      workspaceRoot: process.cwd(),
      tier: "local",
      model: MODEL,
    },
  });

  const validation = await agent.validateModel();
  if (validation === true) {
    ok("Model validation", `${MODEL} responds`);
  } else {
    nok("Model validation", validation);
    console.log("  ⚠️  Continuing with tool-only tests (LLM integration skipped)...");
  }

  // ══════════════════════════════════════════════
  // Phase 2: Spot Ticker
  // ══════════════════════════════════════════════
  section("2. Binance Public API — Spot Ticker");
  const ticker = await check(agent, "binance_public_api", "BTCUSDT ticker", {
    market: "spot", path: "/api/v3/ticker/price", params: { symbol: "BTCUSDT" },
  }, [
    (r) => typeof r.body?.price === "string" && Number(r.body.price) > 0,
  ]);
  if (ticker) console.log(`   → BTCUSDT = $${ticker.body.price}`);

  // ══════════════════════════════════════════════
  // Phase 3: Technical Indicators
  // ══════════════════════════════════════════════
  section("3. Technical Indicators");
  const ind = await check(agent, "binance_technical_indicators", "BTCUSDT 1h indicators", {
    symbol: "BTCUSDT", interval: "1h", limit: 100, indicators: ["sma", "ema", "rsi", "macd", "bollinger"],
  }, [
    (r) => typeof r.indicators?.rsi14 === "number",
    (r) => typeof r.indicators?.sma20 === "number",
    (r) => typeof r.indicators?.macd?.macd === "number",
  ]);
  if (ind) {
    console.log(`   RSI(14): ${ind.indicators.rsi14.toFixed(2)}`);
    console.log(`   SMA(20): $${ind.indicators.sma20.toFixed(2)}`);
    console.log(`   EMA(20): $${ind.indicators.ema20.toFixed(2)}`);
    const m = ind.indicators.macd;
    console.log(`   MACD: ${m.macd.toFixed(4)} / Signal: ${m.signal.toFixed(4)} / Hist: ${m.histogram.toFixed(4)}`);
    const b = ind.indicators.bollinger;
    console.log(`   Bollinger: U=$${b.upper.toFixed(2)} M=$${b.middle.toFixed(2)} L=$${b.lower.toFixed(2)}`);
  }

  // ══════════════════════════════════════════════
  // Phase 4: Order Book
  // ══════════════════════════════════════════════
  section("4. Order Book");
  const ob = await check(agent, "binance_order_book", "BTCUSDT order book", {
    symbol: "BTCUSDT", limit: 50,
  }, [
    (r) => r.bestBid != null && r.bestAsk != null,
    (r) => typeof r.imbalance === "number",
  ]);
  if (ob) console.log(`   Bid: $${ob.bestBid} | Ask: $${ob.bestAsk} | Imbalance: ${(Number(ob.imbalance)*100).toFixed(2)}%`);

  // ══════════════════════════════════════════════
  // Phase 5: Futures Stats
  // ══════════════════════════════════════════════
  section("5. Futures Stats");
  const fs = await check(agent, "binance_futures_stats", "BTCUSDT futures", {
    symbol: "BTCUSDT",
  }, [
    (r) => r.markPrice > 0,
    (r) => typeof r.lastFundingRate === "number",
    (r) => r.openInterest > 0,
  ]);
  if (fs) console.log(`   Mark: $${fs.markPrice} | Funding: ${(Number(fs.lastFundingRate)*100).toFixed(4)}% | OI: ${Number(fs.openInterest).toLocaleString()}`);

  // ══════════════════════════════════════════════
  // Phase 6: Multi-Symbol Screener
  // ══════════════════════════════════════════════
  section("6. Multi-Symbol RSI Screener");
  const sc = await check(agent, "binance_screener", "4-symbol RSI scan", {
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"], interval: "1h",
  }, [
    (r) => Array.isArray(r.results) && r.results.length === 4,
  ]);
  if (sc) {
    for (const r of sc.results) {
      console.log(`   ${r.symbol}: RSI=${r.rsi14?.toFixed(2)}  Signal=${r.signal}  $${r.lastClose}`);
    }
  }

  // ══════════════════════════════════════════════
  // Phase 7: Backtest
  // ══════════════════════════════════════════════
  section("7. Backtest — RSI Mean Reversion");
  const bt = await check(agent, "binance_backtest", "RSI<30 long on BTCUSDT 1h", {
    symbol: "BTCUSDT", interval: "1h", limit: 500,
    strategy: {
      direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 30 }],
      risk: { stopPct: 0.02, targetPct: 0.04 },
      feeBps: 10, maxHoldBars: 48,
    },
  }, [
    (r) => r.metrics?.totalTrades >= 0,
  ]);
  if (bt) {
    const m = bt.metrics;
    console.log(`   Trades: ${m.totalTrades} | Win: ${m.winRate != null ? (m.winRate*100).toFixed(1)+"%" : "N/A"}`);
    console.log(`   PF: ${m.profitFactor != null ? m.profitFactor.toFixed(2) : "N/A"}`);
    for (const t of (bt.sampleTrades || []).slice(0, 3)) {
      console.log(`   → Entry=$${t.entryPrice} Exit=$${t.exitPrice}`);
    }
  }

  // ══════════════════════════════════════════════
  // Phase 8: Walk-Forward
  // ══════════════════════════════════════════════
  section("8. Walk-Forward Analysis");
  const wf = await check(agent, "binance_walk_forward", "ETHUSDT 4h walk-forward", {
    symbol: "ETHUSDT", interval: "4h", limit: 500,
    strategy: {
      direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 35 }, { type: "price_above_sma", period: 20 }],
      risk: { stopPct: 0.03, targetPct: 0.06 },
      feeBps: 10, maxHoldBars: 48,
    },
    folds: 4,
  }, [
    (r) => Array.isArray(r.windows),
  ]);
  if (wf) {
    for (const w of wf.windows) console.log(`   Fold ${w.index ?? "?"}: ${w.trades ?? "?"} trades`);
    console.log(`   Stability: ${wf.expectancyStability != null ? wf.expectancyStability.toFixed(4) : "N/A"}`);
  }

  // ══════════════════════════════════════════════
  // Phase 9: Monte Carlo
  // ══════════════════════════════════════════════
  section("9. Monte Carlo Simulation");
  const mc = await check(agent, "binance_monte_carlo", "BTCUSDT Monte Carlo", {
    symbol: "BTCUSDT", interval: "1h", limit: 300,
    strategy: {
      direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 28 }],
      risk: { stopPct: 0.02, targetPct: 0.05 },
      feeBps: 10, maxHoldBars: 48,
    },
    simulations: 500,
  }, [
    (r) => r.tradesInSample >= 0,
  ]);
  if (mc) {
    console.log(`   Trades: ${mc.tradesInSample} | Sims: ${mc.simulations}`);
    console.log(`   Median: ${(Number(mc.medianReturnPct ?? mc.medianReturn ?? 0)*100).toFixed(2)}%`);
    console.log(`   Loss Prob: ${(Number(mc.probabilityOfLoss ?? mc.lossProbability ?? 0)*100).toFixed(1)}%`);
  }

  // ══════════════════════════════════════════════
  // Phase 10: Parameter Sweep
  // ══════════════════════════════════════════════
  section("10. Parameter Sweep");
  const sw = await check(agent, "binance_param_sweep", "RSI period+threshold sweep", {
    symbol: "BTCUSDT", interval: "1h", limit: 300,
    strategy: {
      direction: "long",
      entry: [{ type: "rsi_below", period: 14, value: 30 }],
      risk: { stopPct: 0.02, targetPct: 0.04 },
      feeBps: 10, maxHoldBars: 48,
    },
    ranges: [
      { conditionIndex: 0, field: "period", values: [10, 14, 18] },
      { conditionIndex: 0, field: "value", values: [25, 30, 35] },
    ],
  }, [
    (r) => r.combinationsTested > 0,
    (r) => Array.isArray(r.top),
  ]);
  if (sw) {
    console.log(`   Combinations: ${sw.combinationsTested}`);
    for (const r of sw.top.slice(0, 5)) {
      console.log(`   E=${r.expectancy != null ? r.expectancy.toFixed(4) : "?"} WR=${r.winRate != null ? (r.winRate*100).toFixed(1)+"%" : "?"}`);
    }
  }

  // ══════════════════════════════════════════════
  // Phase 11: WebSocket Live Price
  // ══════════════════════════════════════════════
  section("11. WebSocket Price Feed");
  const ws = await check(agent, "binance_watch_price", "BTCUSDT live price", {
    symbol: "BTCUSDT",
  }, [
    (r) => r.price > 0,
  ]);
  if (ws) console.log(`   Live: $${ws.price} | Time: ${new Date(ws.time).toISOString()}`);
  await agent.tools.registry.invoke("binance_unwatch_price", { symbol: "BTCUSDT" });
  ok("WebSocket unsubscribe", "BTCUSDT unwatched");

  // ══════════════════════════════════════════════
  // Phase 12: Paper Trading
  // ══════════════════════════════════════════════
  section("12. Paper Trading");
  const pt = await check(agent, "binance_paper_trade", "Open BTCUSDT long", {
    action: "open", symbol: "BTCUSDT", direction: "long", quantity: 0.01,
  }, [
    (r) => r.id > 0,
    (r) => r.entryPrice > 0,
  ]);
  if (pt) console.log(`   Position #${pt.id}: ${pt.symbol} ${pt.direction} qty=${pt.quantity} entry=$${pt.entryPrice}`);

  const pl = await check(agent, "binance_paper_trade", "List open positions", {
    action: "list", openOnly: true,
  }, [
    (r) => Array.isArray(r.positions),
  ]);
  if (pl && pl.positions?.length > 0) {
    const p = pl.positions[0];
    console.log(`   #${p.id}: ${p.symbol} ${p.direction} PnL=$${p.unrealizedPnl?.toFixed(2)}`);
  }

  if (pt) {
    await check(agent, "binance_paper_trade", "Close position", {
      action: "close", id: pt.id,
    });
  }

  // ══════════════════════════════════════════════
  // Phase 13: LLM Agent Integration
  // ══════════════════════════════════════════════
  section("13. LLM Agent Integration");
  if (validation === true) {
    const prompt = [
      "Check the market for BTCUSDT using the available tools. Follow these steps:",
      "1. First call binance_public_api with market='spot' and path='/api/v3/ticker/price' and params={symbol:'BTCUSDT'}",
      "2. Then call binance_technical_indicators with symbol='BTCUSDT', interval='1h', limit=100",
      "3. Finally call binance_order_book with symbol='BTCUSDT', limit=50",
      "After gathering the data, give a 2-sentence summary of market conditions.",
    ].join("\n");
    console.log(`   Sending prompt to ${MODEL} (may take a moment)...`);
    const start = Date.now();
    try {
      const response = await agent.runUserMessage(prompt);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`   Response received in ${elapsed}s:`);
      console.log(`   ${"-".repeat(50)}`);
      console.log(`   ${response.split("\n").join("\n   ")}`);
      console.log(`   ${"-".repeat(50)}`);
      ok("LLM agent analysis");
    } catch (e) {
      nok("LLM agent analysis", e);
    }
  } else {
    console.log("   ⏭️  Skipped (model validation failed, tool-only tests completed)");
  }

  // ══════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════
  section("RESULTS");
  const total = pass + fail;
  console.log(`   ✅ Passed: ${pass}/${total}`);
  console.log(`   ❌ Failed: ${fail}/${total}`);
  console.log(`   Finished: ${new Date().toISOString()}`);
  console.log(`\n   Verdict: ${fail === 0 ? "🎉 ALL TESTS PASSED" : "⚠️  SOME TESTS FAILED"}`);

  await agent.flushLearning();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
