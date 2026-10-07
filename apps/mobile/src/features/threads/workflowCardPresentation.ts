/**
 * Pure presentation helpers for the mobile workflow card. Grouping comes from
 * the shared client-runtime model (`deriveAgentPanelModel`); these helpers turn
 * one group into the strings and counts a row renders, so the card's
 * invariants are exercised without a renderer: a phase is only "done" once the
 * run reached it, and an unreached phase in a finished run reads "not reached"
 * rather than "pending".
 */
import {
  isTerminalSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  WorkflowAgentGroup,
  WorkflowPhaseGroup,
} from "@t3tools/client-runtime/state/workflow-groups";

/** Phase members in order, then members whose phase row was lost. */
export function workflowMembers(group: WorkflowAgentGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/** A terminal coordinator means the run is over; a paused one is resumable. */
export function workflowIsLive(group: WorkflowAgentGroup): boolean {
  return !isTerminalSubagentStatus(group.workflow.status);
}

export function workflowPhaseSummary(phase: WorkflowPhaseGroup): string {
  if (phase.state === "skipped") return "not reached";
  if (phase.state === "pending" && phase.members.length === 0) return "pending";
  if (phase.state === "done") return `${phase.settledCount} done`;
  return `${phase.activeCount} active · ${phase.settledCount} done`;
}
