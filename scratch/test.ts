import { parseInline } from "../src/tui/markdown";

function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    lines.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  return lines;
}

const rawText = "| Keys are unique (duplicates are overwritten) | Guarantees a single source of truth per key | Configuration options, attribute bags | Mapping an ID with a record |";

console.log("Original Length:", rawText.length);
const wrapped = wrapText(rawText, 140);
console.log("Wrapped lines:");
wrapped.forEach((line, i) => {
  console.log(`Line ${i}:`, JSON.stringify(line));
  const spans = parseInline(line);
  console.log(`Spans ${i}:`, JSON.stringify(spans));
});
