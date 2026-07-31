import { BINANCE_TAGS, fetchBinance } from "./binance-client.js";
import { Tool } from "./tool.js";

export async function fetchFuturesStats(
  symbol: string,
): Promise<{ markPrice: number; lastFundingRate: number; nextFundingTime: number; openInterest: number } | { error: string; message: string }> {
  const [premium, openInterest] = await Promise.all([
    fetchBinance("usdm", "/fapi/v1/premiumIndex", { symbol }),
    fetchBinance("usdm", "/fapi/v1/openInterest", { symbol }),
  ]);
  if (premium["error"]) return premium as { error: string; message: string };
  if (openInterest["error"]) return openInterest as { error: string; message: string };

  const p = premium["body"] as { markPrice: string; lastFundingRate: string; nextFundingTime: number };
  const oi = openInterest["body"] as { openInterest: string };
  return {
    markPrice: Number(p.markPrice),
    lastFundingRate: Number(p.lastFundingRate),
    nextFundingTime: p.nextFundingTime,
    openInterest: Number(oi.openInterest),
  };
}

export class BinanceFuturesStatsTool extends Tool {
  readonly name = "binance_futures_stats";
  readonly description = "Fetch USD-M futures funding rate and open interest for a symbol — sentiment/positioning signal, not available on spot.";

  override get tags(): string[] {
    return [...BINANCE_TAGS, "futures", "funding-rate", "open-interest"];
  }

  override get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: { symbol: { type: "string", description: "e.g. BTCUSDT" } },
      required: ["symbol"],
    };
  }

  async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = typeof args["symbol"] === "string" ? args["symbol"] : "";
    const result = await fetchFuturesStats(symbol);
    if ("error" in result) return result;
    return { symbol, ...result };
  }
}
