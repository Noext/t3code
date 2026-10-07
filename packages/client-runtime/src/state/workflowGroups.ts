/**
 * The workflow card's view model, shared by web and mobile: groups the runtime
 * subagents of a thread projection into one card per workflow run, its phases,
 * and the members that ran in each. Both clients feed this the output of
 * `projectedSubagentsToRuntime`, so the grouping has a single source of truth.
 *
 * Workflow cards always come from the thread roster: a run outlives the turn
 * that launched it, and its coordinator carries no orchestration run id, so a
 * turn-scoped roster would drop it. Direct spawns are the opposite: a thread
 * accumulates every agent it ever spawned, so a surface that shows "this
 * turn" passes that turn's roster as `directScope`.
 */
import {
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type RuntimeSubagent,
  type SubagentRunHandles,
} from "./subagentRuntime.ts";

export interface WorkflowPhaseGroup {
  readonly index: number;
  readonly title: string;
  readonly members: ReadonlyArray<RuntimeSubagent>;
  /**
   * done = every member settled (success or error); running = any active.
   * skipped = the run is over (terminal coordinator) and this phase never
   * got a member: the rail must not keep advertising work that will never
   * arrive. A paused run is resumable, so its unreached phases stay pending.
   */
  readonly state: "pending" | "running" | "done" | "skipped";
  readonly activeCount: number;
  readonly settledCount: number;
}

export interface WorkflowAgentGroup {
  readonly workflow: RuntimeSubagent;
  /** Workflow name plus the unique run suffix, ready for the card header. */
  readonly label: string;
  readonly phases: ReadonlyArray<WorkflowPhaseGroup>;
  /** Members with no resolvable phase (orphans render under the workflow). */
  readonly unphasedMembers: ReadonlyArray<RuntimeSubagent>;
}

export interface AgentPanelModel {
  readonly workflows: ReadonlyArray<WorkflowAgentGroup>;
  /**
   * Spawns that belong to no workflow card, scoped to `directScope`. A direct
   * caller (web, tests) gets the whole roster; a turn-scoped surface passes
   * that turn's roster so old turns never resurface.
   */
  readonly directAgents: ReadonlyArray<RuntimeSubagent>;
  /** Whether the panel has a workflow card or a direct row to show. */
  readonly hasAgents: boolean;
  /**
   * Thread-wide live agents. Not scoped to `directScope`: a running workflow
   * member has to keep its card's elapsed timers moving, and it never appears
   * in a turn's direct rows.
   */
  readonly liveCount: number;
}

const EMPTY_PANEL_MODEL: AgentPanelModel = {
  workflows: [],
  directAgents: [],
  hasAgents: false,
  liveCount: 0,
};

export function deriveAgentPanelModel(
  agents: ReadonlyArray<RuntimeSubagent>,
  directScope: ReadonlyArray<RuntimeSubagent> = agents,
): AgentPanelModel {
  if (agents.length === 0 && directScope.length === 0) {
    return EMPTY_PANEL_MODEL;
  }

  const workflows = agents
    .filter((agent) => agent.kind === "workflow")
    .slice()
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const members = new Map<string, RuntimeSubagent[]>();
  const direct: RuntimeSubagent[] = [];

  // Members are always read from the thread roster: a workflow card must show
  // its agents even when the caller scopes direct rows to one turn.
  for (const agent of agents) {
    if (agent.kind === "workflow") {
      continue;
    }
    if (agent.parentAgentId !== null && workflowIds.has(agent.parentAgentId)) {
      const list = members.get(agent.parentAgentId) ?? [];
      list.push(agent);
      members.set(agent.parentAgentId, list);
    }
  }
  for (const agent of directScope) {
    if (agent.kind === "workflow") {
      continue;
    }
    if (agent.parentAgentId !== null && workflowIds.has(agent.parentAgentId)) {
      continue;
    }
    // Orphaned members (coordinator aged out) fall back to the direct list.
    direct.push(agent);
  }

  const workflowGroups: WorkflowAgentGroup[] = workflows.map((workflow) => {
    const workflowMembers = members.get(workflow.id) ?? [];
    const knownPhases =
      workflow.phases.length > 0
        ? workflow.phases
        : (() => {
            const derived = new Map<number, string>();
            for (const member of workflowMembers) {
              if (member.phaseIndex !== null && !derived.has(member.phaseIndex)) {
                derived.set(
                  member.phaseIndex,
                  member.phaseTitle ?? `Phase ${member.phaseIndex + 1}`,
                );
              }
            }
            return Array.from(derived.entries())
              .map(([index, title]) => ({ index, title }))
              .slice()
              .sort((a, b) => a.index - b.index);
          })();

    const knownPhaseIndices = new Set(knownPhases.map((phase) => phase.index));
    // A terminal coordinator means the run is over, nothing in it is still
    // waiting to start. Pi (like any multi-phase workflow) declares its whole
    // phase list up front, so a run that completed, failed, or was stopped
    // before a phase began leaves that phase with no members — deriving phase
    // state from membership alone then painted a finished run's last phase
    // "pending" forever. A paused run is NOT terminal: it is resumable, so its
    // unreached phases must keep reading pending for the rail to advance.
    const runFinished = isTerminalSubagentStatus(workflow.status);
    const phases = knownPhases.map((phase) => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .slice()
        .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));
      const activeCount = phaseMembers.filter(
        // Idle members count as active for phase-liveness: a resumable member
        // has not finished the phase.
        (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
      ).length;
      const settledCount = phaseMembers.filter((member) =>
        isTerminalSubagentStatus(member.status),
      ).length;
      const state: "pending" | "running" | "done" | "skipped" =
        phaseMembers.length === 0
          ? runFinished
            ? "skipped"
            : "pending"
          : activeCount > 0
            ? // The run is over even if a member is still idle: the coordinator
              // having settled is what decides, and a finished run cannot leave
              // a live phase behind.
              runFinished
              ? "done"
              : "running"
            : settledCount === phaseMembers.length
              ? "done"
              : runFinished
                ? "skipped"
                : "pending";
      return {
        index: phase.index,
        title: phase.title,
        members: phaseMembers,
        state,
        activeCount,
        settledCount,
      };
    });

    // Unknown phase indices land here too — a member must never vanish just
    // because its phase row was lost.
    const unphasedMembers = workflowMembers
      .filter((member) => member.phaseIndex === null || !knownPhaseIndices.has(member.phaseIndex))
      .slice()
      .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));

    return { workflow, label: formatWorkflowRunLabel(workflow), phases, unphasedMembers };
  });

  let liveCount = 0;
  for (const agent of agents) {
    // A workflow coordinator with members is a container for those members, not
    // work of its own: it reports running for the whole run. Counting it would
    // report one more agent working than there are.
    if (agent.kind === "workflow" && (members.get(agent.id) ?? []).length > 0) continue;
    if (isActiveSubagentStatus(agent.status)) liveCount += 1;
  }

  return {
    workflows: workflowGroups,
    // Updates and retention ranking must never reshuffle rows that remain
    // visible.
    directAgents: direct
      .slice()
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id)),
    hasAgents: workflowGroups.length > 0 || direct.length > 0,
    liveCount,
  };
}

/**
 * The short, stable tail of a workflow run id, for telling two runs of the
 * same workflow apart. Pi's writer names a run `<slug>-<ts36>-<rand>`
 * (`generateRunId` in @quintinshaw/pi-dynamic-workflows), so the last two
 * hyphen-separated segments are exactly the part that differs between two runs
 * of one workflow: the slug identifies the workflow, the timestamp plus random
 * tail identifies the run. `null` when there is nothing usable (missing or
 * hyphen-only id), so a caller degrades to the bare name rather than rendering
 * an empty or broken label.
 */
export function workflowRunSuffix(runId: string | null | undefined): string | null {
  const trimmed = runId?.trim();
  if (!trimmed) return null;
  const segments = trimmed.split("-").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  // Whole id when it has fewer than two usable segments. Cap the tail so an
  // un-hyphenated foreign id cannot blow up a one-line card label; Pi's own
  // tail is 6-7 chars of base36 plus the separator.
  const suffix = segments.slice(-2).join("-");
  return suffix.length > 32 ? suffix.slice(-32) : suffix;
}

/**
 * The workflow card's one-line identity: the workflow name plus the run's own
 * suffix (`pi_workflow_phase_pending_fix · mu5n6tcx-i253rw`). Two runs of the
 * same workflow share the name, so without the suffix the card renders the
 * same label twice. When the name already carries the suffix (the interrupted
 * fallback sets the name to the full run id) the suffix is not repeated.
 */
export function formatWorkflowRunLabel(workflow: {
  readonly workflowName: string | null;
  readonly title: string;
  readonly runHandles: SubagentRunHandles | null;
}): string {
  const name = workflow.workflowName ?? workflow.title;
  const suffix = workflowRunSuffix(workflow.runHandles?.runId);
  if (!suffix || name.includes(suffix)) return name;
  return `${name} · ${suffix}`;
}
