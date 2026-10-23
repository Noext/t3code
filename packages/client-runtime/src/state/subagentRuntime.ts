/**
 * Subagent status helpers shared by web and mobile, and the runtime shape the
 * web agent rows render.
 */
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";

export type RuntimeSubagentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SubagentUsage {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

export interface SubagentActivityEntry {
  readonly at: string;
  readonly summary: string;
}

export interface SubagentWorkflowPhase {
  readonly index: number;
  readonly title: string;
}

export interface SubagentRunHandles {
  readonly runId?: string;
  readonly scriptPath?: string;
  readonly transcriptDir?: string;
  readonly sessionUrl?: string;
}

export interface RuntimeSubagent {
  readonly id: string;
  readonly kind: "subagent" | "subagent_batch" | "workflow" | "workflow_agent";
  readonly title: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: RuntimeSubagentStatus;
  readonly activationCount: number;
  readonly usage: SubagentUsage | null;
  readonly progress: string | null;
  readonly lastToolName: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly outputFile: string | null;
  readonly parentAgentId: string | null;
  readonly agentIndex: number | null;
  readonly phaseIndex: number | null;
  readonly phaseTitle: string | null;
  readonly attempt: number | null;
  readonly workflowName: string | null;
  readonly phases: ReadonlyArray<SubagentWorkflowPhase>;
  readonly runHandles: SubagentRunHandles | null;
  readonly recentActivity: ReadonlyArray<SubagentActivityEntry>;
  /** First retained observation, used as the roster's stable display order. */
  readonly firstSeenAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

const TERMINAL_STATUSES: ReadonlySet<RuntimeSubagentStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Active = the user may still need to care while it runs. Idle is settled-ish
 * but resumable; waiting counts as active because it needs the user. */
export function isActiveSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return isOrchestrationV2WorkActive(status);
}

/** Active run states are the only ones that can still emit subagent events. */
const TERMINAL_RUN_STATUSES = new Map<string, OrchestrationV2Subagent["status"]>([
  ["completed", "completed"],
  ["failed", "failed"],
  ["cancelled", "cancelled"],
  ["interrupted", "interrupted"],
  // Discarded work is not a cancellation the user asked for, but it did stop.
  ["rolled_back", "interrupted"],
]);

const ACTIVE_SUBAGENT_STATUSES: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "pending",
  "running",
  "waiting",
]);

/**
 * Settles subagents whose run already ended.
 *
 * A provider-native subagent advances only when its provider emits an event for
 * that native task. When the turn ends without one — killed process, dropped
 * native payload, cancelled run — the row keeps `running` forever: the panel
 * shows a live agent on a finished turn, `0/1 settled` never resolves, and the
 * elapsed counter runs for hours because `completedAt` stays null. Measured on
 * a real thread: 21 such rows, every one with `parent_node_status` and
 * `parent_run_status` already terminal.
 *
 * A terminal run cannot emit more events for its subagents, so they are settled
 * here rather than left to time out. Delegated subagents (`childThreadId`) are
 * exempt: a child thread outlives the parent run that launched it.
 */
export function settleSubagentsOfTerminalRuns(projection: {
  readonly runs?: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly completedAt: DateTime.Utc | null;
  }>;
  readonly nodes?: ReadonlyArray<{ readonly id: string; readonly runId: string | null }>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
}): ReadonlyArray<OrchestrationV2Subagent> {
  const runs = projection.runs ?? [];
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const runIdByNode = new Map(
    (projection.nodes ?? []).map((node) => [node.id, node.runId] as const),
  );
  const subagentsById = new Map(projection.subagents.map((subagent) => [subagent.id, subagent]));

  // A workflow member hangs off its coordinator subagent, which hangs off the
  // run's root node, so the owning run is found by walking up the chain.
  const runOf = (
    subagent: OrchestrationV2Subagent,
    seen: ReadonlySet<string> = new Set(),
  ): (typeof runs)[number] | null => {
    if (subagent.runId !== null) return runsById.get(subagent.runId) ?? null;
    const viaNode = runIdByNode.get(subagent.parentNodeId);
    if (viaNode != null) return runsById.get(viaNode) ?? null;
    const parent = subagentsById.get(subagent.parentNodeId);
    if (parent === undefined || seen.has(parent.id)) return null;
    return runOf(parent, new Set([...seen, subagent.id]));
  };

  return projection.subagents.map((subagent) => {
    if (!ACTIVE_SUBAGENT_STATUSES.has(subagent.status) || subagent.childThreadId !== null) {
      return subagent;
    }
    const run = runOf(subagent);
    const settledStatus = run === null ? undefined : TERMINAL_RUN_STATUSES.get(run.status);
    if (run === null || settledStatus === undefined) return subagent;
    const settledAt = run.completedAt ?? subagent.updatedAt;
    return {
      ...subagent,
      status: settledStatus,
      completedAt: subagent.completedAt ?? settledAt,
      updatedAt: subagent.updatedAt,
    };
  });
}

/**
 * Projects orchestration-v2 subagent entities into the runtime shape the web
 * and mobile agent rows render. A subagent carrying the provider-workflow
 * block keeps its workflow identity: the coordinator becomes `kind: "workflow"`,
 * each member `kind: "workflow_agent"` linked back through `parentNodeId`, and
 * the run's engine id lands in `runHandles.runId` for the card's run suffix.
 * Everything else projects exactly as before.
 */
export function projectedSubagentsToRuntime(
  subagents: ReadonlyArray<{
    readonly id: string;
    readonly title: string | null;
    readonly prompt: string;
    readonly model: string | null;
    readonly status: OrchestrationV2Subagent["status"];
    readonly progress?: string | undefined;
    readonly result: string | null;
    readonly parentNodeId?: string | undefined;
    readonly workflow?: OrchestrationV2Subagent["workflow"];
    readonly startedAt: DateTime.Utc | null;
    readonly completedAt: DateTime.Utc | null;
    readonly updatedAt: DateTime.Utc;
  }>,
): ReadonlyArray<RuntimeSubagent> {
  return subagents.map((subagent) => {
    const updatedAt = DateTime.formatIso(subagent.updatedAt);
    const startedAt = subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt);
    const workflow = subagent.workflow;
    return {
      id: subagent.id,
      kind: workflow?.kind ?? "subagent",
      title:
        subagent.title ??
        (subagent.prompt.length > 80 ? `${subagent.prompt.slice(0, 77)}...` : subagent.prompt),
      role: null,
      model: subagent.model,
      effort: null,
      status: subagent.status,
      activationCount: 1,
      usage: null,
      progress: subagent.progress ?? null,
      lastToolName: null,
      result: subagent.result,
      error: subagent.status === "failed" ? (subagent.result ?? null) : null,
      outputFile: null,
      // A workflow member hangs off its coordinator node; a coordinator and a
      // plain subagent have no agent parent.
      parentAgentId: workflow?.kind === "workflow_agent" ? (subagent.parentNodeId ?? null) : null,
      agentIndex: workflow?.agentIndex ?? null,
      phaseIndex: workflow?.phaseIndex ?? null,
      phaseTitle: workflow?.phaseTitle ?? null,
      attempt: null,
      workflowName: workflow?.workflowName ?? null,
      phases: workflow?.phases ?? [],
      runHandles: workflow?.runId == null ? null : { runId: workflow.runId },
      recentActivity: [],
      firstSeenAt: startedAt ?? updatedAt,
      startedAt,
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
      updatedAt,
    } satisfies RuntimeSubagent;
  });
}
