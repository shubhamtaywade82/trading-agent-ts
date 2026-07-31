export const MARKETS: Record<string, { base: string; prefixes: string[] }> = {
  spot: { base: "https://api.binance.com", prefixes: ["/api/v3/"] },
  usdm: { base: "https://fapi.binance.com", prefixes: ["/fapi/v1/", "/fapi/v2/", "/futures/data/"] },
  coinm: { base: "https://dapi.binance.com", prefixes: ["/dapi/v1/"] },
};

export const KLINES_PATH: Record<string, string> = {
  spot: "/api/v3/klines",
  usdm: "/fapi/v1/klines",
  coinm: "/dapi/v1/klines",
};

export const DEPTH_PATH: Record<string, string> = {
  spot: "/api/v3/depth",
  usdm: "/fapi/v1/depth",
  coinm: "/dapi/v1/depth",
};

export const BINANCE_TAGS = ["binance", "market-data"] as const;

export async function fetchBinance(market: string, path: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = MARKETS[market];
  if (!config) {
    return { error: "InvalidMarket", message: `market must be one of: ${Object.keys(MARKETS).join(", ")}` };
  }
  if (!config.prefixes.some((prefix) => path.startsWith(prefix))) {
    return { error: "InvalidPath", message: `path for market '${market}' must start with one of: ${config.prefixes.join(", ")}` };
  }

  const url = new URL(path, config.base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  try {
    const response = await fetch(url, { method: "GET" });
    const body = await response.json();
    if (!response.ok) return { error: "BinanceApiError", status: response.status, body };
    return { status: response.status, body };
  } catch (e) {
    return { error: "RequestError", message: (e as Error).message };
  }
}
