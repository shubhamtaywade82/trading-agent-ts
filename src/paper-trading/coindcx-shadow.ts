import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

// Read-only public-market shadow price tracker. CoinDCX is the eventual
// live-execution target (docs/E2E-SYSTEM-REFERENCE.md §1a); every paper fill
// here prices off Binance, so this measures the basis a future live order
// would actually face — before any live/order code exists. Public ticker
// only, no auth, no order calls. Best-effort: CoinDCX being slow or
// unreachable must never affect or delay a trading decision.
//
// ponytail: uses CoinDCX's public SPOT ticker (one endpoint, no per-symbol
// futures market data needed for basis awareness) — a proxy for divergence,
// not an exact stand-in for the futures fill price a live order would get.
// Upgrade to the futures ticker if/when Phase 2 execution work starts.

export interface BasisRecord {
  ts: string; symbol: string; eventType: "entry" | "exit"; direction: "long" | "short";
  binancePrice: number; coindcxPrice: number; basisBps: number;
}

async function fetchCoinDcxPrice(symbol: string): Promise<number | null> {
  const res = await fetch("https://api.coindcx.com/exchange/ticker");
  if (!res.ok) return null;
  const tickers = (await res.json()) as { market: string; last_price: string }[];
  const hit = tickers.find(t => t.market === symbol);
  return hit ? Number(hit.last_price) : null;
}

export async function logCoinDcxBasis(
  logFile: string, symbol: string, eventType: "entry" | "exit", direction: "long" | "short", binancePrice: number,
): Promise<void> {
  try {
    const coindcxPrice = await fetchCoinDcxPrice(symbol);
    if (coindcxPrice === null) return;
    const basisBps = ((coindcxPrice - binancePrice) / binancePrice) * 10000;
    const record: BasisRecord = { ts: new Date().toISOString(), symbol, eventType, direction, binancePrice, coindcxPrice, basisBps };
    const dir = dirname(logFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logFile, JSON.stringify(record) + "\n");
  } catch {
    // best-effort — never throw into the trading path
  }
}
