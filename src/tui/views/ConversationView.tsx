import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { ChatEntry, RuntimeState } from "../../runtime/types.js";
import { DetailLevel } from "../../layout/density.js";
import { truncate } from "../../layout/truncate.js";
import { parseInline, Span } from "../markdown.js";

export interface ViewProps {
  state: RuntimeState;
  width: number;
  rows: number;
  detail: DetailLevel;
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.values(args)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(", ");
}

function SpanText({ spans }: { spans: Span[] }): JSX.Element {
  return (
    <Text wrap="truncate">
      {spans.map((s, j) => {
        if (s.code) return <Text key={j} inverse>{` ${s.text} `}</Text>;
        return (
          <Text key={j} bold={s.bold} italic={s.italic}>
            {s.text}
          </Text>
        );
      })}
    </Text>
  );
}

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
      for (const line of wrapText(content, bodyWidth)) {
        result.push({ spans: parseInline(line).map((s) => ({ ...s, bold: true })) });
      }
      continue;
    }
    if (raw.match(/^[-*]\s/)) {
      const content = raw.replace(/^[-*]\s/, "");
      for (const line of wrapText(content, bodyWidth - 2)) {
        result.push({ spans: [{ text: "• " }, ...parseInline(line)], indent: 2 });
      }
      continue;
    }
    if (raw.startsWith("> ")) {
      const content = raw.replace(/^>\s*/, "");
      for (const line of wrapText(content, bodyWidth - 2)) {
        result.push({ spans: parseInline(line).map((s) => ({ ...s, italic: true })), indent: 2 });
      }
      continue;
    }
    for (const line of wrapText(raw, bodyWidth)) {
      result.push({ spans: parseInline(line) });
    }
  }

  if (codeLines.length > 0) {
    for (const cl of codeLines) {
      result.push({ spans: [{ text: cl, code: true }], indent: 2 });
    }
  }
  return result;
}

function TurnSeparator({ width }: { width: number }): JSX.Element {
  return (
    <Box height={1}>
      <Text color="gray" dimColor wrap="truncate">
        {"─".repeat(Math.max(1, width))}
      </Text>
    </Box>
  );
}

function ToolCallBlock({
  entry,
  collapsed,
  width,
}: {
  entry: ChatEntry & { kind: "tool_call" };
  collapsed: boolean;
  width: number;
}): JSX.Element {
  const args = formatArgs(entry.args);
  const isRunning = entry.status === "running";
  const isFailed = entry.status === "failed";
  const statusColor = isRunning ? "yellow" : isFailed ? "red" : "green";
  const statusLabel = isRunning ? "running" : isFailed ? "failed" : "done";
  const connector = "  ├─ ";

  return (
    <Box flexDirection="column">
      <Box height={1}>
        <Text color="gray">{connector}</Text>
        <Text bold color="cyan">{entry.name} </Text>
        <Text color="gray" wrap="truncate">
          {truncate(args, Math.max(10, width - 20 - entry.name.length))}
        </Text>
        <Text color={statusColor} dimColor={!isRunning}>
          {" "}[{statusLabel}]
        </Text>
      </Box>
      {!collapsed && (entry.result || entry.error) && (
        <Box marginLeft={5} flexDirection="column">
          {entry.error && (
            <Box height={1}>
              <Text color="red" wrap="truncate">
                Error: {truncate(entry.error.replace(/\n/g, " "), width - 10)}
              </Text>
            </Box>
          )}
          {entry.result && (
            <Box height={1}>
              <Text color="gray" wrap="truncate">
                Result: {truncate(entry.result.replace(/\n/g, " "), width - 10)}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

interface RenderedBlock {
  key: string;
  height: number;
  render: (startRow: number, endRow: number) => JSX.Element;
}

export function ConversationView({ state, width, rows, detail: _detail }: ViewProps): JSX.Element {
  const [collapsed] = useState<Set<number>>(new Set());
  const bodyWidth = Math.max(10, width);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Build renderable blocks from conversation entries
  const blocks = useMemo<RenderedBlock[]>(() => {
    const b: RenderedBlock[] = [];
    let isFirst = true;

    for (const entry of state.conversation) {
      if (!isFirst) {
        if (entry.role === "user") {
          b.push({
            key: `sep-${entry.at}`,
            height: 1,
            render: () => <TurnSeparator key={`sep-${entry.at}`} width={bodyWidth} />,
          });
        } else {
          b.push({
            key: `space-${entry.at}`,
            height: 1,
            render: () => <Box key={`space-${entry.at}`} height={1} />,
          });
        }
      }
      isFirst = false;

      if (entry.kind === "text") {
        if (entry.role === "thinking") {
          const preview = entry.text.slice(0, bodyWidth - 6).replace(/\n.*$/s, "") || "Thinking...";
          b.push({
            key: `think-${entry.at}`,
            height: 1,
            render: () => (
              <Box key={`think-${entry.at}`} flexDirection="column">
                <Box height={1}>
                  <Text color="magenta" dimColor wrap="truncate">
                    ▸ {preview}
                  </Text>
                </Box>
              </Box>
            ),
          });
        } else if (entry.role === "user") {
          const lines = renderSimpleMarkdown(entry.text, bodyWidth - 2);
          b.push({
            key: `user-${entry.at}`,
            height: lines.length,
            render: (startRow, endRow) => {
              const visibleLines = lines.slice(startRow, endRow);
              return (
                <Box key={`user-${entry.at}`} flexDirection="column">
                  {visibleLines.map((line, li) => (
                    <Box key={startRow + li} height={1}>
                      {startRow + li === 0 ? <Text color="green">&gt; </Text> : <Box width={2} />}
                      {line.indent ? <Box width={line.indent} /> : null}
                      <SpanText spans={line.spans} />
                    </Box>
                  ))}
                </Box>
              );
            },
          });
        } else {
          // assistant
          const lines = renderSimpleMarkdown(entry.text, bodyWidth - 2);
          b.push({
            key: `asst-${entry.at}`,
            height: lines.length,
            render: (startRow, endRow) => {
              const visibleLines = lines.slice(startRow, endRow);
              return (
                <Box key={`asst-${entry.at}`} flexDirection="column">
                  {visibleLines.map((line, li) => (
                    <Box key={startRow + li} height={1}>
                      <Box width={2} />
                      {line.indent ? <Box width={line.indent} /> : null}
                      <SpanText spans={line.spans} />
                    </Box>
                  ))}
                </Box>
              );
            },
          });
        }
      } else if (entry.kind === "tool_call") {
        const isCollapsed = collapsed.has(entry.at);
        const extraHeight = isCollapsed ? 0 : (entry.result ? 1 : 0) + (entry.error ? 1 : 0);
        b.push({
          key: `tool-${entry.at}`,
          height: 1 + extraHeight,
          render: () => <ToolCallBlock entry={entry} collapsed={isCollapsed} width={bodyWidth} />,
        });
      } else if (entry.kind === "plan") {
        const headerText = `📋 Plan (${entry.steps.length} steps) [${entry.status}]`;
        const stepGlyphs = {
          completed: { char: "✓", color: "green" },
          failed: { char: "✗", color: "red" },
          running: { char: "▶", color: "yellow" },
          pending: { char: "○", color: "gray" },
          skipped: { char: "–", color: "gray" },
        };
        b.push({
          key: `plan-${entry.at}`,
          height: 1 + entry.steps.length,
          render: () => (
            <Box key={`plan-${entry.at}`} flexDirection="column">
              <Box height={1}>
                <Text bold color="blue">{headerText}</Text>
              </Box>
              {entry.steps.map((step, idx) => {
                const s = stepGlyphs[step.status] || stepGlyphs.pending;
                return (
                  <Box key={step.id} height={1}>
                    <Text color="gray">  {idx + 1}) </Text>
                    <Text color={s.color}>{s.char} </Text>
                    <Text color={step.status === "completed" ? "gray" : "white"}>
                      {step.description}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          ),
        });
      } else if (entry.kind === "decision") {
        const optionList = entry.options.join(", ");
        b.push({
          key: `decision-${entry.at}`,
          height: 3,
          render: () => (
            <Box key={`decision-${entry.at}`} flexDirection="column">
              <Box height={1}>
                <Text bold color="cyan">🧠 Strategy Selection</Text>
                <Text color="gray"> (Options: {optionList})</Text>
              </Box>
              <Box height={1} marginLeft={2}>
                <Text>
                  <Text color="gray">Selected: </Text>
                  <Text bold color="green">{entry.selected}</Text>
                  <Text color="gray"> (Confidence: {Math.round(entry.confidence * 100)}%)</Text>
                </Text>
              </Box>
              <Box height={1} marginLeft={2}>
                <Text color="gray" wrap="truncate">
                  Reason: {truncate(entry.reason, width - 12)}
                </Text>
              </Box>
            </Box>
          ),
        });
      } else if (entry.kind === "diff_preview") {
        const diffLines = entry.diff.split("\n");
        const changes: Array<{ text: string; color: string }> = [];
        let additions = 0;
        let deletions = 0;
        for (const line of diffLines) {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            additions++;
            if (changes.length < 4) {
              changes.push({ text: line, color: "green" });
            }
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            deletions++;
            if (changes.length < 4) {
              changes.push({ text: line, color: "red" });
            }
          }
        }
        const hasMore = diffLines.filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))).length > changes.length;

        b.push({
          key: `diff-${entry.at}`,
          height: 1 + changes.length + (hasMore ? 1 : 0),
          render: () => (
            <Box key={`diff-${entry.at}`} flexDirection="column">
              <Box height={1}>
                <Text bold color="yellow">📄 {entry.filePath}</Text>
                <Text color="gray"> ({entry.status}) </Text>
                <Text color="green">+{additions} </Text>
                <Text color="red">-{deletions}</Text>
              </Box>
              {changes.map((ch, idx) => (
                <Box key={idx} height={1} marginLeft={2}>
                  <Text color={ch.color}>{ch.text}</Text>
                </Box>
              ))}
              {hasMore && (
                <Box height={1} marginLeft={2}>
                  <Text color="gray">...</Text>
                </Box>
              )}
            </Box>
          ),
        });
      } else if (entry.kind === "test_result") {
        const isSuccess = entry.failed === 0;
        const statusColor = isSuccess ? "green" : "red";
        const durationSec = (entry.durationMs / 1000).toFixed(1);
        const headerText = `🧪 Tests [${isSuccess ? "Passed" : "Failed"}] (${durationSec}s)`;

        const failureLines: string[] = [];
        if (!isSuccess && entry.failures) {
          for (const f of entry.failures.slice(0, 2)) {
            failureLines.push(`  ✗ ${f.file}:${f.line}`);
            failureLines.push(`    ${f.message.replace(/\s+/g, " ").slice(0, width - 6)}`);
          }
          if (entry.failures.length > 2) {
            failureLines.push(`  ... and ${entry.failures.length - 2} more failures`);
          }
        }

        b.push({
          key: `test-${entry.at}`,
          height: 3 + failureLines.length,
          render: () => (
            <Box key={`test-${entry.at}`} flexDirection="column">
              <Box height={1}>
                <Text bold color={statusColor}>{headerText}</Text>
              </Box>
              <Box height={1}>
                <Text color="gray">  Command: {entry.command}</Text>
              </Box>
              <Box height={1}>
                <Text color={statusColor}>
                  {isSuccess ? "  ✓" : "  ✗"} {entry.passed} passed, {entry.failed} failed
                </Text>
              </Box>
              {failureLines.map((fl, idx) => (
                <Box key={idx} height={1}>
                  <Text color={fl.startsWith("    ") ? "gray" : "red"}>{fl}</Text>
                </Box>
              ))}
            </Box>
          ),
        });
      } else if (entry.kind === "card") {
        const statusColor = entry.status === "completed" ? "green" : entry.status === "failed" ? "red" : "yellow";
        const glyphs = {
          completed: { char: "✓", color: "green" },
          failed: { char: "✗", color: "red" },
          running: { char: "▶", color: "yellow" },
          pending: { char: "○", color: "gray" },
          skipped: { char: "–", color: "gray" },
        };
        b.push({
          key: `card-${entry.at}`,
          height: 1 + entry.items.length,
          render: () => (
            <Box key={`card-${entry.at}`} flexDirection="column">
              <Box height={1}>
                <Text bold color={statusColor}>
                  {entry.title} [{entry.status}]
                </Text>
              </Box>
              {entry.items.map((item, idx) => {
                const s = glyphs[item.status] || glyphs.pending;
                return (
                  <Box key={idx} height={1} marginLeft={2}>
                    <Text color={s.color}>{s.char} </Text>
                    <Text>{item.label}</Text>
                    {item.detail && <Text color="gray"> ({item.detail})</Text>}
                  </Box>
                );
              })}
            </Box>
          ),
        });
      }
    }
    return b;
  }, [state.conversation, collapsed, bodyWidth]);

  const totalHeight = blocks.reduce((s, b) => s + b.height, 0);
  const maxOffset = Math.max(0, totalHeight - rows);
  const clampedOffset = Math.min(scrollOffset, maxOffset);

  // Blocks visible at this scroll position: we show the last `rows` rows.
  const visibleEnd = totalHeight - clampedOffset;
  const visibleStart = Math.max(0, visibleEnd - rows);

  // Find the first block that overlaps the visible window
  let blockStart = 0;
  let firstVisibleIdx = 0;
  for (let i = 0; i < blocks.length; i++) {
    const blockEnd = blockStart + blocks[i].height;
    if (blockEnd > visibleStart) {
      firstVisibleIdx = i;
      break;
    }
    blockStart = blockEnd;
  }

  // Limit to only blocks within visible window
  const visibleBlocks: Array<{ block: RenderedBlock; startRow: number; endRow: number }> = [];
  let currentRow = blockStart;
  for (let i = firstVisibleIdx; i < blocks.length && currentRow < visibleEnd; i++) {
    const b = blocks[i];
    if (currentRow + b.height > visibleStart) {
      const startRow = Math.max(0, visibleStart - currentRow);
      const endRow = Math.min(b.height, visibleEnd - currentRow);
      visibleBlocks.push({ block: b, startRow, endRow });
    }
    currentRow += b.height;
  }

  useInput((_input, key) => {
    if (key.pageUp) setScrollOffset((prev) => Math.min(maxOffset, prev + rows));
    else if (key.pageDown) setScrollOffset((prev) => Math.max(0, prev - rows));
  });

  const maxOffsetRef = useRef(maxOffset);
  maxOffsetRef.current = maxOffset;

  useEffect(() => {
    if (!process.stdin.isTTY) return;
    const handler = (data: Buffer) => {
      // eslint-disable-next-line no-control-regex
      const m = data.toString().match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
      if (!m) return;
      const btn = parseInt(m[1], 10);
      if (btn === 64) setScrollOffset((prev) => Math.min(maxOffsetRef.current, prev + 3));
      else if (btn === 65) setScrollOffset((prev) => Math.max(0, prev - 3));
    };
    process.stdin.on("data", handler);
    return () => {
      process.stdin.off("data", handler);
    };
  }, []);

  if (blocks.length === 0) {
    return (
      <Box height={rows}>
        <Text color="gray">No conversation yet — type below to begin.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={rows}>
      {visibleBlocks.map(({ block, startRow, endRow }) => block.render(startRow, endRow))}
    </Box>
  );
}
