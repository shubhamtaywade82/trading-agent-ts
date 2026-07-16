# Continuation Prompt — Crypto Futures Intraday Strategy Research

Copy the entire block below into a new conversation:

---

```
You are continuing a quantitative research session on SOLUSDT / ETHUSDT / XRPUSDT crypto futures
intraday strategies. The repo is at /home/nemesis/project/ai-workspace/trading-agent-ts.

## Completed Work

### Tools Built
- BinanceFuturesBacktestTool — futures backtest with leverage (1-125x), capital tracking,
  liquidation, margin-per-trade (src/tools/backtest-tools.ts)
- BinanceFuturesSweepTool — parameter grid search over stop%/target%/entry thresholds/periods
  (src/tools/backtest-tools.ts)
- BinanceSignalFusionTool — multi-strategy per-symbol signal fusion backtest: all strategies
  run in parallel, first-to-fire entry, same-side confluence reinforces position (+50% size,
  capped 3 adds). Filters out trivial signals (EMA, BB) for confluence. (src/tools/backtest-tools.ts)
- SMC/ICT detectors: swing highs/lows, Order Blocks, Fair Value Gaps, Liquidity Sweeps,
  Displacement, HTF trend filter (inline in backtest-tools.ts)
- fetchCandlesRange() — multi-batch Binance kline fetcher supporting 1yr+ lookback
  (backtest-tools.ts:275)
- Indicators: SMA, EMA, RSI, MACD, Bollinger Bands (src/tools/indicators.ts)

### Signal Types Available (for entry conditions)
rsi_above, rsi_below, macd_bearish_cross, macd_bullish_cross, bollinger_touch_upper,
bollinger_touch_lower, price_above_ema, price_below_ema, bearish_ob, bullish_ob,
bearish_fvg, bullish_fvg, bearish_liq_sweep, bull_liq_sweep, bearish_displacement,
bullish_displacement, bearish_liq_ob, bullish_liq_ob, bearish_liq_fvg, bullish_liq_fvg,
bearish_bos_displacement, bullish_bos_displacement, bearish_htf_trend_short,
bullish_htf_trend_long

### Registration
All tools registered in src/cli/agent-tools.ts via AgentToolManager.registerBaseTools()

## Research Findings (docs/research.md)

### Test parameters
- Timeframes: 15m (alpha hunt), 1h (sweep/fusion)
- $10k capital, 10x leverage, 5bps fee, 1-3% stop, 2-12% target
- Real Binance klines via REST API

### Per-symbol profitable strategies (strategies.json)

**XRPUSDT (all short-side, Sharpe 13-35):**
- Liq Sweep + OB Short (ICT): 57% WR, 16.67 PF, 14 trades, +$93k
- Liq Sweep Short: 40% WR, 14.65 PF, 10 trades, +$56k
- Liq Sweep + FVG Short: 36% WR, 12.60 PF, 11 trades, +$53k
- RSI>80 Short MR: 41% WR, 3.28 PF, 22 trades, +$37k
- MACD Bearish Cross Short: 45% WR, 1.25 PF, 113 trades, +$145k
- Price<EMA20 Short: 44% WR, 1.18 PF, 194 trades, +$68k
- Bollinger Upper Touch Short: 33% WR, 1.22 PF, 132 trades, +$36k
- Liq Sweep + FVG Long: 40% WR, 1.14 PF, 70 trades, +$4k

**ETHUSDT:**
- Bearish FVG Short (highest WR): 73% WR, 6.06 PF, 11 trades, +$30k
- Liq Sweep + FVG Long (BEST LONG overall): 52% WR, 1.75 PF, 67 trades, +$36k
- Liq Sweep Short: 50% WR, 3.09 PF, 20 trades, +$19k
- RSI>80 Short MR: 48% WR, 1.58 PF, 29 trades, +$23k

**SOLUSDT:**
- HTF Trend + OB Short: 69% WR, 5.79 PF, 16 trades, +$98k
- Bearish Displacement Short: 56% WR, 5.06 PF, 16 trades, +$37k
- RSI>75 Short MR: 38% WR, 1.08 PF, 40 trades, +$2k
- Liq Sweep + FVG Long: 41% WR, 1.18 PF, 83 trades, +$6k

### Signal Fusion Results (1yr, 10% margin/trade)
| Symbol | Entries | PnL | WR |
|--------|---------|-----|----|
| XRPUSDT | 322 | +$2,422,419 | 38% |
| ETHUSDT | 426 | +$575,622 | 56% |
| SOLUSDT | 321 | +$529,112 | 40% |
| Total | 1069 | +$3,571,526 | 44% |

Max DD: 65%. All 3 symbols profitable in fusion mode. XRP dominates at 68% of total.

### Key Insights
- XRPUSDT shows the strongest and most consistent short-side edge across ALL strategy types
- SMC/ICT combos have highest Sharpe but low trade counts (10-20/yr)
- ETH is the only symbol with a viable long-side ICT strategy
- SOL requires combo/HFT trend signals — simple TA doesn't work
- Confluence from displacement, liquidity sweeps, FVGs adds meaningful size
- 50% margin at 10x blows up (too aggressive); 10% margin survives

### Known Issues
- MDD tracker reports 0% for some SMC strategies — bug in peak tracking
- Slippage not modeled (entries/exits at close price)
- No walk-forward validation done yet on fusion strategies
- Regime dependence: 2024-2025 data only

## Next Moves (What To Do Next)
1. Run walk-forward validation on the top fusion strategies to confirm robustness
2. Add the SMC/ICT signals as proper agent tools for ongoing signal generation
3. Run out-of-sample test on 2023 data (or earlier) to check regime stability
4. Build a paper trading mode with the fusion strategy set
5. Add slippage and fill modeling to the backtest engine
6. Run correlation analysis between strategy signals to identify independent alpha sources
7. Test on additional symbols (BTCUSDT, BNBUSDT, ADAUSDT)

## Files (absolute paths)
- /home/nemesis/project/ai-workspace/trading-agent-ts/strategies.json
- /home/nemesis/project/ai-workspace/trading-agent-ts/docs/research.md
- /home/nemesis/project/ai-workspace/trading-agent-ts/alpha-hunt.ts
- /home/nemesis/project/ai-workspace/trading-agent-ts/src/tools/backtest-tools.ts
- /home/nemesis/project/ai-workspace/trading-agent-ts/src/tools/indicators.ts
- /home/nemesis/project/ai-workspace/trading-agent-ts/src/cli/agent-tools.ts
- /home/nemesis/project/ai-workspace/trading-agent-ts/src/backtest/engine.ts
- /home/nemesis/project/ai-workspace/trading-agent-ts/scripts/run-fusion-backtest.ts

## Build / Test
- Build: npm run build (tsc)
- Test: npm test (Jest, 64 suites / 468 tests)
- E2E: npx tsx e2e-test.ts (16 phases, all pass)
- Run fusion backtest: npx tsx scripts/run-fusion-backtest.ts
```

Copy this entire block into the new conversation.
