export const CONDITION_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: [
        "rsi_below", "rsi_above", "price_above_sma", "price_below_sma",
        "price_above_ema", "price_below_ema", "macd_bullish_cross",
        "macd_bearish_cross", "bollinger_touch_lower", "bollinger_touch_upper",
        "bearish_ob", "bullish_ob", "bearish_fvg", "bullish_fvg",
        "bearish_liq_sweep", "bullish_liq_sweep", "bearish_displacement", "bullish_displacement",
        "bearish_liq_ob", "bullish_liq_ob", "bearish_liq_fvg", "bullish_liq_fvg",
        "bearish_htf_trend_short", "bullish_htf_trend_long",
        "supertrend_bullish_flip", "supertrend_bearish_flip",
        "adx_bullish_trend", "adx_bearish_trend", "adx_di_cross_long", "adx_di_cross_short",
        "ichimoku_bullish_breakout", "ichimoku_bearish_breakout",
        "ichimoku_above_cloud_long", "ichimoku_below_cloud_short",
        "volume_spike_long", "volume_spike_short",
        "ob_retest_long", "ob_retest_short",
        "oi_bearish_divergence", "oi_bullish_divergence",
      ],
    },
    period: { type: "number", description: "Indicator period, e.g. 14 for RSI, 20 for SMA/EMA/Bollinger" },
    value: { type: "number", description: "Threshold, e.g. 30 for rsi_below" },
  },
  required: ["type"],
};

export const STRATEGY_SCHEMA = {
  type: "object",
  properties: {
    direction: { type: "string", enum: ["long", "short"] },
    entry: { type: "array", items: CONDITION_SCHEMA, description: "AND of conditions — all must be true to enter" },
    risk: {
      type: "object",
      properties: { stopPct: { type: "number", description: "e.g. 0.02 for 2%" }, targetPct: { type: "number" } },
      required: ["stopPct", "targetPct"],
    },
    feeBps: { type: "number", description: "Round-trip fee in basis points, default 10 (0.1%)" },
    maxHoldBars: { type: "number", description: "Force-exit after N candles, default 200" },
  },
  required: ["direction", "entry", "risk"],
};
