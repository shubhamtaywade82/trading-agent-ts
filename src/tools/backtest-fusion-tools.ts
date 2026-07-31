import type { Candle } from "../backtest/types.js";
import {
  legacyBullishOb, legacyBearishOb, legacyBullishFvg, legacyBearishFvg,
  legacyBullishLiqSweep, legacyBearishLiqSweep, legacyDisplacement,
} from "../concepts/legacy-conditions.js";
import { computeLiqPrice } from "../paper-trading/symbol-position.js";

import { fetchCandlesRange } from "./backtest-fetch.js";
import { smaSeries, emaSeries, rsiSeries, macdSeries, bollingerSeries, superTrendSeries, adxSeries, ichimokuSeries } from "./indicators.js";
import { Tool } from "./tool.js";

interface StrategyConfig {
  signalType: string;
  signalPeriod?: number;
  signalValue?: number;
  stopPct: number;
  targetPct: number;
  id: string;
  label: string;
  direction: string;
}

interface Position {
  direction: "long" | "short";
  entryPrice: number;
  entryIdx: number;
  margin: number;
  notional: number;
  qty: number;
  stopPrice: number;
  targetPrice: number;
  liqPrice: number;
  baseMargin: number;
  confluences: string[];
  entryStrat: string;
}

export class BinanceSignalFusionTool extends Tool {
  get name(): string { return "binance_signal_fusion"; }
  get description(): string {
    return (
      "Multi-strategy signal fusion backtest. Runs ALL strategies per symbol in parallel. " +
      "First strategy to trigger enters the trade. Additional same-side signals while in position " +
      "add confluence (increase position size). Tracks per-strategy contribution and confluence events."
    );
  }
  override get tags(): string[] { return ["binance", "backtest", "fusion", "multi-strategy", "quant-research"]; }
  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        strategies: {
          type: "object",
          description: "Keys = symbol, value = array of strategy configs",
          properties: {},
        },
        initialCapital: { type: "number", default: 10_000 },
        leverage: { type: "number", default: 10 },
        marginPerTradePct: { type: "number", default: 0.5 },
        confluentAddPct: { type: "number", default: 0.5, description: "Additional margin fraction on confluence signal" },
        interval: { type: "string", default: "1h" },
        startTime: { type: "number" },
        endTime: { type: "number" },
      },
      required: ["strategies"],
    };
  }
  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const strategies = args["strategies"] as Record<string, StrategyConfig[]>;
    const initialCapital = Number(args["initialCapital"] ?? 10_000);
    const leverage = Number(args["leverage"] ?? 10);
    const marginPerTradePct = Number(args["marginPerTradePct"] ?? 0.5);
    const confluentAddPct = Number(args["confluentAddPct"] ?? 0.5);
    const interval = String(args["interval"] ?? "1h");
    const endTime = Number(args["endTime"] ?? Date.now());
    const startTime = Number(args["startTime"] ?? (endTime - 365 * 24 * 60 * 60 * 1000));
    const symbolData: Record<string, Candle[]> = {};
    for (const sym of Object.keys(strategies)) {
      const fetched = await fetchCandlesRange(sym, interval, startTime, endTime);
      if ("error" in fetched) return fetched;
      symbolData[sym] = fetched.candles;
    }

    // ── Pre-compute ALL indicator arrays per symbol (O(n) pass) ──
    interface PreComputed {
      closes: number[];
      rsi: Record<number, Array<number | undefined>>;
      macd: Array<{ macd: number; signal: number }>;
      bb: Array<{ upper: number; lower: number; middle: number }>;
      ema: Record<number, number[]>;
      ob_bull: boolean[]; ob_bear: boolean[];
      fvg_bull: boolean[]; fvg_bear: boolean[];
      disp_bull: boolean[]; disp_bear: boolean[];
      liq_bull: boolean[]; liq_bear: boolean[];
      liqob_bull: boolean[]; liqob_bear: boolean[];
      liqfvg_bull: boolean[]; liqfvg_bear: boolean[];
      htfShort?: boolean[]; htfLong?: boolean[];
      superTrend?: Array<{ trend: "up" | "down" }>;
      adx?: Array<{ adx: number; plusDI: number; minusDI: number }>;
      ichimoku?: Array<{ cloud: "above" | "below" | "inside" }>;
      volSma20?: number[];
    }
    const pre: Record<string, PreComputed> = {};
    for (const [sym, candles] of Object.entries(symbolData)) {
      const closes = candles.map(c => c.close);
      const n = closes.length;
      const needRsi = new Set<number>();
      const needEma = new Set<number>();
      for (const s of (strategies[sym] || [])) {
        if (s.signalType === "rsi_above" || s.signalType === "rsi_below") needRsi.add(s.signalPeriod ?? 14);
        if (s.signalType === "price_above_ema" || s.signalType === "price_below_ema") needEma.add(s.signalPeriod ?? 20);
      }
      const rsi: Record<number, Array<number | undefined>> = {};
      for (const p of needRsi) rsi[p] = rsiSeries(closes, p);
      const macd = macdSeries(closes) as Array<{ macd: number; signal: number }>;
      const bb = bollingerSeries(closes) as Array<{ upper: number; lower: number; middle: number }>;
      const ema: Record<number, number[]> = {};
      for (const p of needEma) {
        const raw = emaSeries(closes, p);
        ema[p] = [...Array.from({ length: n - raw.length }, () => NaN), ...raw];
      }
      const ob_bull = new Array<boolean>(n).fill(false);
      const ob_bear = new Array<boolean>(n).fill(false);
      const fvg_bull = new Array<boolean>(n).fill(false);
      const fvg_bear = new Array<boolean>(n).fill(false);
      const disp_bull = new Array<boolean>(n).fill(false);
      const disp_bear = new Array<boolean>(n).fill(false);
      const liq_bull = new Array<boolean>(n).fill(false);
      const liq_bear = new Array<boolean>(n).fill(false);
      const liqob_bull = new Array<boolean>(n).fill(false);
      const liqob_bear = new Array<boolean>(n).fill(false);
      const liqfvg_bull = new Array<boolean>(n).fill(false);
      const liqfvg_bear = new Array<boolean>(n).fill(false);
      for (let i = 0; i < n; i++) {
        const oB = legacyBullishOb(candles, i);
        const oS = legacyBearishOb(candles, i);
        ob_bull[i] = oB; ob_bear[i] = oS;
        fvg_bull[i] = legacyBullishFvg(candles, i);
        fvg_bear[i] = legacyBearishFvg(candles, i);
        const d = legacyDisplacement(candles, i);
        disp_bull[i] = d?.dir === "up"; disp_bear[i] = d?.dir === "down";
        liq_bull[i] = legacyBullishLiqSweep(candles, i);
        liq_bear[i] = legacyBearishLiqSweep(candles, i);
        const liqB = liq_bull[i] ?? false;
        const liqS = liq_bear[i] ?? false;
        const fvgB = fvg_bull[i] ?? false;
        const fvgS = fvg_bear[i] ?? false;
        liqob_bull[i] = liqB && oB;
        liqob_bear[i] = liqS && oS;
        liqfvg_bull[i] = liqB && fvgB;
        liqfvg_bear[i] = liqS && fvgS;
      }
      const extra: Partial<PreComputed> = {};
      for (const s of (strategies[sym] || [])) {
        if (s.signalType === "bearish_htf_trend_short") {
          extra.htfShort = new Array(n).fill(false);
          for (let i = 50; i < n; i++) {
            const c1 = closes[i - 1];
            const c2 = closes[i - 2];
            const c3 = closes[i - 3];
            const c4 = closes[i - 4];
            const c5 = closes[i - 5];
            const ci = closes[i];
            const ob = ob_bear[i];
            if (c1 === undefined || c2 === undefined || c3 === undefined || c4 === undefined || c5 === undefined || ci === undefined || ob === undefined) continue;
            const avg = (c1 + c2 + c3 + c4 + c5) / 5;
            extra.htfShort[i] = ci < avg * 0.98 && ob;
          }
        }
        if (s.signalType === "bullish_htf_trend_long") {
          extra.htfLong = new Array(n).fill(false);
          for (let i = 50; i < n; i++) {
            const c1 = closes[i - 1];
            const c2 = closes[i - 2];
            const c3 = closes[i - 3];
            const c4 = closes[i - 4];
            const c5 = closes[i - 5];
            const ci = closes[i];
            const ob = ob_bull[i];
            if (c1 === undefined || c2 === undefined || c3 === undefined || c4 === undefined || c5 === undefined || ci === undefined || ob === undefined) continue;
            const avg = (c1 + c2 + c3 + c4 + c5) / 5;
            extra.htfLong[i] = ci > avg * 1.02 && ob;
          }
        }
      }
      const needSuperTrend = (strategies[sym] || []).some(s => s.signalType === "supertrend_bullish_flip" || s.signalType === "supertrend_bearish_flip");
      const needAdx = (strategies[sym] || []).some(s => ["adx_bullish_trend", "adx_bearish_trend", "adx_di_cross_long", "adx_di_cross_short"].includes(s.signalType));
      const needIchimoku = (strategies[sym] || []).some(s => ["ichimoku_bullish_breakout", "ichimoku_bearish_breakout", "ichimoku_above_cloud_long", "ichimoku_below_cloud_short"].includes(s.signalType));
      const needVolume = (strategies[sym] || []).some(s => s.signalType === "volume_spike_long" || s.signalType === "volume_spike_short");
      if (needSuperTrend) extra.superTrend = superTrendSeries(candles, 10, 3);
      if (needAdx) extra.adx = adxSeries(candles, 14);
      if (needIchimoku) extra.ichimoku = ichimokuSeries(candles);
      if (needVolume) extra.volSma20 = smaSeries(candles.map(c => c.volume), 20);
      pre[sym] = { closes, rsi, macd, bb, ema, ob_bull, ob_bear, fvg_bull, fvg_bear, disp_bull, disp_bear, liq_bull, liq_bear, liqob_bull, liqob_bear, liqfvg_bull, liqfvg_bear, ...extra };
    }
    const positions: Record<string, Position | null> = {};
    for (const sym of Object.keys(strategies)) positions[sym] = null;
    const eqCurve: number[] = [initialCapital];
    let capital = initialCapital;
    const tradeLog: Array<Record<string, unknown>> = [];
    const stratCounts: Record<string, number> = {};
    const confluences: Record<string, number> = {};
    const feeFrac = 5 / 10_000;
    const maxLen = Math.max(...Object.values(symbolData).map(c => c.length));

    for (let i = 50; i < maxLen; i++) {
      if (i % 10 === 0) eqCurve.push(capital);
      for (const [sym, candles] of Object.entries(symbolData)) {
        if (i >= candles.length) continue;
        const ci = candles[i];
        if (ci === undefined) continue;
        const p = pre[sym];
        if (p === undefined) continue;
        const stratList = strategies[sym] || [];
        const triggered: Array<{ strat: StrategyConfig; dir: string }> = [];
        for (const s of stratList) {
          const sig = s.signalType; const per = s.signalPeriod ?? 14; const val = s.signalValue;
          let hit = false;
          switch (sig) {
          case "rsi_above": { const a = p.rsi[per]; const v = a?.[i]; hit = v !== undefined && !isNaN(v) && v > (val ?? 70); 
          break;
          }
          case "rsi_below": { const a = p.rsi[per]; const v = a?.[i]; hit = v !== undefined && !isNaN(v) && v < (val ?? 30); 
          break;
          }
          case "macd_bearish_cross": { const c = p.macd[i]; const v = p.macd[i - 1]; hit = !!c && !!v && !isNaN(c.macd) && !isNaN(v.macd) && v.macd >= v.signal && c.macd < c.signal; 
          break;
          }
          case "macd_bullish_cross": { const c = p.macd[i]; const v = p.macd[i - 1]; hit = !!c && !!v && !isNaN(c.macd) && !isNaN(v.macd) && v.macd <= v.signal && c.macd > c.signal; 
          break;
          }
          case "bollinger_touch_upper": { const b = p.bb[i]; hit = !!b && !isNaN(b.upper) && ci.close >= b.upper; 
          break;
          }
          case "bollinger_touch_lower": { const b = p.bb[i]; hit = !!b && !isNaN(b.lower) && ci.close <= b.lower; 
          break;
          }
          case "price_above_ema": { const a = p.ema[per]; const av = a?.[i]; hit = av !== undefined && !isNaN(av) && ci.close > av; 
          break;
          }
          case "price_below_ema": { const a = p.ema[per]; const av = a?.[i]; hit = av !== undefined && !isNaN(av) && ci.close < av; 
          break;
          }
          case "bearish_ob": {
          hit = p.ob_bear[i] ?? false;
          break;
          }
          case "bullish_ob": {
          hit = p.ob_bull[i] ?? false;
          break;
          }
          case "bearish_fvg": {
          hit = p.fvg_bear[i] ?? false;
          break;
          }
          case "bullish_fvg": {
          hit = p.fvg_bull[i] ?? false;
          break;
          }
          case "bearish_liq_sweep": {
          hit = p.liq_bear[i] ?? false;
          break;
          }
          case "bullish_liq_sweep": {
          hit = p.liq_bull[i] ?? false;
          break;
          }
          case "bearish_displacement": {
          hit = p.disp_bear[i] ?? false;
          break;
          }
          case "bullish_displacement": {
          hit = p.disp_bull[i] ?? false;
          break;
          }
          case "bearish_liq_ob": {
          hit = p.liqob_bear[i] ?? false;
          break;
          }
          case "bullish_liq_ob": {
          hit = p.liqob_bull[i] ?? false;
          break;
          }
          case "bearish_liq_fvg": {
          hit = p.liqfvg_bear[i] ?? false;
          break;
          }
          case "bullish_liq_fvg": {
          hit = p.liqfvg_bull[i] ?? false;
          break;
          }
          case "bearish_bos_displacement": {
          hit = p.disp_bear[i] ?? false;
          break;
          }
          case "bullish_bos_displacement": {
          hit = p.disp_bull[i] ?? false;
          break;
          }
          case "bearish_htf_trend_short": {
          hit = p.htfShort?.[i] ?? false;
          break;
          }
          case "bullish_htf_trend_long": {
          hit = p.htfLong?.[i] ?? false;
          break;
          }
          case "supertrend_bullish_flip": {
          hit = i > 0 && p.superTrend?.[i]?.trend === "up" && p.superTrend?.[i - 1]?.trend === "down";
          break;
          }
          case "supertrend_bearish_flip": {
          hit = i > 0 && p.superTrend?.[i]?.trend === "down" && p.superTrend?.[i - 1]?.trend === "up";
          break;
          }
          case "adx_bullish_trend": { const a = p.adx?.[i]; hit = !!a && !isNaN(a.adx) && a.adx > (val ?? 25) && a.plusDI > a.minusDI; 
          break;
          }
          case "adx_bearish_trend": { const a = p.adx?.[i]; hit = !!a && !isNaN(a.adx) && a.adx > (val ?? 25) && a.minusDI > a.plusDI; 
          break;
          }
          case "ichimoku_bullish_breakout": {
          hit = i > 0 && p.ichimoku?.[i]?.cloud === "above" && p.ichimoku?.[i - 1]?.cloud !== "above";
          break;
          }
          case "ichimoku_bearish_breakout": {
          hit = i > 0 && p.ichimoku?.[i]?.cloud === "below" && p.ichimoku?.[i - 1]?.cloud !== "below";
          break;
          }
          case "ichimoku_above_cloud_long": {
          hit = p.ichimoku?.[i]?.cloud === "above";
          break;
          }
          case "ichimoku_below_cloud_short": {
          hit = p.ichimoku?.[i]?.cloud === "below";
          break;
          }
          case "adx_di_cross_long": { const a = p.adx?.[i]; const pv = p.adx?.[i - 1]; hit = i > 0 && !!a && !!pv && !isNaN(a.adx) && a.adx > (val ?? 20) && a.plusDI > a.minusDI && pv.plusDI <= pv.minusDI; 
          break;
          }
          case "adx_di_cross_short": { const a = p.adx?.[i]; const pv = p.adx?.[i - 1]; hit = i > 0 && !!a && !!pv && !isNaN(a.adx) && a.adx > (val ?? 20) && a.minusDI > a.plusDI && pv.minusDI <= pv.plusDI; 
          break;
          }
          case "volume_spike_long": { const vs = p.volSma20?.[i]; hit = vs !== undefined && !isNaN(vs) && ci.volume > vs * 2 && ci.close > ci.open; 
          break;
          }
          case "volume_spike_short": { const vs = p.volSma20?.[i]; hit = vs !== undefined && !isNaN(vs) && ci.volume > vs * 2 && ci.close < ci.open; 
          break;
          }
          // No default
          }
          if (hit) triggered.push({ strat: s, dir: s.direction });
        }
        if (triggered.length === 0) continue;
        const pos = positions[sym];
        if (!pos) {
          const t = triggered[0];
          if (t === undefined) continue;
          const ep = ci.close;
          if (capital <= 0) continue;
          const baseMargin = Math.min(capital * marginPerTradePct, capital * 0.5);
          const notional = baseMargin * leverage;
          const qty = notional / ep;
          const dir = t.dir as "long" | "short";
          const sp = dir === "long" ? ep * (1 - t.strat.stopPct) : ep * (1 + t.strat.stopPct);
          const tp = dir === "long" ? ep * (1 + t.strat.targetPct) : ep * (1 - t.strat.targetPct);
          const liq = computeLiqPrice(dir, ep, leverage);
          positions[sym] = { direction: dir, entryPrice: ep, entryIdx: i, margin: baseMargin, notional, qty, stopPrice: sp, targetPrice: tp, liqPrice: liq, baseMargin, confluences: [], entryStrat: t.strat.id || t.strat.label };
          stratCounts[t.strat.id || t.strat.label] = (stratCounts[t.strat.id || t.strat.label] || 0) + 1;
          tradeLog.push({ type: "entry", sym, time: new Date(ci.openTime).toISOString(), dir, price: ep, strat: t.strat.label, margin: baseMargin });
        } else {
          const sameSide = triggered.filter(t => t.dir === pos.direction);
          for (const t of sameSide) {
            const sig = t.strat.signalType;
            const isTrivialFilter = sig === "price_below_ema" || sig === "price_above_ema" || sig === "bollinger_touch_upper" || sig === "bollinger_touch_lower";
            if (isTrivialFilter) continue;
            const key = `confluence:${t.strat.label}`;
            confluences[key] = (confluences[key] || 0) + 1;
            if (pos.confluences.length < 3) {
              const addMargin = pos.baseMargin * confluentAddPct;
              const addNotional = addMargin * leverage;
              pos.margin += addMargin;
              pos.notional += addNotional;
              pos.qty += addNotional / ci.close;
              pos.confluences.push(t.strat.label);
              tradeLog.push({ type: "confluence_add", sym, time: new Date(ci.openTime).toISOString(), dir: pos.direction, price: ci.close, strat: t.strat.label, addMargin });
            }
          }
        }
      }

      for (const [sym, pos] of Object.entries(positions)) {
        if (!pos) continue;
        const candles = symbolData[sym];
        if (candles === undefined) continue;
        if (i >= candles.length) continue;
        const bar = candles[i];
        if (bar === undefined) continue;
        const dir = pos.direction;
        const hitLiq = dir === "long" ? bar.low <= pos.liqPrice : bar.high >= pos.liqPrice;
        const hitStop = dir === "long" ? bar.low <= pos.stopPrice : bar.high >= pos.stopPrice;
        const hitTarget = dir === "long" ? bar.high >= pos.targetPrice : bar.low <= pos.targetPrice;
        if (hitLiq || hitStop || hitTarget || i - pos.entryIdx >= 48) {
          let xp: number; let reason: string;
          if (hitLiq) { xp = pos.liqPrice; reason = "liquidation"; }
          else if (hitStop) { xp = pos.stopPrice; reason = "stop"; }
          else if (hitTarget) { xp = pos.targetPrice; reason = "target"; }
          else { xp = bar.close; reason = "timeout"; }
          const entryNotional = pos.qty * pos.entryPrice;
          const exitNotional = pos.qty * xp;
          const totalFee = (entryNotional + exitNotional) * feeFrac;
          const pnl = (xp - pos.entryPrice) * (dir === "long" ? 1 : -1) * pos.qty - totalFee;
          capital += pnl; if (capital < 0) capital = 0;
          tradeLog.push({ type: "exit", sym, time: new Date(bar.openTime).toISOString(), dir, price: xp, reason, pnl: Math.round(pnl * 100) / 100, entryStrat: pos.entryStrat, confluences: pos.confluences.length });
          positions[sym] = null;
        }
      }
    }

    for (const [sym, pos] of Object.entries(positions)) {
      if (!pos) continue;
      const candles = symbolData[sym];
      if (candles === undefined) continue;
      const last = candles.at(-1);
      if (last === undefined) continue;
      const xp = last.close;
      const entryNotional = pos.qty * pos.entryPrice;
      const exitNotional = pos.qty * xp;
      const totalFee = (entryNotional + exitNotional) * feeFrac;
      const pnl = (xp - pos.entryPrice) * (pos.direction === "long" ? 1 : -1) * pos.qty - totalFee;
      capital += pnl; if (capital < 0) capital = 0;
      positions[sym] = null;
    }
    const totalPnl = capital - initialCapital;
    let peak = initialCapital; let mdd = 0;
    for (const e of eqCurve) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > mdd) mdd = dd; }

    return {
      initialCapital, finalCapital: Math.round(capital * 100) / 100,
      totalReturnPct: totalPnl / initialCapital,
      totalPnlUsd: Math.round(totalPnl * 100) / 100,
      maxDrawdownPct: mdd,
      totalTrades: tradeLog.filter(t => t["type"] === "entry").length,
      trades: tradeLog,
      strategyEntryCounts: stratCounts,
      confluenceEvents: confluences,
    };
  }
}
