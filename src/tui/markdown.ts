import { wrapText } from "../layout/truncate.js";

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export interface RichLine {
  role: "user" | "assistant" | "thinking" | "tool" | "system";
  spans: Span[];
  /** True if this is the first visual line of a chat entry — shows the role label. */
  first: boolean;
  /** Extra left padding for code blocks, blockquotes, etc. */
  indent?: number;
}

const INLINE_RE = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)|(~~(.+?)~~)/g;

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    if (m[2]) spans.push({ text: m[2], bold: true });
    else if (m[4]) spans.push({ text: m[4], italic: true });
    else if (m[6]) spans.push({ text: m[6], code: true });
    else if (m[8]) spans.push({ text: m[8] });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}

export function renderMarkdown(text: string, role: RichLine["role"], bodyWidth: number): RichLine[] {
  const rawLines = text.split("\n");
  const result: RichLine[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        if (codeLines.length > 0) {
          for (const cl of codeLines) {
            result.push({
              role,
              spans: [{ text: cl, code: true }],
              first: false,
              indent: 2,
            });
          }
        }
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(raw);
      continue;
    }

    if (raw.startsWith("#")) {
      const content = raw.replace(/^#+\s*/, "");
      const wrapped = wrapText(content, bodyWidth);
      wrapped.forEach((line, i) => {
        result.push({
          role,
          spans: parseInline(line).map((s) => ({ ...s, bold: true })),
          first: result.length === 0 && i === 0,
        });
      });
      continue;
    }

    if (raw.startsWith("> ")) {
      const content = raw.replace(/^>\s*/, "");
      const wrapped = wrapText(content, bodyWidth - 2);
      wrapped.forEach((line, i) => {
        result.push({
          role,
          spans: parseInline(line).map((s) => ({ ...s, italic: true })),
          first: result.length === 0 && i === 0,
          indent: 2,
        });
      });
      continue;
    }

    if (raw.match(/^[-*]\s/)) {
      const content = raw.replace(/^[-*]\s/, "");
      const wrapped = wrapText(content, bodyWidth - 2);
      wrapped.forEach((line, i) => {
        result.push({
          role,
          spans: [{ text: "• " }, ...parseInline(line)],
          first: result.length === 0 && i === 0,
          indent: i === 0 ? 0 : 2,
        });
      });
      continue;
    }

    const wrapped = wrapText(raw, bodyWidth);
    wrapped.forEach((line, i) => {
      result.push({
        role,
        spans: parseInline(line),
        first: result.length === 0 && i === 0,
      });
    });
  }

  if (codeLines.length > 0) {
    for (const cl of codeLines) {
      result.push({
        role,
        spans: [{ text: cl, code: true }],
        first: false,
        indent: 2,
      });
    }
  }

  return result;
}
