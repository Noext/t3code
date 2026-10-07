import {
  isTerminalSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  WorkflowAgentGroup,
  WorkflowPhaseGroup,
} from "@t3tools/client-runtime/state/workflow-groups";
import type { EnvironmentId, OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { AgentSheetRow } from "./AgentSheetRow";
import { SubagentStatusDot } from "./SubagentStatusDot";
import { resolveSubagentStatusTone } from "./threadAgentsPresentation";
import { workflowIsLive, workflowMembers, workflowPhaseSummary } from "./workflowCardPresentation";

/**
 * A Pi workflow run as one card: the coordinator's name plus run suffix, then
 * a phase rail and one collapsible section per phase. Members resolve back to
 * the contract subagent by id for their row; an id the roster no longer holds
 * is skipped rather than rendered as a made-up terminal state.
 */
export function WorkflowCard(props: {
  readonly group: WorkflowAgentGroup;
  readonly subagentById: ReadonlyMap<string, OrchestrationV2Subagent>;
  readonly environmentId: EnvironmentId;
  readonly tickSeconds: boolean;
  readonly onOpen: (childThreadId: ThreadId) => void;
}) {
  const live = workflowIsLive(props.group);
  const [expanded, setExpanded] = useState(live);
  const members = workflowMembers(props.group);
  const settled = members.filter((member) => isTerminalSubagentStatus(member.status)).length;

  const renderMember = (member: RuntimeSubagent): ReactNode => {
    const subagent = props.subagentById.get(member.id);
    if (subagent === undefined) return null;
    return (
      <AgentSheetRow
        key={member.id}
        environmentId={props.environmentId}
        subagent={subagent}
        tickSeconds={props.tickSeconds}
        onOpen={props.onOpen}
      />
    );
  };

  return (
    <View className="mb-2 overflow-hidden rounded-xl border border-border bg-card/30">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${props.group.label}, ${settled} of ${members.length} agents settled`}
        accessibilityHint={`Double tap to ${expanded ? "collapse" : "expand"} the workflow.`}
        onPress={() => {
          void Haptics.selectionAsync();
          setExpanded((value) => !value);
        }}
        className="flex-row items-center gap-2 px-3 py-2.5 active:bg-subtle"
      >
        <SubagentStatusDot
          tone={resolveSubagentStatusTone(props.group.workflow.status)}
          placement="sheet"
        />
        <Text numberOfLines={1} className="min-w-0 flex-1 font-t3-medium text-sm text-foreground">
          {props.group.label}
        </Text>
        <Text className="shrink-0 text-2xs tabular-nums text-foreground-muted">
          {settled}/{members.length} settled
        </Text>
        <SymbolView
          name={expanded ? "chevron.up" : "chevron.down"}
          size={11}
          tintColorClassName="accent-icon-subtle"
        />
      </Pressable>
      {expanded ? (
        <View className="px-3 pb-2">
          <WorkflowPhaseRail phases={props.group.phases} />
          {props.group.phases.map((phase) => (
            <WorkflowPhaseSection
              key={phase.index}
              phase={phase}
              defaultOpen={!live}
              renderMember={renderMember}
            />
          ))}
          {props.group.unphasedMembers.map(renderMember)}
          {props.group.phases.length === 0 && props.group.unphasedMembers.length === 0
            ? renderMember(props.group.workflow)
            : null}
        </View>
      ) : null}
    </View>
  );
}

/** The run's shape at a glance: one segment per phase, one dot per member. */
function WorkflowPhaseRail(props: { readonly phases: ReadonlyArray<WorkflowPhaseGroup> }) {
  if (props.phases.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-1 pt-2">
      {props.phases.map((phase) => (
        <View
          key={phase.index}
          className={cn(
            "flex-row items-center gap-1 rounded-md border px-1.5 py-0.5",
            phase.state === "running"
              ? "border-adaptive-sky-500-a25-400-a25 bg-adaptive-sky-500-a10-400-a10"
              : phase.state === "done"
                ? "border-adaptive-emerald-500-a12-a16"
                : "border-border",
          )}
        >
          <Text
            numberOfLines={1}
            className={cn(
              "font-mono text-3xs",
              phase.state === "running"
                ? "text-adaptive-sky-700-300"
                : phase.state === "done"
                  ? "text-adaptive-emerald-700-300"
                  : "text-foreground-muted",
            )}
          >
            {phase.state === "done" ? `✓ ${phase.title}` : phase.title}
          </Text>
          <View className="flex-row items-center gap-0.5">
            {phase.members.length === 0 ? (
              <Text className="font-mono text-3xs text-foreground-subtle">–</Text>
            ) : (
              phase.members.map((member) => (
                <SubagentStatusDot
                  key={member.id}
                  tone={resolveSubagentStatusTone(member.status)}
                />
              ))
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A phase opens when it becomes active, then keeps that shape as it settles so
 * completion never yanks rows out from under the user. Manual toggles stick
 * until a later activation begins.
 */
function WorkflowPhaseSection(props: {
  readonly phase: WorkflowPhaseGroup;
  readonly defaultOpen: boolean;
  readonly renderMember: (member: RuntimeSubagent) => ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen || props.phase.state === "running");
  const previousState = useRef(props.phase.state);

  useEffect(() => {
    if (previousState.current !== "running" && props.phase.state === "running") {
      setOpen(true);
    }
    previousState.current = props.phase.state;
  }, [props.phase.state]);

  return (
    <View className="mt-1.5">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${props.phase.title}, ${workflowPhaseSummary(props.phase)}`}
        onPress={() => {
          void Haptics.selectionAsync();
          setOpen((value) => !value);
        }}
        className="flex-row items-center gap-1.5 rounded-md px-1 py-1 active:bg-subtle"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={10}
          tintColorClassName="accent-icon-subtle"
        />
        {props.phase.state === "done" ? (
          <SymbolView
            name="checkmark"
            size={10}
            tintColorClassName="accent-adaptive-emerald-600-400"
          />
        ) : null}
        <Text
          numberOfLines={1}
          className={cn(
            "min-w-0 text-2xs font-t3-medium uppercase tracking-wide",
            props.phase.state === "done"
              ? "text-adaptive-emerald-600-400"
              : props.phase.state === "running"
                ? "text-adaptive-sky-600-400"
                : "text-foreground-muted",
          )}
        >
          {props.phase.title}
        </Text>
        <Text numberOfLines={1} className="min-w-0 flex-1 text-2xs text-foreground-subtle">
          {workflowPhaseSummary(props.phase)}
        </Text>
      </Pressable>
      {open ? <View className="gap-px">{props.phase.members.map(props.renderMember)}</View> : null}
    </View>
  );
}
