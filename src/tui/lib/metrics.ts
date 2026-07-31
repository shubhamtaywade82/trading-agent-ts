import type { PositionFill } from "../../paper-trading/symbol-position.js";

export interface ReconciledMetrics {
  sessionRealized: number;
  sessionTrades: number;
  sessionWins: number;
  sessionWinRate: number | null;
  lifetimeRealized: number;
  lifetimeTrades: number;
  lifetimeWins: number;
  lifetimeWinRate: number | null;
  unrealizedPnl: number;
  marginUsed: number;
  marginPct: number;
  drawdownPct: number;
}

export function reconcileMetrics(
  fills: PositionFill[],
  positions: { marginRequired?: number; unrealizedPnl?: number }[],
  currentEquity: number,
  peakEquity: number,
  sessionStartTime: number,
): ReconciledMetrics {
  let sessionRealized = 0;
  let sessionTrades = 0;
  let sessionWins = 0;

  let lifetimeRealized = 0;
  let lifetimeTrades = 0;
  let lifetimeWins = 0;

  for (const f of fills) {
    if (f.realizedPnl !== 0) {
      lifetimeRealized += f.realizedPnl;
      lifetimeTrades++;
      if (f.realizedPnl > 0) lifetimeWins++;

      if (f.entryTimeAtFill && f.entryTimeAtFill >= sessionStartTime) {
        sessionRealized += f.realizedPnl;
        sessionTrades++;
        if (f.realizedPnl > 0) sessionWins++;
      }
    }
  }

  const unrealizedPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
  const marginUsed = positions.reduce((sum, p) => sum + (p.marginRequired ?? 0), 0);
  const marginPct = currentEquity > 0 ? (marginUsed / currentEquity) * 100 : 0;
  const drawdownPct = peakEquity > 0 ? Math.max(0, ((peakEquity - currentEquity) / peakEquity) * 100) : 0;

  return {
    sessionRealized,
    sessionTrades,
    sessionWins,
    sessionWinRate: sessionTrades > 0 ? sessionWins / sessionTrades : null,
    lifetimeRealized,
    lifetimeTrades,
    lifetimeWins,
    lifetimeWinRate: lifetimeTrades > 0 ? lifetimeWins / lifetimeTrades : null,
    unrealizedPnl,
    marginUsed,
    marginPct,
    drawdownPct,
  };
}
