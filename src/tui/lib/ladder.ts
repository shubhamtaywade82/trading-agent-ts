export interface LadderInput {
  sl: number;
  now: number;
  tp: number;
  liq?: number;
  width?: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export function renderLadder({ sl, now, tp, liq, width = 10 }: LadderInput): string {
  const lo = Math.min(sl, tp);
  const hi = Math.max(sl, tp);
  const span = hi - lo || 1;
  const pos = clamp(Math.round(((now - lo) / span) * (width - 1)), 0, width - 1);

  const cells = Array.from({ length: width }, (_, i) => (i === pos ? "●" : "━"));
  let bar = "┣" + cells.join("") + "┫";

  if (liq !== undefined && liq >= lo && liq <= hi) {
    const lp = clamp(Math.round(((liq - lo) / span) * (width - 1)), 0, width - 1);
    const chars = bar.split("");
    if (chars[lp + 1] !== "●") {
      chars[lp + 1] = "✕";
    }
    bar = chars.join("");
  }
  const slStr = sl >= 100 ? sl.toFixed(2) : sl.toFixed(4);
  const tpStr = tp >= 100 ? tp.toFixed(2) : tp.toFixed(4);
  const liqStr = liq !== undefined ? `  ✕${liq.toFixed(2)}` : "";
  return `${slStr}${bar}${tpStr}${liqStr}`;
}

export function getRiskColor(distancePct: number): "green" | "yellow" | "red" {
  if (distancePct > 2) return "green";
  if (distancePct >= 1) return "yellow";
  return "red";
}

