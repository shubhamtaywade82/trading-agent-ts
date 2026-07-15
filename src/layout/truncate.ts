/**
 * Truncation and elision utilities. All width math happens here so the
 * renderer never guesses.
 */

const ELLIPSIS = "…";

/** Truncate to `width` display columns, appending an ellipsis when cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return ELLIPSIS;
  return text.slice(0, width - 1) + ELLIPSIS;
}

/** Truncate keeping the tail — right-most part of paths matters most. */
export function truncateStart(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return ELLIPSIS;
  return ELLIPSIS + text.slice(text.length - (width - 1));
}

/**
 * Elide the middle of a path, preserving the first segment and as much of
 * the tail as fits: `src/…/fs.ts`.
 */
export function elidePath(path: string, width: number): string {
  if (path.length <= width) return path;
  const parts = path.split("/");
  if (parts.length <= 2) return truncateStart(path, width);
  const head = parts[0];
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const tail = parts.slice(parts.length - keep).join("/");
    const candidate = `${head}/${ELLIPSIS}/${tail}`;
    if (candidate.length <= width) return candidate;
  }
  return truncateStart(parts[parts.length - 1], width);
}

/** Keep the last `count` items of a list (for scroll-follow rendering). */
export function tail<T>(items: T[], count: number): T[] {
  return count <= 0 ? [] : items.length <= count ? items : items.slice(items.length - count);
}

/** Hard-wrap a line to `width` columns, preserving explicit newlines. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    out.push(rest);
  }
  return out;
}
