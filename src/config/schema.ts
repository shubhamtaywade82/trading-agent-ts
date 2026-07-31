import { z } from "zod";

export const ConfigSchema = z.object({
  paper: z.object({
    enabled: z.boolean().default(true),
    initialCapital: z.number().positive().default(100_000), // base ccy units, NOT $/€/₹
    baseCurrency: z.string().default("USD"),
  }).default({ enabled: true, initialCapital: 100_000, baseCurrency: "USD" }),

  risk: z.object({
    riskPerTradePct: z.number().min(0).max(5).default(1),     // % of equity risked per trade
    maxPositionPct: z.number().min(0).max(100).default(20),   // max single-position size
    maxOpenPositions: z.number().int().positive().default(5),
    maxDailyLossPct: z.number().min(0).max(20).default(3),    // circuit breaker
    defaultStopAtrMult: z.number().positive().default(2),     // stop = entry - k*ATR
    defaultTakeProfitRR: z.number().positive().default(2),    // reward:risk
  }).default({
    riskPerTradePct: 1,
    maxPositionPct: 20,
    maxOpenPositions: 5,
    maxDailyLossPct: 3,
    defaultStopAtrMult: 2,
    defaultTakeProfitRR: 2,
  }),

  execution: z.object({
    commissionPct: z.number().min(0).default(0.0005),
    slippagePct: z.number().min(0).default(0.0005),
    tickIntervalMs: z.number().int().positive().default(60_000),
  }).default({
    commissionPct: 0.0005,
    slippagePct: 0.0005,
    tickIntervalMs: 60_000,
  }),

  universe: z.array(z.string()).min(1).default(["AAPL", "MSFT"]),
});

export type Config = z.infer<typeof ConfigSchema>;
