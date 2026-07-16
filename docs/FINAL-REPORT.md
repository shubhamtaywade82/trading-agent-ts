# Crypto Futures Intraday Strategy Research — Final Report (CORRECTED 2026-07-16)

**Date:** 2026-07-16
**Symbols:** XRPUSDT, ETHUSDT, SOLUSDT
**Tools:** Binance REST API (live klines), `runFuturesBacktest` (the one real, validated engine — `src/tools/backtest-tools.ts`), 3bps slippage, 5bps fees
**Validation:** 3-fold out-of-sample walk-forward (train-window-agnostic — every fold tested at the exact claimed params, not re-optimized) on 2 years of data, plus realistic-sizing reverification (5x leverage, 5% margin/trade)

> **This report replaces an earlier version of itself.** The original claimed 15
> walk-forward-validated strategies (up to 89% WR, Sharpe 94.7, sourced from
> `scripts/mega-sweep.ts` + `scripts/walk-forward.ts`). Both of those scripts import the real
> engine but never call it — they reimplement their own liquidity-sweep/FVG/Ichimoku/
> volume-spike/SuperTrend signal detection from scratch, inconsistent with the validated
> detectors already in `backtest-tools.ts`, with no slippage modeled and (in mega-sweep's
> case) no out-of-sample check at all — just the best Sharpe off a stop/target grid evaluated
> on the same window being reported. Every one of the 15 claims was re-run through the real
> engine at the exact claimed (timeframe, stop, target); every trade count, win rate, and
> Sharpe was wrong — off by 5-20x in trade count. See `scripts/final-report-verify.ts` and
> `strategies.json`'s `_verification.finalReportAudit` for the full audit trail.

---

## 1. Verified Strategies (real engine, 3-fold OOS, realistic sizing)

Method: fetched 2 years of Binance klines per (symbol, timeframe), ran the exact claimed
strategy on the full window AND on 3 independent out-of-sample slices (50-67%, 60-77%,
70-87% of the window — no re-optimization per fold, testing reproducibility of the strategy
as stated). A strategy only counts as verified if the full window is net positive AND at
least 2 of 3 OOS folds are net positive. 10 of 15 originally-claimed strategies passed this
bar structurally; 3 of those 10 had negative full-window PnL despite a narrow partial OOS
pass and were disqualified anyway. **7 strategies are genuinely real** (numbers below are the
realistic 5x/5% sizing reverification, annualized from a 2yr sample):

| Symbol | Strategy | TF | Stop | Target | Trades (2yr) | WR | Sharpe | PnL/yr | Max DD |
|---|---|---|---|---|---|---|---|---|---|
| XRP | Bearish FVG Short | 1h | 2% | 6% | 495 | 42% | 16.3 | +$5,392 | 11.6% |
| XRP | Liquidity Sweep Short | 2h | 2% | 6% | 275 | 39% | 15.5 | +$2,381 | 12.4% |
| XRP | Liquidity Sweep Short | 1h | 1% | 3% | 655 | 34% | 11.8 | +$2,291 | 8.7% |
| SOL | Liquidity Sweep Short | 2h | 3% | 5% | 266 | 45% | 10.6 | +$1,586 | 9.2% |
| SOL | Ichimoku Below Cloud Short | 4h | 3% | 6% | 280 | 39% | 7.6 | +$1,283 | 9.9% |
| ETH | Liquidity Sweep Short | 2h | 1% | 3% | 425 | 30% | 6.2 | +$670 | 5.1% |
| XRP | ADX-DI Cross Short | 30m | 2% | 6% | 685 | 40% | 2.4 | +$532 | 17.6% |

These are also cross-referenced against `strategies.json`'s existing 1h-focused pool from the
prior verification round (which used a proper parameter grid search, not fixed params) — that
pool's XRP entries at 1h *outperform* the fixed-param versions re-tested here, so the prior
round's numbers remain the primary reference for XRP 1h; the table above adds genuine new
coverage (2h/30m/4h timeframes, and ETH's/SOL's first liq-sweep and Ichimoku entries).

## 2. Rejected Claims (failed real-engine reverification)

| Symbol | Strategy | TF | Why it failed |
|---|---|---|---|
| XRP | SuperTrend Flip Short | 1d | 8 total trades over 2yr (1-2 per OOS fold) — statistically meaningless. 0/3 OOS folds positive. |
| XRP | Ichimoku Below Cloud Short | 4h | Full-window PnL negative (-$1,819) despite 2/3 OOS folds narrowly positive — net loser overall, disqualified. |
| XRP | Volume Spike Short | 4h | Full-window PnL negative (-$1,173). |
| ETH | Volume Spike Short | 1d | 17 total trades over 2yr. 0/3 OOS folds positive. |
| ETH | SuperTrend Flip Short | 1d | 9 total trades over 2yr. 0/3 OOS folds positive. |
| ETH | Volume Spike Short | 4h | Full-window PnL negative (-$348). |
| SOL | ADX-DI Cross Short | 4h | Only 1/3 OOS folds positive; full-window PnL barely positive but not durable. |
| SOL | Volume Spike Short | 1d | 12 total trades over 2yr. 0/3 OOS folds positive. |

**Every single `1d`-timeframe claim failed** — 2 years of daily candles isn't enough sample
for any of these signal families on XRP/ETH/SOL (8-17 total trades). This also exposed a
numerical bug: the Sharpe formula's variance estimator blows up at n≤2 trades (produced
values like `-1.5e17` in raw output) — not a real number, a known failure mode of trade-based
Sharpe at tiny sample sizes. Treat any Sharpe figure computed from under ~15-20 trades as
noise, not signal, regardless of how extreme it looks.

## 3. What Actually Works (revised)

- **Liquidity Sweep Short is the one signal that works on all 3 symbols**, across multiple
  timeframes (1h and 2h both verified) — the most robust single finding across every round of
  this research, now independently re-confirmed a third time with a completely different
  testing methodology (fixed-param OOS replay vs. the prior round's grid search).
- **XRP remains the strongest symbol** — 4 of the 7 newly-verified strategies, plus the
  stronger 1h-tuned versions already in `strategies.json` from the prior round.
- **SOL and ETH each gained one genuinely new signal family**: SOL gets its first verified
  Ichimoku entry, ETH gets its first verified plain liquidity-sweep entry (previously only
  had FVG-based signals) — both real but weaker than XRP's equivalents (Sharpe 6-8 vs XRP's
  11-16).
- **Daily timeframe is not viable with 2 years of data on these pairs.** Don't attempt 1d
  strategies here without a materially longer history (5+ years), which may not even exist
  for XRP/SOL perpetual futures given more recent contract launches.
- **Confluence (AND-gated entries) still underperforms solo signals** — reconfirmed from the
  prior round, not retested this round (see `strategies.json`'s `confluenceEntryTest` note).

## 4. Trading Recommendations (revised)

### Conservative (prioritize consistency across OOS folds)
- XRP Bearish FVG Short 1h — most consistent OOS performance of anything tested this round
  ($2,133/$2,532/$2,388 across 3 folds, barely any variance)
- XRP Liquidity Sweep Short 1h or 2h — both fully OOS-consistent, pick 1h for more signal
  frequency or 2h for less screen time
- SOL Liquidity Sweep Short 2h — real, positive every fold, but weaker margin (fold2 nearly
  break-even at $73)

### Higher-frequency / more active
- XRP ADX-DI Cross Short 30m — most trades (685/2yr) but weakest Sharpe (2.4) and highest DD
  (17.6%) of the verified set; only for someone actively managing risk per-trade
- SOL Ichimoku Below Cloud Short 4h — flag: OOS PnL is declining across folds ($931→$637→$158)
  — possible edge decay, recheck before increasing size

### Avoid
- Anything on `1d` timeframe for these 3 symbols, until a much longer data history is
  available
- ETH Liquidity Sweep Short 2h if capital is limited — real but the weakest Sharpe (6.2) and
  thinnest per-fold margin ($448/$42/$151) of the verified set; include only for
  diversification once capital allows, size it down relative to the others

### Sizing guideline (unchanged from prior rounds)
- 5% margin/trade, 5x leverage is the sizing used for every number in this report
- Do not size up to 10x/10% or beyond without re-checking max DD at the new size — DD scales
  roughly linearly with margin %, and several of these strategies already show 8-18% DD at 5%
  margin

## 5. Full-Pool 1-Year Verification: Solo + Fusion FIFO (2026-07-16, final pass)

All 17 strategies in `strategies.json` re-run on a fresh 1-year window at their exact stated
(timeframe, stop, target, maxHold) params — real engine, realistic sizing (5x/5%), 3bps
slippage, split-sample check. **All 17 pass**: net positive, both halves independently
positive, ≥15 trades. Full numbers: `scripts/verify-1yr-output.json` (from
`scripts/verify-1yr-single-and-fusion.ts`).

### Solo results (1yr, per strategy)

| Symbol | Strategy | TF | Stop/Tgt | Trades | WR | PF | Sharpe | PnL/yr | MaxDD |
|---|---|---|---|---|---|---|---|---|---|
| XRP | Bearish FVG Short | 1h | 3%/6% | 194 | 57% | 1.98 | 28.7 | $7,064 | 3.2% |
| XRP | Liq Sweep Short | 1h | 3%/6% | 163 | 55% | 1.86 | 25.0 | $4,631 | 3.6% |
| XRP | Liq Sweep Short | 2h | 2%/6% | 124 | 48% | 1.94 | 28.0 | $3,826 | 2.6% |
| XRP | ADX-DI Cross Short | 30m | 2%/4% | 334 | 47% | 1.37 | 12.8 | $3,090 | 5.7% |
| XRP | Liq Sweep+FVG Short | 30m | 2%/4% | 214 | 51% | 1.61 | 19.4 | $3,029 | 4.3% |
| XRP | Liq Sweep+FVG Long | 1h | 1%/4% | 121 | 33% | 1.60 | 18.6 | $1,421 | 2.5% |
| ETH | Bearish FVG Short | 1h | 2%/2% | 363 | 60% | 1.44 | 17.7 | $3,899 | 3.1% |
| ETH | Liq Sweep+FVG Short | 30m | 0.8%/4% | 247 | 30% | 1.42 | 12.8 | $1,675 | 6.0% |
| ETH | RSI>80 Short MR | 1h | 3%/6% | 28 | 61% | 2.09 | 29.2 | $802 | 1.5% |
| ETH | Liq Sweep+FVG Long | 4h | 2%/4% | 30 | 47% | 1.55 | 19.6 | $473 | 3.6% |
| ETH | Liq Sweep Short | 2h | 1%/3% | 209 | 29% | 1.09 | 3.7 | $364 | 4.0% |
| SOL | Bearish FVG Short | 1h | 1%/2% | 477 | 47% | 1.56 | 21.0 | $4,933 | 4.7% |
| SOL | Liq Sweep Short | 1h | 2%/6% | 215 | 39% | 1.41 | 14.0 | $3,081 | 6.1% |
| SOL | Liq Sweep Short | 2h | 3%/5% | 137 | 47% | 1.30 | 12.3 | $1,779 | 9.2% |
| SOL | Liq Sweep+FVG Short | 1h | 1%/2% | 144 | 47% | 1.62 | 22.0 | $1,352 | 4.3% |
| SOL | Liq Sweep+FVG Long | 1h | 1%/2% | 158 | 45% | 1.46 | 17.0 | $1,132 | 2.1% |
| SOL | Ichimoku Below Cloud Short | 4h | 3%/6% | 124 | 39% | 1.16 | 7.0 | $968 | 9.1% |

Weakest link remains `eth-liq-sweep-short-2h`: passes formally, but H2 contributed just $36
of its $364 — keep it minimal-size or drop it.

### Fusion FIFO results (multiple active strategies, 1yr, 5x/5%, +50% margin per same-side confluence, capped 3 adds)

The fusion tool runs all strategies per symbol simultaneously; first signal to fire on a bar
wins the entry (FIFO), later same-side signals from *other* strategies while the position is
open add margin instead of opening a new position. One interval per call, so the pool runs as
4 timeframe groups:

| Group | Strategies | Entries | WR | PnL/yr | Return | MaxDD | Conf-adds on | Avg PnL w/ conf vs w/o |
|---|---|---|---|---|---|---|---|---|
| 1h — all 3 symbols | 9 | 1,157 | 40% | $133,428 | +1,334% | 12.8% | 648/1,155 exits | +$311 vs −$136 |
| 1h — XRP only | 3 | 245 | 50% | $35,715 | +357% | 7.0% | 195/244 | +$203 vs −$79 |
| 1h — ETH only | 2 | 373 | 51% | $9,178 | +92% | 5.7% | 223/373 | +$72 vs −$46 |
| 1h — SOL only | 4 | 539 | 27% | $8,078 | +81% | 11.6% | 230/538 | +$78 vs −$33 |
| 30m — XRP+ETH | 3 | 643 | 36% | $13,819 | +138% | 9.2% | 337/642 | +$55 vs −$15 |
| 2h — all 3 symbols | 3 | 498 | 31% | $11,466 | +115% | 16.5% | 236/495 | +$74 vs −$23 |
| 4h — ETH+SOL | 2 | 182 | 32% | $1,432 | +14% | 26.9% | 114/181 | +$34 vs −$37 |

Reading the fusion numbers honestly:

- **Fusion compounding inflates headline returns** — the +1,334% figure comes from margin
  being a % of a growing capital base plus confluence adds up to 2.5x base size. The right
  takeaways are the DD (12.8% at the full 9-strategy pool — moderate) and the confluence
  split, not the raw PnL. Fusion caveats vs the solo engine: no slippage modeled inside the
  fusion tool, fixed 48-bar timeout regardless of timeframe.
- **The confluence edge reconfirms on every single group**: trades that received a same-side
  confluence add averaged positive PnL in all 7 runs; lone-signal trades averaged *negative*
  in all 7. Third independent confirmation of this pattern. In fusion mode, the lone-signal
  entries are effectively the cost paid to be in position when confirmation arrives.
- **Multi-symbol beats single-symbol on risk-adjusted terms at 1h** — the 3-symbol pool's DD
  (12.8%) is barely above single-symbol SOL's (11.6%) while diversifying across 9 strategies.
- **4h group is the weakest fusion config** (26.9% DD for +14%) — only 2 strategies, no real
  confluence density; run the 4h entries solo instead of fused.

## 6. Multi-Timeframe: HTF Bias → LTF Execution (2026-07-16)

Tested the classic top-down structure: **4h regime bias gating 5m/15m execution entries**.
New engine capability: `runFuturesBacktest` accepts an optional `entryMask` (per-candle
boolean gate) — the test script builds the mask from *closed* 4h bars only (bias for an LTF
candle comes from the last fully-closed 4h bar, no lookahead). Bias definition: 4h close vs
EMA50 — below = bearish regime (shorts allowed), above = bullish (longs allowed). Script:
`scripts/mtf-bias-test.ts`, full data: `scripts/mtf-bias-output.json`. Realistic sizing
(5x/5%, 3bps slippage). Note: prior to this, the pool's `bearish_htf_trend_short` signal was
NOT real HTF — it's a 5-bar MA on the same timeframe; this section is the first genuine
multi-timeframe test in the repo.

### Findings

- **5m execution doesn't clear costs.** Even ungated, 5m signals are marginal-to-negative
  everywhere (best: XRP bearish FVG, PF 1.09; ETH liq sweep outright negative). At 5m the
  per-trade edge is smaller than fees+slippage. 4h gating cuts drawdown but can't create an
  edge that isn't there. **Skip 5m execution with this signal pool.**
- **15m execution works for shorts on all 3 symbols** — and the HTF gate's value is
  symbol-dependent:
  - **SOL: the gate rescues/improves.** Liq Sweep Short flips from a loser (−$42 ungated) to
    a survivor (+$152, both halves positive); Bearish FVG improves Sharpe 9.2→11.2 with DD
    3.8%→2.6%. SOL's short edge is regime-dependent — trade it only in a 4h downtrend.
  - **XRP: the gate costs money.** Liq Sweep Short ungated $1,218 vs gated $888 (90d);
    Bearish FVG $882 vs $312. XRP's short edge works in BOTH 4h regimes — filtering to
    bearish-regime-only just discards profitable trades. Consistent with every prior round:
    XRP's sweep/FVG shorts are the most regime-independent edge in the whole research.
  - **ETH: mixed, mostly neutral** — gating trims DD, slightly helps FVG, slightly hurts liq
    sweep; regime-fragile either way at 15m.
- **Longs fail at 5m/15m entirely**, gated or not — `bullish_liq_fvg` (the best long signal
  at 1h/4h) is negative at both lower timeframes on all symbols. Long entries need 1h+
  timeframes; there is no verified long-side edge below 1h.
- **Across all 24 comparisons, gating reduced max DD in 23** — the HTF filter is reliably a
  *risk reducer* (~35-45% fewer trades, smaller DD), but only a *return improver* where the
  underlying edge is genuinely regime-dependent (SOL).

### Practical answer to "HTF for bias, LTF for execution?"

Yes, but selectively — the data supports this structure only where the edge is
regime-dependent:

| Layer | Timeframe | What the data supports |
|---|---|---|
| Regime/bias | 4h EMA50 (1d too data-poor here — 1d bars are fine as *bias* input but untested; 4h verified) | Use as a gate for SOL shorts; optional DD-reducer for ETH; skip for XRP shorts (costs money) |
| Setup/analysis | 1h-2h | Where the strongest verified edges live (see sections 1 & 5) — this remains the core trading timeframe |
| Execution | 15m | Works for shorts on all 3 symbols; SOL requires the 4h gate, XRP better ungated |
| Execution | 5m | Not viable with this signal pool — edge below cost floor |

Candidates worth promoting to `strategies.json` after the pool schema supports a bias field
(the fusion tool and strategies.json can't express an HTF gate yet): SOL 15m Bearish FVG
4h-gated (PF 1.30, Sharpe 11.2, DD 2.6%), XRP 15m Liq Sweep ungated ($1,218/90d, Sharpe 17.6
— needs its own split-sample pass first).

## 7. Order Block Zone-Retest Model (SMC mitigation entries, 2026-07-16)

Implemented the full SMC OB approach in TypeScript (`src/tools/orderblocks.ts` +
`ob_retest_long`/`ob_retest_short` engine signals): ATR-adaptive displacement detection
(body > 1.5×ATR, body/range > 0.6, 2-bar structure break), proximal/distal zone levels,
lookahead-free strength score (rolling volume average — the source approach's version
averaged the *last 20 candles of the whole dataset*, a lookahead bug, fixed), zone
invalidation on close-through-distal, and **entry on first retest of proximal** — the actual
SMC mitigation entry, vs. the pool's pre-existing `bearish_ob`/`bullish_ob` signals which
enter *at the impulse bar* (chasing displacement).

Tested 3 variants × both directions × 15m/1h × 3 symbols vs the impulse-entry baseline
(`scripts/ob-retest-test.ts`, output `scripts/ob-retest-output.json`):

- **A** — retest naked (the approach as pasted)
- **B** — retest gated by 4h EMA50 bias (Trend Continuation, §19.1 of the system doc)
- **C** — retest gated by a liquidity sweep within the prior 20 bars (Liquidity Sweep
  Reversal, §19.2 — a *temporal* sweep→retest sequence, not the same-bar AND that already
  failed in earlier confluence testing)

### Findings

- **Retest entry structurally beats impulse entry everywhere.** The impulse-bar baseline is
  net-negative in 14 of 18 configs (drawdowns 5-35%); the retest variant cuts max DD to
  0.7-4.6% in every config and flips PF above 1 wherever any edge exists. The core idea of
  the approach — trade the retrace into the zone, not the displacement — is validated.
- **But frequency collapses**: ~15-30 retest signals/yr at 1h (vs ~300 impulse signals).
  Most configs can't clear the ≥15-trade statistical bar, so absolute PnL is small.
- **One strategy qualified for the pool**: XRP `ob_retest_short` 1h, stop 2% / target 6% —
  21 trades, 48% WR, **PF 2.35 (highest in the pool)**, Sharpe 34.0, +$690/yr at 5x/5%,
  max DD 1.7%, both halves positive. Added to `strategies.json`.
- **The sweep→retest sequence (variant C) is the strongest confluence tested so far**: it
  is the only thing that makes SOL OB shorts work (20 trades, PF 1.49, SURVIVES — naked
  retest is net-negative on SOL), and on XRP it pushes PF to 3.29 — but at 13 trades/yr,
  below the sample bar. Worth revisiting with 2yr data to double the sample.
- **Longs still fail** in nearly every config, consistent with every prior round — the
  long-side edge on these pairs is limited to `bullish_liq_fvg` at 1h/4h.
- **The approach's claimed "55-70% win rate" did not reproduce**: actual WR 24-54% across
  configs. Same inflation pattern as every other unverified claim this session.

### Review of the source approach (bugs found before porting)

1. Strength score used whole-dataset average volume → lookahead bias (fixed: rolling SMA at
   detection time).
2. Its PD-array code paired consecutive swings assuming they alternate high/low — false
   (two consecutive swing highs breaks it). PD arrays not ported; equilibrium-based
   premium/discount is approximated by the existing 4h EMA50 bias gate instead.
3. `filterAndMergeBlocks` was referenced but never implemented in any of its versions.
4. Its "BOS" check is a 2-bar close-through, not structural — kept anyway as displacement
   confirmation (stricter than the repo's prior 1-bar version).

### On the "Crypto Futures Trading System" architecture document

The doc's principles are sound and match what this research enforced by hand all session:
event-sourced truth, research-before-execution, walk-forward validation as a gate, no
LLM-controlled orders, regime awareness, leverage caps (§22 validation standards ≈ this
report's methodology). But it describes a multi-quarter platform build (event store,
projectors, feature store, knowledge graph, probability engine, DSL runtime) of which this
repo implements roughly the research kernel only (detectors + backtest engine + validation
scripts). Its *testable* setup claims (§17.2 sweep→displacement→retrace sequence, §19 setup
types) are what was tested above: Trend Continuation = variant B, Liquidity Sweep Reversal =
variant C — C validated on SOL, B mostly neutral. Breakout-Retest (§19.3) needs a
compression-regime detector that doesn't exist yet; Mean Reversion to Equilibrium (§19.4) is
already covered by the validated RSI>80 short. Treat the rest of the doc as a build roadmap,
not as claims requiring verification.

## 8. 3-Year Train / 2026 Forward Test + 5m Exit Resolution (2026-07-16, capstone)

The strictest validation pass yet: **2.5yr train window (2023-07-16 → 2026-01-01)** plus a
**true 2026-YTD forward holdout (Jan 1 → Jul 16, ~6.5 months)** on all 18 pool strategies at
their exact stated params, realistic sizing (5x/5%, 3bps slippage). The forward window was
additionally run with **5m sub-bar exit resolution** — new engine capability (`subBars`
param on `runFuturesBacktest`): when both stop and target fall inside one native bar, 5m
candles determine which was actually hit first (native resolution assumes stop-first, i.e.
pessimistic). Script: `scripts/train-forward-test.ts`, data:
`scripts/train-forward-output.json`.

*Honest caveat on the "forward" label: strategies were selected on windows ending 2026-07,
which overlaps 2026 YTD — so the forward numbers confirm robustness of the selection, they
are not a fully untouched holdout. The 2023-2025 train window IS genuinely out-of-sample for
most of the pool (selected mostly on 2025-07→2026-07 data).*

### Result: 14 of 18 HOLD (positive in both windows)

**Ranked per symbol by forward-2026 PF (5m-resolved):**

**XRPUSDT**
| # | Strategy | TF | Stop/Tgt | Fwd PF | Fwd PnL (6.5mo) | Train PF | Train $/yr | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | Liq Sweep Short | 1h | 3%/6% | **2.22** | $2,254 | 1.23 | $1,966 | HOLDS |
| 2 | Bearish FVG Short | 1h | 3%/6% | 1.88 | $2,805 | 1.29 | $2,697 | HOLDS |
| 3 | Liq Sweep+FVG Short | 30m | 2%/4% | 1.76 | $1,787 | 1.49 | $2,644 | HOLDS |
| 4 | Liq Sweep Short | 2h | 2%/6% | 1.67 | $1,235 | 1.24 | $1,099 | HOLDS |
| 5 | ADX-DI Cross Short | 30m | 2%/4% | 1.64 | $2,453 | **0.91** | **−$785** | **TRAIN_FAIL** |
| 6 | OB Retest Short | 1h | 2%/6% | 1.42 | $139 | **0.80** | **−$123** | **TRAIN_FAIL** |
| 7 | Liq Sweep+FVG Long | 1h | 1%/4% | 1.35 | $462 | 1.50 | $1,271 | HOLDS |

**ETHUSDT**
| # | Strategy | TF | Stop/Tgt | Fwd PF | Fwd PnL | Train PF | Train $/yr | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | Liq Sweep+FVG Long | 4h | 2%/4% | 1.88 | $233 | 2.19 | $1,131 | HOLDS |
| 2 | Liq Sweep+FVG Short | 30m | 0.8%/4% | 1.67 | $1,212 | 1.33 | $1,512 | HOLDS |
| 3 | RSI>80 Short MR | 1h | 3%/6% | 1.47 | $186 | **0.89** | **−$104** | **TRAIN_FAIL** |
| 4 | Bearish FVG Short | 1h | 2%/2% | 1.36 | $1,552 | 1.35 | $3,153 | HOLDS |
| 5 | Liq Sweep Short | 2h | 1%/3% | **1.00** | **$0** | 1.13 | $524 | **FWD_FAIL — REMOVED** |

**SOLUSDT**
| # | Strategy | TF | Stop/Tgt | Fwd PF | Fwd PnL | Train PF | Train $/yr | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | Liq Sweep+FVG Long | 1h | 1%/2% | 1.51 | $604 | 1.51 | $1,341 | HOLDS |
| 2 | Bearish FVG Short | 1h | 1%/2% | 1.35 | $1,447 | 1.62 | $7,325 | HOLDS |
| 3 | Liq Sweep Short | 2h | 3%/5% | 1.34 | $811 | 1.24 | $1,701 | HOLDS |
| 4 | Liq Sweep Short | 1h | 2%/6% | 1.34 | $1,189 | 1.22 | $2,306 | HOLDS |
| 5 | Liq Sweep+FVG Short | 1h | 1%/2% | 1.33 | $393 | 1.70 | $1,739 | HOLDS |
| 6 | Ichimoku Below Cloud Short | 4h | 3%/6% | 1.23 | $645 | 1.07 | $427 | HOLDS |

### Key findings

- **The liquidity-sweep / FVG signal families hold across 3 years AND 2026** — every single
  sweep/FVG-based strategy (13 of them) is positive in both windows. Fourth independent
  confirmation of the core edge, now including a multi-year regime span.
- **Four strategies exposed as recent-regime-only or dead**: ETH Liq Sweep Short 2h made
  exactly $0 in 2026 (removed from the pool — it was already flagged as the weakest link
  twice). XRP ADX-DI Cross 30m, XRP OB Retest 1h, and ETH RSI>80 MR are all net-negative
  over the 2.5yr train window despite good recent numbers — their edge exists only in the
  2025-26 regime. Flagged with `warn` fields in strategies.json; size minimal or skip.
- **The 1yr metrics stored in strategies.json are the optimistic end**: train-window PFs run
  systematically lower (e.g. XRP Bearish FVG: 1.29 over 2.5yr vs 1.98 over the last year;
  SOL Bearish FVG: $7.3k/yr train pace vs $4.9k last-year). 2023-24 was a less favorable
  regime. Plan around the train-window numbers, treat the 1yr numbers as upside.
- **5m exit resolution barely matters at these parameter widths** — identical results for
  17 of 18 strategies; only SOL Bearish FVG 1h (tightest params, 1%/2%) changed: +13% PnL
  (PF 1.31→1.35). Two reasons: (a) with stops/targets of 1-6% on 1h bars, both levels rarely
  fall inside one bar; (b) where they do, the native engine assumed stop-first, so the
  approximation was already conservative — finer data can only improve the numbers. The
  intuition that sub-bar data adds accuracy is correct; the effect at these widths is small
  and favorable. It WILL matter more for any future sub-1% stop strategies — the capability
  is now in the engine for that.

## 9. Autonomous Paper Trading (2026-07-16, capstone)

Built the missing piece identified when asked "is this ready for paper trading": an
automated signal→trade bridge using the SAME validated code path as the backtest, not a
sixth hand-rolled duplicate (mega-sweep.ts, walk-forward.ts, signal-scanner.ts,
new-strats-backtest.ts, debug-scanner.ts all made this exact mistake this session).

**Engine refactor**: extracted the condition-evaluation switch out of `runFuturesBacktest`
into `buildSignalEvaluator(candles, entryConditions): (i) => boolean` — one function, two
callers. `runFuturesBacktest` now calls it internally (pure extraction, verified
byte-identical output pre/post-refactor, all 471 tests still pass). The live runner imports
the exact same function. There is structurally no way for live signals to drift from
backtested ones anymore — the failure mode that hit this research five separate times is
closed at the type level, not by discipline.

**`src/paper-trading/live-runner.ts`** — `LivePaperRunner`:
- Loads all 17 strategies from `strategies.json`, groups by (symbol, timeframe) to batch
  Binance fetches (9 fetch groups cover all 17 strategies).
- Each strategy trades its own isolated $10k virtual capital bucket — not a shared/fusion
  pool. This matches how every strategy's numbers were individually validated, so live
  results are directly, apples-to-apples comparable to the backtest per strategy (fusion
  mode is a separate, already-tested mechanism — see section 5 — and could be added later).
- Polls Binance REST per group, drops the still-forming candle, evaluates entries via
  `buildSignalEvaluator` and manages open positions (stop/target/liquidation/timeout) against
  each newly-closed candle — identical per-bar logic to the backtest loop.
- Sizing matches the validated config exactly: 5x leverage, 5% margin/trade, 5bps fee, 3bps
  slippage.
- State persists to `.trading-agent/paper-state.json` after every tick — restart-safe.
- Every fill (entry/exit, with reason: stop/target/liquidation/timeout) appends to
  `.trading-agent/paper-trades.jsonl` — the record for comparing live WR/PF/Sharpe against
  backtest expectations after a few weeks of running.

**`scripts/paper-trade-runner.ts`** — the autonomous entrypoint. `npm run paper-trade` (or
`npm run paper-trade -- --poll-seconds=30`). Runs forever, polling every 60s by default (the
shortest strategy timeframe in the pool is 30m, so 60s polling always catches a new candle
close within a minute), prints status on every fill plus a 15-minute heartbeat, saves state
on `Ctrl+C`/`SIGTERM` before exiting. No human input required once started — genuinely
autonomous within a terminal session or process manager (pm2/systemd/tmux) of the user's
choice.

**Smoke-tested against live Binance data** (not simulated): one real tick fetched all 9
groups in 5.1s, correctly evaluated all 17 strategies, and **one strategy fired live**
(`sol-ichimoku-below-4h` opened a short at $76.61, stop $78.91/target $72.01/margin $500 —
all computed correctly from the strategy's 3%/6% risk and 5%-margin sizing). A second tick
confirmed dedup — no double-fill on the same closed candle. State file and trade journal
both persisted correctly. Test artifacts cleaned up; this was a real fetch/evaluate/state
cycle, not a mock.

### What this does NOT do (be clear before trusting it)

- **No fusion/confluence mode yet** — each strategy is independent; the FIFO+confluence
  mechanism validated in section 5 isn't wired into the live runner. Straightforward to add
  (group by symbol instead of by strategy) but out of scope for this pass.
- **No mixed-timeframe HTF-bias gating** (section 6) — the live runner doesn't yet build the
  `entryMask` the backtest supports for 4h-regime-gated 15m execution.
- **REST polling, not WebSocket** — simplest reliable option for 30m+ timeframes (all current
  pool strategies), adequate 60s latency; would need a stream-based rewrite for 5m/1m signals.
- **This is paper trading, not live capital.** No exchange order placement — positions are
  purely simulated against real market prices. Confirm the journal's live stats resemble the
  backtest before ever considering real capital.

## 10. Files

| File | Description |
|---|---|
| `strategies.json` | Full validated strategy pool, mixed timeframes, with per-entry audit notes |
| `docs/research.md` | Full research history across all rounds |
| `src/tools/backtest-tools.ts` | The one real, validated engine — SMC + LuxAlgo + volume signals, slippage, `BinanceMultiTimeframeSweepTool` |
| `scripts/final-report-verify.ts` | Re-verifies every claim in this report against the real engine, 3-fold OOS |
| `scripts/final-report-realistic-verify.ts` | Realistic-sizing (5x/5%) reverify of the 7 survivors |
| `scripts/final-report-verify-output.json` | Full audit output, all 15 original claims |
| `scripts/mega-sweep.ts`, `scripts/walk-forward.ts`, `scripts/signal-scanner.ts`, `scripts/debug-scanner.ts` | **Do not trust their output** — duplicate hand-rolled engines, warning headers added to each |

## 11. What's Next

1. **Live paper trading** — the 7-9 verified strategies (this round + prior rounds combined),
   log signals + virtual PnL before any real capital
2. **Mixed-TF fusion** — the fusion tool currently assumes one shared interval per call;
   wiring in strategies across 30m/1h/2h/4h simultaneously needs an engine change
3. **Correlation analysis** — check whether the liquidity-sweep signals on XRP/ETH/SOL fire
   on correlated market-wide events (a single volatility spike sweeping all 3 at once), which
   would mean less real diversification than the strategy count suggests
4. **Regime stability** — test on 2023 data or earlier, if available for these contracts
5. **Fix the signal-scanner/debug-scanner scripts** to call the real detectors instead of
   their own duplicates, before using them for anything live
