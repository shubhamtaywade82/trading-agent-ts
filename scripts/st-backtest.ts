import { superTrendSeries } from "../src/tools/indicators.js";
import type { CandleHL } from "../src/tools/indicators.js";
import { parseKlineRows } from "../src/backtest/types.js";

async function fetchRange(symbol: string, interval: string, days: number) {
  const all: any[] = [];
  let from = Date.now() - days * 24 * 60 * 60 * 1000;
  const end = Date.now();
  while (from < end) {
    const url = new URL("/api/v3/klines", "https://api.binance.com");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("startTime", String(from));
    const resp = await fetch(url);
    const rows = await resp.json() as unknown[][];
    if (rows.length === 0) break;
    all.push(...rows);
    from = Number(rows[rows.length - 1][0]) + 1;
    await new Promise(r => setTimeout(r, 50));
  }
  return parseKlineRows(all);
}

interface Trade {
  entryBar: number;
  exitBar: number;
  entryPrice: number;
  exitPrice: number;
  side: "long" | "short";
  pnlPct: number;
  closeTime: number;
}

function backtestST(candles: any[], period: number, mult: number) {
  const st = superTrendSeries(candles as CandleHL[], period, mult);
  const trades: Trade[] = [];
  let openTrade: Trade | null = null;
  const capital = 10000;
  const leverage = 10;
  const fee = 0.0005;

  for (let i = period + 2; i < st.length; i++) {
    if (st[i].trend !== st[i - 1].trend) {
      // Close any open trade
      if (openTrade) {
        const direction = st[i].trend === "up" ? "long" : "short";
        if (openTrade.side !== direction) {
          openTrade.exitBar = i;
          openTrade.exitPrice = candles[i].close;
          const rawReturn = direction === "long"
            ? (candles[i].close - openTrade.entryPrice) / openTrade.entryPrice
            : (openTrade.entryPrice - candles[i].close) / openTrade.entryPrice;
          openTrade.pnlPct = rawReturn * leverage - 2 * fee;
          openTrade.closeTime = candles[i].openTime;
          trades.push(openTrade);
          openTrade = null;
        }
      }

      // Open new trade in the new direction
      const side = st[i].trend === "up" ? "long" : "short";
      openTrade = {
        entryBar: i,
        exitBar: 0,
        entryPrice: candles[i].close,
        exitPrice: 0,
        side,
        pnlPct: 0,
        closeTime: 0,
      };
    }
  }

  // Close any open trade at end
  if (openTrade) {
    openTrade.exitBar = st.length - 1;
    openTrade.exitPrice = candles[candles.length - 1].close;
    const rawReturn = openTrade.side === "long"
      ? (openTrade.exitPrice - openTrade.entryPrice) / openTrade.entryPrice
      : (openTrade.entryPrice - openTrade.exitPrice) / openTrade.entryPrice;
    openTrade.pnlPct = rawReturn * leverage - 2 * fee;
    openTrade.closeTime = candles[candles.length - 1].openTime;
    trades.push(openTrade);
  }

  return trades;
}

function computeStats(trades: Trade[]) {
  if (trades.length === 0) return { trades: 0 };
  const wins = trades.filter(t => t.pnlPct > 0);
  const totalReturn = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avgReturn = totalReturn / trades.length;
  const maxDD = trades.reduce((m, t) => Math.min(m, t.pnlPct), 0);
  return {
    trades: trades.length,
    wins: wins.length,
    winRate: (wins.length / trades.length * 100).toFixed(1) + "%",
    totalReturnPct: (totalReturn * 100).toFixed(1) + "%",
    avgReturnPct: (avgReturn * 100).toFixed(2) + "%",
    maxDD: (maxDD * 100).toFixed(1) + "%",
    winPct: wins.map(t => t.pnlPct * 100),
    lossPct: trades.filter(t => t.pnlPct <= 0).map(t => t.pnlPct * 100),
  };
}

async function main() {
  const symbols = ["XRPUSDT", "ETHUSDT", "SOLUSDT"];
  const params = [
    [5, 1], [7, 1], [10, 1], [14, 1],
    [10, 1.2], [14, 1.2],
  ];

  for (const symbol of symbols) {
    console.log(`\n=== ${symbol} ===`);
    const candles = await fetchRange(symbol, "1h", 365);
    console.log(`Candles: ${candles.length}`);

    for (const [period, mult] of params) {
      const trades = backtestST(candles, period, mult);
      if (trades.length === 0) continue;
      const stats = computeStats(trades);
      console.log(`  ST(${period}, ${mult}): ${stats.trades} trades, WR ${stats.winRate}, total ${stats.totalReturnPct}, avg ${stats.avgReturnPct}, maxDD ${stats.maxDD}`);
    }
  }
}
main().catch(console.error);
