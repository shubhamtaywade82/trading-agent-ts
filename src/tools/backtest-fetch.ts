import { parseKlineRows, type Candle } from "../backtest/types.js";

export async function fetchCandles(
  symbol: string,
  interval: string,
  limit: number,
  market: "spot" | "usdm" = "usdm",
): Promise<{ candles: ReturnType<typeof parseKlineRows> } | { error: string; message: string }> {
  const baseUrl = market === "usdm" ? "https://fapi.binance.com" : "https://api.binance.com";
  const path = market === "usdm" ? "/fapi/v1/klines" : "/api/v3/klines";
  const url = new URL(path, baseUrl);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  try {
    const response = await fetch(url, { method: "GET" });
    const body = await response.json();
    if (!response.ok) return { error: "BinanceApiError", message: JSON.stringify(body) };
    return { candles: parseKlineRows(body as unknown[][]) };
  } catch (e) {
    return { error: "RequestError", message: (e as Error).message };
  }
}
// ── Multi-batch klines fetcher (exceeds 1000-candle limit) ──
// Retries transient network failures ("fetch failed" — DNS blip, connection
// Reset, etc.) a few times with backoff before giving up. Binance 4xx/5xx
// Responses (a real API error) are NOT retried — those return immediately.
async function fetchWithRetry(url: URL, retries = 3): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { method: "GET" });
    } catch (e) {
      if (attempt >= retries) {
        const cause = (e as Error & { cause?: unknown }).cause;
        throw new Error(`${(e as Error).message}${cause ? ` (${String(cause)})` : ""}`);
      }
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}
export async function fetchCandlesRange(
  symbol: string, interval: string, startTime: number, endTime: number,
  market: "spot" | "usdm" = "usdm",
): Promise<{ candles: ReturnType<typeof parseKlineRows> } | { error: string; message: string }> {
  const all: ReturnType<typeof parseKlineRows> = [];
  let from = startTime;
  try {
    const baseUrl = market === "usdm" ? "https://fapi.binance.com" : "https://api.binance.com";
    const path = market === "usdm" ? "/fapi/v1/klines" : "/api/v3/klines";
    while (from < endTime) {
      const url = new URL(path, baseUrl);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("limit", "1000");
      url.searchParams.set("startTime", String(from));
      url.searchParams.set("endTime", String(endTime));
      const response = await fetchWithRetry(url);
      const body = await response.json();
      if (!response.ok) return { error: "BinanceApiError", message: JSON.stringify(body) };
      const rows = body as unknown[][];
      if (rows.length === 0) break;
      const candles = parseKlineRows(rows);
      all.push(...candles);
      const last = candles.at(-1);
      if (last === undefined) break;
      from = last.openTime + 1;
      await new Promise(r => setTimeout(r, 250));
    }
    return { candles: all };
  } catch (e) {
    return { error: "RequestError", message: (e as Error).message };
  }
}

const OI_PERIODS = ["5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"];

export async function fetchOpenInterestHist(
  symbol: string, period: string, startTime: number, endTime: number,
): Promise<{ points: Array<{ timestamp: number; sumOpenInterest: number }> } | { error: string; message: string }> {
  if (!OI_PERIODS.includes(period)) {
    return { error: "InvalidPeriod", message: `period must be one of: ${OI_PERIODS.join(", ")}` };
  }
  const all: Array<{ timestamp: number; sumOpenInterest: number }> = [];
  let from = startTime;
  try {
    while (from < endTime) {
      const url = new URL("/futures/data/openInterestHist", "https://fapi.binance.com");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("period", period);
      url.searchParams.set("limit", "500");
      url.searchParams.set("startTime", String(from));
      url.searchParams.set("endTime", String(endTime));
      const response = await fetchWithRetry(url);
      const body = await response.json();
      if (!response.ok) return { error: "BinanceApiError", message: JSON.stringify(body) };
      const rows = body as Array<{ sumOpenInterest: string; timestamp: number }>;
      if (rows.length === 0) break;
      for (const r of rows) all.push({ timestamp: r.timestamp, sumOpenInterest: Number(r.sumOpenInterest) });
      const last = rows.at(-1);
      if (last === undefined) break;
      from = last.timestamp + 1;
      if (rows.length < 500) break;
      await new Promise(r => setTimeout(r, 250));
    }
    return { points: all };
  } catch (e) {
    return { error: "RequestError", message: (e as Error).message };
  }
}

export function alignOiToCandles(candles: Candle[], points: Array<{ timestamp: number; sumOpenInterest: number }>): number[] {
  const result: number[] = Array.from({ length: candles.length }, () => NaN);
  let p = 0;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (candle === undefined) continue;
    while (p < points.length - 1) {
      const next = points[p + 1];
      if (next === undefined || next.timestamp > candle.openTime) break;
      p++;
    }
    const pt = points[p];
    if (pt !== undefined && pt.timestamp <= candle.openTime) result[i] = pt.sumOpenInterest;
  }
  return result;
}
