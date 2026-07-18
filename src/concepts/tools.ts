import { Tool } from '../tools/tool.js';
import { ConceptsEngine, adaptConceptsCandles } from './adapter.js';
import { Candle } from '../backtest/types.js';
import {
  calculateVolumeProfile,
  calculateVWAP,
  calculateATR,
  classifyFundingSkew,
} from 'trading-concepts-ts';

// ── Shared helpers ──

async function fetchCandles(symbol: string, interval: string, limit: number): Promise<{ candles: Candle[] } | { error: string; message: string }> {
  const url = new URL('/api/v3/klines', 'https://api.binance.com');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', String(limit));
  try {
    const response = await fetch(url, { method: 'GET' });
    const body = await response.json();
    if (!response.ok) return { error: 'BinanceApiError', message: JSON.stringify(body) };
    const rows = body as unknown[][];
    const candles: Candle[] = rows.map(row => ({
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
    return { candles };
  } catch (e) {
    return { error: 'RequestError', message: (e as Error).message };
  }
}

const CONCEPTS_CONDITION_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [
        'concepts_bullish_mss', 'concepts_bearish_mss',
        'concepts_bullish_choch', 'concepts_bearish_choch',
        'concepts_bullish_bos', 'concepts_bearish_bos',
        'concepts_bullish_ob', 'concepts_bearish_ob',
        'concepts_bullish_fvg', 'concepts_bearish_fvg',
        'concepts_bullish_breaker', 'concepts_bearish_breaker',
        'concepts_bullish_invfvg', 'concepts_bearish_invfvg',
        'concepts_buyside_sweep', 'concepts_sellside_sweep',
        'concepts_judas_swing',
        'concepts_in_premium', 'concepts_in_discount', 'concepts_in_ote',
        'concepts_confluence_gte',
        'concepts_cvd_rising', 'concepts_cvd_falling',
        'concepts_cvd_positive', 'concepts_cvd_negative',
        'concepts_above_vwap', 'concepts_below_vwap',
        'concepts_above_hvn', 'concepts_below_hvn',
        'concepts_at_poc', 'concepts_at_lvn',
      ],
    },
    value: { type: 'number', description: 'Threshold (e.g. 65 for concepts_confluence_gte)' },
    period: { type: 'number', description: 'Lookback period (not used by most concepts_* types)' },
  },
  required: ['type'],
};

function futuresBacktest(
  candles: Candle[],
  conditions: { type: string; value?: number }[],
  direction: 'long' | 'short',
  stopPct: number, targetPct: number, feeBps: number, maxHoldBars: number,
  initialCapital: number, leverage: number, marginPerTradePct: number,
  slippageBps = 0,
  entryMask?: boolean[] | null,
) {
  const engine = new ConceptsEngine(candles);
  const evaluator = engine.evaluator(conditions);
  const slipFrac = slippageBps / 10000;
  const feeFrac = feeBps / 10000;
  let capital = initialCapital;
  const eq: number[] = [capital];
  const returns: number[] = [];
  let trades = 0; let wins = 0; let losses = 0;
  let grossProfit = 0; let grossLoss = 0;

  let i = 0;
  while (i < candles.length) {
    const passesEntry = evaluator(i);
    const passesMask = !entryMask || entryMask[i] === true;
    if (!passesEntry || !passesMask) { i++; continue; }

    const rawEntry = candles[i].close;
    const entryPrice = direction === 'long' ? rawEntry * (1 + slipFrac) : rawEntry * (1 - slipFrac);
    const margin = capital * marginPerTradePct;
    const notional = margin * leverage;
    const qty = notional / entryPrice;
    const stopPrice = direction === 'long' ? entryPrice * (1 - stopPct) : entryPrice * (1 + stopPct);
    const targetPrice = direction === 'long' ? entryPrice * (1 + targetPct) : entryPrice * (1 - targetPct);
    const liqPrice = direction === 'long' ? entryPrice * (1 - 1 / leverage + 0.005) : entryPrice * (1 + 1 / leverage - 0.005);

    let exitIdx = candles.length - 1;
    let exitPrice = candles[exitIdx].close;
    for (let j = i + 1; j < candles.length && j <= i + maxHoldBars; j++) {
      const b = candles[j];
      if (direction === 'long' ? b.low <= liqPrice : b.high >= liqPrice) { exitIdx = j; exitPrice = liqPrice; break; }
      if (direction === 'long' ? b.low <= stopPrice : b.high >= stopPrice) { exitIdx = j; exitPrice = direction === 'long' ? stopPrice * (1 - slipFrac) : stopPrice * (1 + slipFrac); break; }
      if (direction === 'long' ? b.high >= targetPrice : b.low <= targetPrice) { exitIdx = j; exitPrice = targetPrice; break; }
      if (j === i + maxHoldBars) { exitIdx = j; exitPrice = direction === 'long' ? b.close * (1 - slipFrac) : b.close * (1 + slipFrac); }
    }
    const pnl = (exitPrice - entryPrice) * (direction === 'long' ? 1 : -1) * qty - notional * feeFrac;
    capital += pnl; eq.push(capital);
    const ret = pnl / margin;
    returns.push(ret);
    trades++; if (pnl > 0) { wins++; grossProfit += pnl; } else { losses++; grossLoss += Math.abs(pnl); }
    i = exitIdx + 1;
  }

  const winRate = trades > 0 ? wins / trades : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const totalPnlUsd = capital - initialCapital;
  const totalReturnPct = totalPnlUsd / initialCapital;
  const expectancyPct = trades > 0 ? returns.reduce((s, v) => s + v, 0) / trades : 0;
  let peak = initialCapital; let mdd = 0;
  for (const e of eq) { if (e > peak) peak = e; const dd = (peak - e) / peak; if (dd > mdd) mdd = dd; }
  const avgR = trades > 0 ? returns.reduce((s, v) => s + v, 0) / trades : 0;
  const variance = trades > 1 ? returns.reduce((s, v) => s + (v - avgR) ** 2, 0) / (trades - 1) : 0;
  const sharpeRatio = Math.sqrt(365 * 24) * avgR / (Math.sqrt(variance) || 1);
  const avgWinPct = wins > 0 ? returns.filter(r => r > 0).reduce((s, v) => s + v, 0) / wins : 0;
  const avgLossPct = losses > 0 ? returns.filter(r => r <= 0).reduce((s, v) => s + v, 0) / losses : 0;

  return {
    metrics: { totalTrades: trades, winRate, avgWinPct, avgLossPct, expectancyPct, profitFactor, totalReturnPct, maxDrawdownPct: mdd, totalPnlUsd, sharpeRatio },
    equityCurve: eq,
    analysis: engine.analyze(),
  };
}

// ── Tool: binance_concepts_backtest ──

export class BinanceConceptsBacktestTool extends Tool {
  get name(): string { return 'binance_concepts_backtest'; }
  get description(): string {
    return (
      'SMC/ICT concepts backtest using the trading-concepts-ts library. Entry conditions include ' +
      'Order Blocks, FVGs, Breakers, MSS/CHoCH/BOS, Liquidity Sweeps, Judas Swings, ' +
      'Premium/Discount, OTE, Confluence Scores, CVD trend, VWAP position, Volume Profile ' +
      '(HVN/LVN/POC). Optional HTF (higher-timeframe) analysis for multi-timeframe entry filtering: ' +
      'when htfInterval is provided, only entries aligning with the HTF bias are taken.'
    );
  }
  get tags(): string[] { return ['binance', 'backtest', 'concepts', 'smc', 'ict', 'multi-tf']; }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        interval: { type: 'string', description: 'e.g. 1h, 4h, 1d' },
        limit: { type: 'number', description: 'Max candles, max 1000 (default 500)' },
        direction: { type: 'string', enum: ['long', 'short'] },
        entry: { type: 'array', items: CONCEPTS_CONDITION_SCHEMA, description: 'AND of concepts_* conditions for entry trigger' },
        stopPct: { type: 'number', description: 'Stop loss fraction, e.g. 0.02 = 2%' },
        targetPct: { type: 'number', description: 'Take profit fraction, e.g. 0.04 = 4%' },
        feeBps: { type: 'number', default: 5 },
        maxHoldBars: { type: 'number', default: 96 },
        initialCapital: { type: 'number', default: 10000 },
        leverage: { type: 'number', default: 1 },
        marginPerTradePct: { type: 'number', default: 0.5 },
        slippageBps: { type: 'number', default: 0 },
        htfInterval: { type: 'string', description: 'Higher timeframe for bias filter (e.g. 4h when interval=1h). When set, entries only fire when HTF structure aligns with direction.' },
        htfLimit: { type: 'number', description: 'HTF candles to fetch, default 200' },
      },
      required: ['symbol', 'direction', 'entry', 'stopPct', 'targetPct'],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args.symbol ?? '');
    const interval = String(args.interval ?? '1h');
    const limit = Math.min(Number(args.limit ?? 500) || 500, 1000);
    const direction = args.direction as 'long' | 'short';
    const entry = args.entry as { type: string; value?: number }[];
    const stopPct = Number(args.stopPct ?? 0.02);
    const targetPct = Number(args.targetPct ?? 0.04);
    const feeBps = Number(args.feeBps ?? 5);
    const maxHoldBars = Number(args.maxHoldBars ?? 96);
    const initialCapital = Number(args.initialCapital ?? 10000);
    const leverage = Number(args.leverage ?? 1);
    const marginPerTradePct = Number(args.marginPerTradePct ?? 0.5);
    const slippageBps = Number(args.slippageBps ?? 0);
    const htfInterval = args.htfInterval as string | undefined;
    const htfLimit = Math.min(Number(args.htfLimit ?? 200) || 200, 1000);

    const fetched = await fetchCandles(symbol, interval, limit);
    if ('error' in fetched) return fetched;

    // Multi-timeframe: build HTF entry mask
    let entryMask: boolean[] | null = null;
    let htfInfo: Record<string, unknown> | null = null;
    if (htfInterval) {
      const htfFetched = await fetchCandles(symbol, htfInterval, htfLimit);
      if (!('error' in htfFetched)) {
        const htfEngine = new ConceptsEngine(htfFetched.candles);
        entryMask = htfEngine.buildEntryMask(direction);
        if (entryMask) {
          const htfAr = htfEngine.analyze();
          htfInfo = {
            interval: htfInterval,
            structure: htfAr.structure.length,
            orderBlocks: htfAr.orderBlocks.filter(ob => !ob.mitigated).length,
            fvgs: htfAr.fvgs.filter(f => !f.mitigated).length,
            maskActiveBars: entryMask.filter(Boolean).length,
          };
        }
      }
    }

    const result = futuresBacktest(
      fetched.candles, entry, direction, stopPct, targetPct,
      feeBps, maxHoldBars, initialCapital, leverage, marginPerTradePct, slippageBps,
      entryMask,
    );

    const analysis = result.analysis;

    return {
      symbol, interval, direction, leverage, initialCapital,
      candles: fetched.candles.length,
      htfFilter: htfInfo,
      metrics: {
        totalTrades: result.metrics.totalTrades,
        winRate: result.metrics.winRate,
        avgWinPct: result.metrics.avgWinPct,
        avgLossPct: result.metrics.avgLossPct,
        expectancyPct: result.metrics.expectancyPct,
        profitFactor: result.metrics.profitFactor,
        totalReturnPct: result.metrics.totalReturnPct,
        maxDrawdownPct: result.metrics.maxDrawdownPct,
        totalPnlUsd: result.metrics.totalPnlUsd,
        sharpeRatio: result.metrics.sharpeRatio,
      },
      marketState: {
        totalSwings: analysis.swings.length,
        totalStructure: analysis.structure.length,
        totalOrderBlocks: analysis.orderBlocks.filter(ob => !ob.mitigated).length,
        totalFVGs: analysis.fvgs.filter(f => !f.mitigated).length,
        totalBreakers: analysis.breakerBlocks.length,
        totalLiquidityZones: analysis.liquidity.length,
        totalSweptZones: analysis.liquidity.filter(l => l.swept).length,
        totalJudasSwings: analysis.judasSwings.length,
        totalConfluenceScores: analysis.confluenceScores.length,
        avgConfluenceScore: analysis.confluenceScores.length > 0
          ? analysis.confluenceScores.reduce((s, c) => s + c.score, 0) / analysis.confluenceScores.length
          : 0,
      },
    };
  }
}

// ── Tool: binance_concepts_analyze ──

export class BinanceConceptsAnalyzeTool extends Tool {
  get name(): string { return 'binance_concepts_analyze'; }
  get description(): string {
    return (
      'Run full SMC/ICT analysis on historical Binance data using the trading-concepts-ts library. ' +
      'Returns market structure, order blocks, FVGs, liquidity zones, Judas swings, premium/discount ' +
      'zones, and 7-pillar confluence scores. This is the "deterministic eyes" of the system.'
    );
  }
  get tags(): string[] { return ['binance', 'concepts', 'smc', 'ict', 'analysis']; }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        interval: { type: 'string', description: 'e.g. 1h, 4h, 1d' },
        limit: { type: 'number', description: 'Max candles, max 1000 (default 200)' },
      },
      required: ['symbol', 'interval'],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args.symbol ?? '');
    const interval = String(args.interval ?? '1h');
    const limit = Math.min(Number(args.limit ?? 200) || 200, 1000);

    const fetched = await fetchCandles(symbol, interval, limit);
    if ('error' in fetched) return fetched;

    const engine = new ConceptsEngine(fetched.candles);
    const analysis = engine.analyze();
    const adapted = adaptConceptsCandles(fetched.candles);

    // Volume Profile
    const vp = calculateVolumeProfile(adapted, { bins: 24, hvnPercentile: 0.7, lvnPercentile: 0.3 });

    // VWAP (latest value)
    const vwapArr = calculateVWAP(adapted, { resetDaily: false, timezoneOffsetMinutes: 0 });
    const latestVWAP = vwapArr.filter(v => v !== null && !Number.isNaN(v)).pop() ?? null;

    // ATR
    const atrArr = calculateATR(adapted, { period: 14 });
    const latestATR = atrArr.filter(a => a !== null && !Number.isNaN(a)).pop() ?? null;

    return {
      symbol, interval, candles: fetched.candles.length,
      marketStructure: analysis.structure.map(s => ({
        index: s.index, type: s.type, direction: s.direction, level: s.level,
      })),
      orderBlocks: analysis.orderBlocks.filter(ob => !ob.mitigated).map(ob => ({
        index: ob.index, direction: ob.type, price: { top: ob.top, bottom: ob.bottom },
        strength: ob.strength,
      })),
      fvgs: analysis.fvgs.filter(f => !f.mitigated).map(f => ({
        index: f.index, direction: f.type, price: { top: f.top, bottom: f.bottom },
      })),
      breakerBlocks: analysis.breakerBlocks.map(br => ({
        index: br.index, direction: br.type, price: { top: br.top, bottom: br.bottom },
      })),
      liquidity: analysis.liquidity.map(l => ({
        index: l.index, type: l.type, level: l.level, swept: l.swept,
        sweepType: l.sweepType,
      })),
      judasSwings: analysis.judasSwings.map(js => ({
        index: js.sweepIndex, direction: js.direction, session: js.session,
      })),
      premiumDiscountZones: analysis.premiumDiscountZones.map(pdz => ({
        direction: pdz.direction, high: pdz.high, low: pdz.low,
        equilibrium: pdz.equilibrium, oteZone: pdz.oteZone,
      })),
      confluenceScores: analysis.confluenceScores.slice(0, 50).map(cs => ({
        index: cs.zoneIndex, direction: cs.direction, score: cs.score, highConviction: cs.highConviction,
        breakdown: cs.breakdown,
      })),
      institutionalIndicators: {
        volumeProfile: vp ? {
          pointOfControl: vp.pointOfControl ? (vp.pointOfControl.priceLow + vp.pointOfControl.priceHigh) / 2 : null,
          highVolumeNodes: vp.highVolumeNodes.map(b => (b.priceLow + b.priceHigh) / 2),
          lowVolumeNodes: vp.lowVolumeNodes.map(b => (b.priceLow + b.priceHigh) / 2),
        } : null,
        vwap: latestVWAP,
        atr: latestATR,
      },
    };
  }
}

// ── Tool: binance_concepts_market_state ──
// Returns the exact MarketState JSON structure from the design doc for LLM reasoning.

export class BinanceConceptsMarketStateTool extends Tool {
  get name(): string { return 'binance_concepts_market_state'; }
  get description(): string {
    return (
      'Returns a structured MarketState JSON (as defined in the institutional SMC/ICT design doc) ' +
      'for the LLM reasoning layer. Analyzes HTF (bias/draw), MTF (POI), and LTF (trigger) ' +
      'simultaneously and returns a single JSON payload with all three timeframes plus ' +
      'institutional indicators (Volume Profile, VWAP, ATR). ' +
      'This is the "deterministic eyes" input for the Macro Analyst and Execution Desk agents.'
    );
  }
  get tags(): string[] { return ['binance', 'concepts', 'smc', 'ict', 'market-state', 'llm']; }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        htfInterval: { type: 'string', default: '4h', description: 'Higher timeframe for bias/draw (default 4h)' },
        mtfInterval: { type: 'string', default: '1h', description: 'Medium timeframe for POI (default 1h)' },
        ltfInterval: { type: 'string', default: '15m', description: 'Lower timeframe for triggers (default 15m)' },
        htfLimit: { type: 'number', default: 100 },
        mtfLimit: { type: 'number', default: 100 },
        ltfLimit: { type: 'number', default: 150 },
      },
      required: ['symbol'],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = String(args.symbol ?? '');
    const htfInterval = String(args.htfInterval ?? '4h');
    const mtfInterval = String(args.mtfInterval ?? '1h');
    const ltfInterval = String(args.ltfInterval ?? '15m');
    const htfLimit = Number(args.htfLimit ?? 100);
    const mtfLimit = Number(args.mtfLimit ?? 100);
    const ltfLimit = Number(args.ltfLimit ?? 150);

    // Fetch all three timeframes in parallel
    const [htfRes, mtfRes, ltfRes] = await Promise.all([
      fetchCandles(symbol, htfInterval, htfLimit),
      fetchCandles(symbol, mtfInterval, mtfLimit),
      fetchCandles(symbol, ltfInterval, ltfLimit),
    ]);

    if ('error' in htfRes) return htfRes;
    if ('error' in mtfRes) return mtfRes;
    if ('error' in ltfRes) return ltfRes;

    // Analyze HTF -> passes context to MTF -> passes context to LTF
    const htfEngine = new ConceptsEngine(htfRes.candles);
    const htfAnalysis = htfEngine.analyze();
    const htfSignals = htfEngine.getSignals();

    const mtfEngine = new ConceptsEngine(mtfRes.candles, {
      htfContext: htfEngine.toHTFContext(),
    });
    const mtfAnalysis = mtfEngine.analyze();
    const mtfSignals = mtfEngine.getSignals();

    const ltfEngine = new ConceptsEngine(ltfRes.candles, {
      htfContext: mtfEngine.toHTFContext(),
    });
    const ltfAnalysis = ltfEngine.analyze();
    const ltfSignals = ltfEngine.getSignals();

    // Build TimeframeData for each TF
    function buildTimeframeData(
      interval: string,
      analysis: typeof htfAnalysis,
      signals: typeof htfSignals,
      candles: Candle[],
    ) {
      const latestCandle = candles[candles.length - 1];
      const latestPrice = latestCandle.close;

      // Determine trend from last 3 structure signals
      const recentStructures = analysis.structure.slice(-3);
      let trend: 'bullish' | 'bearish' | 'ranging' = 'ranging';
      const bullishCount = recentStructures.filter(s => s.direction === 'bullish').length;
      const bearishCount = recentStructures.filter(s => s.direction === 'bearish').length;
      if (bullishCount > bearishCount) trend = 'bullish';
      else if (bearishCount > bullishCount) trend = 'bearish';

      // Latest structure
      const lastStruct = analysis.structure[analysis.structure.length - 1];
      const structure = lastStruct ? lastStruct.type as 'BOS' | 'CHoCH' | 'MSS' : null;

      // Draw on liquidity
      const unsweptLiq = analysis.liquidity.filter(l => !l.swept);
      const nearestBullishLiq = unsweptLiq.filter(l => l.type === 'sellside').sort((a, b) => Math.abs(a.level - latestPrice) - Math.abs(b.level - latestPrice));
      const nearestBearishLiq = unsweptLiq.filter(l => l.type === 'buyside').sort((a, b) => Math.abs(a.level - latestPrice) - Math.abs(b.level - latestPrice));
      let drawOnLiquidity = '';
      if (nearestBullishLiq.length > 0 && nearestBearishLiq.length > 0) {
        drawOnLiquidity = nearestBullishLiq[0].level < nearestBearishLiq[0].level ? 'BSL (buyside)' : 'SSL (sellside)';
      } else if (nearestBullishLiq.length > 0) {
        drawOnLiquidity = 'SSL (sellside)';
      } else if (nearestBearishLiq.length > 0) {
        drawOnLiquidity = 'BSL (buyside)';
      }

      // Premium/Discount
      const pdz = analysis.premiumDiscountZones[analysis.premiumDiscountZones.length - 1];
      let premiumDiscount: 'premium' | 'discount' | 'equilibrium' = 'equilibrium';
      if (pdz) {
        if (latestPrice > pdz.equilibrium) premiumDiscount = 'premium';
        else if (latestPrice < pdz.equilibrium) premiumDiscount = 'discount';
      }

      // POI — unmitigated OBs and FVGs in the direction of trend
      const poi: any[] = [];
      const trendDir = trend === 'bullish' ? 'bullish' : 'bearish';
      for (const ob of analysis.orderBlocks) {
        if (!ob.mitigated && ob.type === trendDir) {
          poi.push({ type: 'orderBlock', index: ob.index, price: { top: ob.top, bottom: ob.bottom }, strength: ob.strength });
        }
      }
      for (const fvg of analysis.fvgs) {
        if (!fvg.mitigated && fvg.type === trendDir) {
          poi.push({ type: 'fvg', index: fvg.index, price: { top: fvg.top, bottom: fvg.bottom } });
        }
      }

      return {
        timeframe: interval,
        trend,
        structure,
        drawOnLiquidity,
        premiumDiscount,
        poi: poi.slice(0, 5),
      };
    }

    const htf = buildTimeframeData(htfInterval, htfAnalysis, htfSignals, htfRes.candles);
    const mtf = buildTimeframeData(mtfInterval, mtfAnalysis, mtfSignals, mtfRes.candles);
    const ltf = buildTimeframeData(ltfInterval, ltfAnalysis, ltfSignals, ltfRes.candles);

    // Institutional indicators
    const adaptedHtf = adaptConceptsCandles(htfRes.candles);
    const vp = calculateVolumeProfile(adaptedHtf, { bins: 24, hvnPercentile: 0.7, lvnPercentile: 0.3 });
    const vwapArr = calculateVWAP(adaptedHtf, { resetDaily: false, timezoneOffsetMinutes: 0 });
    const atrArr = calculateATR(adaptedHtf, { period: 14 });

    const marketState = {
      symbol,
      timestamp: new Date().toISOString(),
      htf,
      mtf,
      ltf,
      indicators: {
        volumeProfile: vp ? {
          poc: vp.pointOfControl ? (vp.pointOfControl.priceLow + vp.pointOfControl.priceHigh) / 2 : 0,
          hvn: vp.highVolumeNodes.map(b => (b.priceLow + b.priceHigh) / 2),
          lvn: vp.lowVolumeNodes.map(b => (b.priceLow + b.priceHigh) / 2),
        } : null,
        vwap: vwapArr.filter(v => v !== null && !Number.isNaN(v)).pop() ?? null,
        atr: atrArr.filter(a => a !== null && !Number.isNaN(a)).pop() ?? null,
      },
      lastPrice: ltfRes.candles[ltfRes.candles.length - 1]?.close ?? 0,
      ltfSignalSummary: {
        hasLiquiditySweep: ltfAnalysis.liquidity.some(l => l.swept),
        hasMSS: ltfAnalysis.structure.some(s => s.type === 'MSS'),
        hasJudasSwing: ltfAnalysis.judasSwings.length > 0,
        hasPremiumDiscount: ltfAnalysis.premiumDiscountZones.length > 0,
        hasConfluenceScore: ltfAnalysis.confluenceScores.some(cs => cs.highConviction),
        activeSession: ltfAnalysis.killzones[ltfAnalysis.killzones.length - 1]?.session ?? '',
      },
    };

    return marketState;
  }
}
