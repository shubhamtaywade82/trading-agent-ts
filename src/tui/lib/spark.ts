const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const BRAILLE = ["⠀", "⠁", "⠃", "⠅", "⠆", "⠇", "⠿"];

export function sparkline(values: number[], width = 6, braille = false): string {
  if (values.length === 0) return (braille ? "─" : " ").repeat(width);
  const sampled = resample(values, width);
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const span = max - min || 1;

  const chars = braille ? BRAILLE : BLOCKS;
  const maxIdx = chars.length - 1;

  return sampled
    .map(v => {
      const idx = Math.min(maxIdx, Math.max(0, Math.round(((v - min) / span) * maxIdx)));
      return chars[idx] ?? chars[0];
    })
    .join("");
}

function resample(arr: number[], n: number): number[] {
  if (arr.length <= n) return arr;
  return Array.from({ length: n }, (_, i) => {
    const idx = Math.floor((i * (arr.length - 1)) / (n - 1));
    return arr[idx] ?? 0;
  });
}

