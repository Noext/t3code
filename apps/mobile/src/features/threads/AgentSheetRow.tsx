import type { EnvironmentId, OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SubagentRow } from "./SubagentRow";

/**
 * One agent row for the Agents sheet and the workflow card: the shared
 * SubagentRow plus the sheet's own press target and elapsed timer. The timer
 * lives here so a tick repaints this row alone, never the card header.
 */
export function AgentSheetRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
  readonly onOpen: (childThreadId: ThreadId) => void;
}) {
  const { subagent } = props;
  const childThreadId = subagent.childThreadId;

  const row = (
    <View className="border-b border-border py-3.5">
      <SubagentRow
        environmentId={props.environmentId}
        subagent={subagent}
        elapsed={<AgentElapsed subagent={subagent} tickSeconds={props.tickSeconds} />}
      />
    </View>
  );

  if (childThreadId === null) {
    return (
      <View
        accessible
        accessibilityHint="Provider-managed agent. Its work appears in the transcript."
      >
        {row}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint="Opens this agent's thread"
      onPress={() => props.onOpen(childThreadId)}
      className="active:opacity-70"
    >
      {row}
    </Pressable>
  );
}

function AgentElapsed(props: {
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
}) {
  const elapsed = useSubagentElapsed(props.subagent, props.tickSeconds);
  return elapsed === null ? null : (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{elapsed}</Text>
  );
}

/**
 * Elapsed time for one agent. Only live work ticks, so the timer never
 * repaints the metadata or a settled sheet.
 */
function useSubagentElapsed(
  subagent: Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">,
  tickSeconds: boolean,
): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const running = isOrchestrationV2WorkActive(subagent.status);
  useEffect(() => {
    if (!tickSeconds || !running) return;
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [running, tickSeconds]);
  const elapsedMs = deriveSubagentElapsedMs(
    {
      status: subagent.status,
      startedAt: subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt),
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
    },
    nowMs,
  );
  return elapsedMs === null || elapsedMs === 0 ? null : formatDuration(elapsedMs);
}
