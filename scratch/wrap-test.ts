import { parseInline, Span } from "../src/tui/markdown";

interface Token {
  span: Span;
  visualWidth: number;
}

export function wrapSpans(spans: Span[], W: number): Span[][] {
  if (W <= 0) return [];
  
  const tokens: Token[] = [];
  for (const span of spans) {
    if (span.code) {
      tokens.push({ span, visualWidth: span.text.length + 2 });
    } else {
      const parts = span.text.match(/\s+|\S+/g) || [];
      for (const part of parts) {
        tokens.push({
          span: { ...span, text: part },
          visualWidth: part.length,
        });
      }
    }
  }

  const lines: Span[][] = [];
  let currentLine: Span[] = [];
  let currentWidth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    
    if (currentWidth === 0 && token.span.text.trim() === "" && !token.span.code) {
      continue;
    }

    if (currentWidth + token.visualWidth <= W) {
      currentLine.push(token.span);
      currentWidth += token.visualWidth;
    } else {
      if (currentWidth > 0) {
        lines.push(currentLine);
        currentLine = [];
        currentWidth = 0;
        if (token.span.text.trim() === "" && !token.span.code) {
          continue;
        }
      }

      if (token.visualWidth > W) {
        let textToWrap = token.span.text;
        if (token.span.code) {
          const chunkLen = Math.max(1, W - 2);
          while (textToWrap.length > 0) {
            const chunk = textToWrap.slice(0, chunkLen);
            lines.push([{ ...token.span, text: chunk }]);
            textToWrap = textToWrap.slice(chunkLen);
          }
        } else {
          while (textToWrap.length > 0) {
            const chunk = textToWrap.slice(0, W);
            lines.push([{ ...token.span, text: chunk }]);
            textToWrap = textToWrap.slice(W);
          }
        }
      } else {
        currentLine.push(token.span);
        currentWidth = token.visualWidth;
      }
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

function renderSimpleMarkdown(text: string, bodyWidth: number): { spans: Span[]; indent?: number }[] {
  const rawLines = text.split("\n");
  const result: { spans: Span[]; indent?: number }[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      if (inCode) {
        for (const cl of codeLines) {
          result.push({ spans: [{ text: cl, code: true }], indent: 2 });
        }
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(raw);
      continue;
    }
    if (!raw.trim()) {
      result.push({ spans: [{ text: "" }] });
      continue;
    }

    if (raw.startsWith("#")) {
      const content = raw.replace(/^#+\s*/, "");
      const spans = parseInline(content).map((s) => ({ ...s, bold: true }));
      const wrappedLines = wrapSpans(spans, bodyWidth);
      for (const lineSpans of wrappedLines) {
        result.push({ spans: lineSpans });
      }
      continue;
    }
    if (raw.match(/^[-*]\s/)) {
      const content = raw.replace(/^[-*]\s/, "");
      const spans = parseInline(content);
      const wrappedLines = wrapSpans(spans, Math.max(1, bodyWidth - 4));
      if (wrappedLines.length === 0) {
        result.push({ spans: [{ text: "• " }], indent: 2 });
      } else {
        wrappedLines.forEach((lineSpans, i) => {
          if (i === 0) {
            result.push({ spans: [{ text: "• " }, ...lineSpans], indent: 2 });
          } else {
            result.push({ spans: lineSpans, indent: 4 });
          }
        });
      }
      continue;
    }
    if (raw.startsWith("> ")) {
      const content = raw.replace(/^>\s*/, "");
      const spans = parseInline(content).map((s) => ({ ...s, italic: true }));
      const wrappedLines = wrapSpans(spans, Math.max(1, bodyWidth - 2));
      for (const lineSpans of wrappedLines) {
        result.push({ spans: lineSpans, indent: 2 });
      }
      continue;
    }
    
    const spans = parseInline(raw);
    const wrappedLines = wrapSpans(spans, bodyWidth);
    for (const lineSpans of wrappedLines) {
      result.push({ spans: lineSpans });
    }
  }

  if (codeLines.length > 0) {
    for (const cl of codeLines) {
      result.push({ spans: [{ text: cl, code: true }], indent: 2 });
    }
  }
  return result;
}

// Test cases
const tests = [
  {
    name: "Header wrapping",
    text: "# This is a very long heading that should definitely wrap across multiple lines because of the small body width",
    width: 30,
  },
  {
    name: "List item with formatting",
    text: "- A list item containing `inline code` and some **bold text** that needs to wrap correctly and align subsequent lines",
    width: 40,
  },
  {
    name: "Blockquote",
    text: "> Some blockquote text that will be rendered in italics and have a left indent",
    width: 35,
  },
  {
    name: "Table row (paragraph)",
    text: "| Keys are unique (duplicates are overwritten) | Guarantees a single source of truth per key | Configuration options, attribute bags | `mapping` an ID with a record |",
    width: 80,
  },
];

for (const t of tests) {
  console.log(`=== Test: ${t.name} (width: ${t.width}) ===`);
  const lines = renderSimpleMarkdown(t.text, t.width);
  lines.forEach((line, i) => {
    const indentStr = " ".repeat(line.indent ?? 0);
    const lineText = line.spans.map(s => s.code ? `[CODE: ${s.text}]` : s.text).join("");
    console.log(`L${i}: "${indentStr}${lineText}"`);
  });
  console.log();
}
