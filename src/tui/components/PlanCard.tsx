import React from "react";
import { Box, Text } from "ink";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { StatusChip } from "./StatusChip.js";
import { ChatEntry, ExecutionStep } from "../../runtime/types.js";

interface PlanCardProps {
  entry: ChatEntry;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
}

export function PlanCard({ entry, collapsed, onToggle, width }: PlanCardProps): JSX.Element | null {
  if (entry.kind !== "plan") return null;
  const { steps, status } = entry;

  return (
    <CollapsibleSection title="Plan" status={status} collapsed={collapsed} onToggle={onToggle} width={width}>
      <Box flexDirection="column" marginLeft={2}>
        {steps.map((step) => (
          <Box key={step.id} height={1}>
            <Text>
              <StatusChip status={step.status} />
              {" "}
              <Text color={step.status === "running" ? "blue" : undefined}>
                {step.description}
              </Text>
            </Text>
          </Box>
        ))}
      </Box>
    </CollapsibleSection>
  );
}
