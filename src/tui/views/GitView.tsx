import React from "react";
import { Box, Text } from "ink";
import { GitFileChange } from "../../runtime/types.js";
import { elidePath, tail } from "../../layout/truncate.js";
import { ViewProps } from "./ConversationView.js";

const STATUS_GLYPH: Record<GitFileChange["status"], { glyph: string; color: string }> = {
  modified: { glyph: "M", color: "yellow" },
  added: { glyph: "A", color: "green" },
  deleted: { glyph: "D", color: "red" },
  renamed: { glyph: "R", color: "blue" },
};

/** Git: branch state, ahead/behind, staged and modified files, diff stat. */
export function GitView({ state, width, rows, detail }: ViewProps): JSX.Element {
  const { git } = state;
  const fileRows = Math.max(0, rows - 1);
  const files = tail(git.files, fileRows);
  const additions = git.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = git.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <Box flexDirection="column" height={rows}>
      <Text wrap="truncate">
        <Text color="blue" bold>{`⎇ ${git.branch || "(no branch)"}`}</Text>
        {(git.ahead > 0 || git.behind > 0) && <Text color="yellow">{`  ↑${git.ahead} ↓${git.behind}`}</Text>}
        <Text color="gray">{`  ${git.files.length} changed`}</Text>
        {detail !== "compact" && (additions > 0 || deletions > 0) && (
          <>
            <Text color="green">{`  +${additions}`}</Text>
            <Text color="red">{` -${deletions}`}</Text>
          </>
        )}
      </Text>
      {files.map((file) => {
        const s = STATUS_GLYPH[file.status];
        return (
          <Text key={file.path} wrap="truncate">
            <Text color={file.staged ? "green" : s.color}>{` ${file.staged ? "●" : "○"} ${s.glyph} `}</Text>
            <Text>{elidePath(file.path, Math.max(10, width - 18))}</Text>
            {detail === "full" && file.additions != null && (
              <>
                <Text color="green">{`  +${file.additions}`}</Text>
                <Text color="red">{` -${file.deletions ?? 0}`}</Text>
              </>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
