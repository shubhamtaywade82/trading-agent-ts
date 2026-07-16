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
- Indicators: SMA, EMA, RSI, MACD, Bollinger Bands, ATR, SuperTrend, ADX (+DI/-DI), Ichimoku Cloud
  (src/tools/indicators.ts)

### Signal Types Available
rsi_above, rsi_below, macd_bearish_cross, macd_bullish_cross, bollinger_touch_upper,
bollinger_touch_lower, price_above_ema, price_below_ema, bearish_ob, bullish_ob,
bearish_fvg, bullish_fvg, bearish_liq_sweep, bullish_liq_sweep, bearish_displacement,
bullish_displacement, bearish_liq_ob, bullish_liq_ob, bearish_liq_fvg, bullish_liq_fvg,
bearish_bos_displacement, bullish_bos_displacement, bearish_htf_trend_short,
bullish_htf_trend_long, supertrend_bullish_flip, supertrend_bearish_flip,
adx_bullish_trend, adx_bearish_trend, ichimoku_bullish_breakout, ichimoku_bearish_breakout,
vol_spike_short (custom), liq_sweep_short (custom)

### Registration
All tools registered in src/cli/agent-tools.ts via AgentToolManager.registerBaseTools()

## Research Findings (docs/research.md)

### Multi-timeframe sweep (2026-07-16)
Script: scripts/mega-sweep.ts — 14 strategies × 3 symbols × 7 timeframes (5m/15m/30m/1h/2h/4h/1d)
× 4-5 stop%/target% combos × strategy params. ~23,000 backtest configs total.

Default params: $10k capital, 10x leverage, 10% margin/trade, 5bps fee, maxHold 48 bars.

### Best per-symbol setups

**XRPUSDT** (strongest short-side edge overall):
- Liq Sweep Short 2h: 37 trades, 89% WR, SR 94.7, $6,988, 4% DD
- Liq Sweep Short 15m: 70 trades, 69% WR, SR 58.0, $6,258, 3% DD
- SuperTrend Short 1d (7,1): 30 trades, 73% WR, SR 65.0, $34,809, 18% DD
- ADX-DI Cross Short 30m (14,25): 127 trades, 56% WR, SR 27.2, $14,102, 12% DD
- Bearish FVG Short 1h: 200 trades, 52% WR, SR 16.9, $22,179, 21% DD
- Ichimoku Below Cloud Short 4h: 188 trades, 45% WR, SR 19.1, $18,588, 25% DD
- CONFLUENCE Liq Sweep+Ichimoku 2h: 19 trades, 95% WR, SR 137.6, $3,725, 3% DD
- CONFLUENCE FVG+Vol Spike 1h: 68 trades, 56% WR, SR 27.2, $10,097, 11% DD
- Volume Spike Short 4h (3x,20): 16 trades, 63% WR, SR 48.7, $6,530, 8% DD
- BB Bounce Short 2h (15,2): 83 trades, 45% WR, SR 22.2, $9,840, 16% DD
- RSI MR Short 15m (14,80): 20 trades, 60% WR, SR 42.8, $1,833, 3% DD

**ETHUSDT**:
- Liq Sweep Short 2h: 44 trades, 59% WR, SR 45.3, $3,663, 2% DD
- SuperTrend Short 1d (10,1.2): 30 trades, 70% WR, SR 53.1, $7,070, 3% DD
- Volume Spike Short 4h (3x,15): 22 trades, 77% WR, SR 52.0, $3,882, 8% DD
- Volume Spike Short 1d (1.5x,20): 38 trades, 74% WR, SR 41.9, $8,892, 12% DD
- Liq Sweep+FVG Long 4h: 17 trades, 71% WR, SR 44.3, $3,060, 4% DD (BEST LONG)
- CONFLUENCE Liq Sweep+Ichimoku 1h: 25 trades, 56% WR, SR 58.7, $4,553, 4% DD
- CONFLUENCE Ichi+Vol Spike 2h: 82 trades, 76% WR, SR 26.0, $6,585, 12% DD
- Bearish FVG Short 2h: 120 trades, 45% WR, SR 10.0, $6,021, 26% DD
- ADX-DI Cross Short 4h (14,20): 65 trades, 52% WR, SR 18.1, $4,782, 25% DD

**SOLUSDT**:
- Liq Sweep Short 2h: 32 trades, 72% WR, SR 75.6, $4,179, 2% DD
- Liq Sweep Short 30m: 49 trades, 61% WR, SR 42.3, $9,489, 11% DD
- Volume Spike Short 1d (1.5x,20): 33 trades, 64% WR, SR 56.5, $7,594, 6% DD (BEST SOL SWING)
- Volume Spike Short 1d (1.5x,15): 38 trades, 63% WR, SR 55.5, $8,961, 6% DD
- SuperTrend Short 1d (7,1.2): 25 trades, 60% WR, SR 36.2, $15,075, 26% DD
- SuperTrend Long 4h (14,1.2): 84 trades, 46% WR, SR 22.7, $7,656, 13% DD (BEST LONG)
- Ichimoku Below Cloud Short 4h: 268 trades, 41% WR, SR 11.3, $9,591, 27% DD
- ADX-DI Cross Short 4h (14,25): 56 trades, 64% WR, SR 24.2, $6,671, 12% DD
- Bearish FVG Short 4h: 108 trades, 39% WR, SR 15.3, $11,075, 28% DD
- CONFLUENCE Ichi+ADX 1h (14,20): 86 trades, 64% WR, SR 27.6, $5,869, 10% DD
- RSI MR Short 4h (14,75): 15 trades, 67% WR, SR 49.2, $2,058, 4% DD

### Key Multi-TF Insights
1. **Liq Sweep Short** works at ALL timeframes on all 3 symbols — the most robust strategy.
   Best WR on 2h, highest frequency on 15m.
2. **SuperTrend** works ONLY on 1d timeframe — fails on all shorter TFs (<1d) because
   multiplier=1 is too narrow for noise but multiplier>1 produces 0 flips.
3. **Volume Spike** works on all TFs but QUALITY improves with higher multiplier (3x) and
   longer TF (4h-1d). Short-term volume spikes are noise.
4. **Confluence** (dual-signal) dramatically improves WR but reduces trade count 50-80%.
   Liq Sweep + Ichimoku at 2h on XRP = 95% WR, the highest quality signal found.
5. **SOL has NO viable high-frequency intraday strategy** — only ~50 trades/yr at best.
   Volume Spike on 1d or Liq Sweep on 2h are the only reliable edges.
6. **XRP short-side is the strongest** across ALL strategy families at all TFs.
7. **ETH has the best long-side strategy** (Liq Sweep + FVG Long, 4h, SR 44.3).

### Strategy-TF mapping

| Trading Style | TF | Best Strategies |
|---|---|---|
| Scalping (intra-hour) | 5m-15m | Liq Sweep, RSI MR, ADX-DI Cross |
| Day trading (daily) | 30m-1h | Liq Sweep, Bearish FVG, Confluence combos |
| Swing trading (2-7 days) | 2h-4h | Liq Sweep, Ichimoku Cloud, Volume Spike, BB Bounce |
| Position trading (weeks) | 1d | SuperTrend, Volume Spike, ADX-DI Cross |

### Known Issues
- All results at 10x/10% margin — divide PnL by ~4 for realistic 5x/5% sizing
- Slippage not modeled — especially impacts 5m-15m results
- No walk-forward/out-of-sample validation
- Parameter overfitting risk per TF per symbol
- 1d results use 2 years data, shorter TFs use 60-365 days
- Confluence with <15 trades/yr is statistically fragile despite high Sharpe

## Next Moves
1. Walk-forward validation on top strategies per TF
2. Correlation analysis between signals across TFs
3. Test slippage model (3-10bps) impact on 5m-15m results
4. Paper-trade the best per-symbol setups at realistic sizing
5. Add condition types for vol_spike, confluence signals to runFuturesBacktest engine
6. Cross-TF confluence (signal on 1h confirmed by 4h trend)

## Files (absolute paths)
- /home/nemesis/project/ai-workspace/trading-agent-ts/strategies.json — multi-TF strategy catalog
- /home/nemesis/project/ai-workspace/trading-agent-ts/docs/research.md — full research doc
- /home/nemesis/project/ai-workspace/trading-agent-ts/src/tools/backtest-tools.ts — engine + tools
- /home/nemesis/project/ai-workspace/trading-agent-ts/src/tools/indicators.ts — TA math
- /home/nemesis/project/ai-workspace/trading-agent-ts/scripts/mega-sweep.ts — multi-TF sweep
- /home/nemesis/project/ai-workspace/trading-agent-ts/scripts/new-strats-backtest.ts — strategy bt
- /home/nemesis/project/ai-workspace/trading-agent-ts/scripts/param-sweep.ts — parameter sweep
- /home/nemesis/project/ai-workspace/trading-agent-ts/scripts/st-backtest.ts — supertrend bt
- /home/nemesis/project/ai-workspace/trading-agent-ts/scripts/research-all-strategies.ts — init research

## Build / Test
- Build: npm run build (tsc, clean)
- Test: npm test (Jest, 64 suites / 468 tests)
- E2E: npx tsx e2e-test.ts (16 phases, all pass)
- Sweep all: npx tsx scripts/mega-sweep.ts
```

Copy this entire block into the new conversation.
