import React from "react";
import { Box, Text } from "ink";
import { ApprovalRequest } from "../../runtime/types.js";
import { wrapText, tail } from "../../layout/truncate.js";
import { OverlayFrame } from "./OverlayFrame.js";

export interface ApprovalOverlayProps {
  request: ApprovalRequest;
  width: number;
  rows: number;
  showDiff: boolean;
}

/** Approval: review and confirm. Enter/a Approve, n Reject, d Diff. */
export function ApprovalOverlay({ request, width, rows, showDiff }: ApprovalOverlayProps): JSX.Element {
  const innerWidth = Math.max(20, Math.min(width - 8, 96));
  const diffLines = showDiff && request.diff ? tail(request.diff.split("\n"), Math.max(3, rows - 8)) : [];
  return (
    <OverlayFrame title={showDiff ? "Diff Preview" : "Approval Required"} width={width} rows={rows}>
      <Text bold wrap="truncate">
        {request.title}
      </Text>
      <Text wrap="truncate">
        <Text color="blue">{`${request.filesChanged} files`}</Text>
        <Text color="green">{`  +${request.additions}`}</Text>
        <Text color="red">{`  -${request.deletions}`}</Text>
      </Text>
      {showDiff
        ? diffLines.map((line, i) => (
            <Text
              key={i}
              wrap="truncate"
              color={line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : "gray"}
            >
              {line}
            </Text>
          ))
        : wrapText(request.summary, innerWidth)
            .slice(0, Math.max(1, rows - 8))
            .map((line, i) => (
              <Text key={i} wrap="truncate">
                {line}
              </Text>
            ))}
      <Box marginTop={1}>
        <Text>
          <Text color="green">[a] Approve</Text>
          <Text>{"  "}</Text>
          <Text color="red">[n] Reject</Text>
          <Text>{"  "}</Text>
          <Text color="yellow">[d] {showDiff ? "Summary" : "Diff"}</Text>
        </Text>
      </Box>
    </OverlayFrame>
  );
}
