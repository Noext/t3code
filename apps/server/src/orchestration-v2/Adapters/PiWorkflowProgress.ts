/**
 * Pure translation from Pi workflow run snapshots to orchestration-v2
 * `subagent.updated` entities.
 *
 * A Pi workflow surfaces as one workflow card with a member row per workflow
 * agent. The coordinator is a `workflow` subagent carrying the run's full phase
 * list; its members are `workflow_agent` subagents linked back through
 * `parentNodeId`. Clients group a member under its coordinator by that link and
 * read the phase list from the coordinator to render the rail.
 *
 * The extensions rewrite their run state on a throttle (per-agent completion
 * plus a heartbeat), so a poll usually changes nothing. `reconcilePiWorkflowRuns`
 * carries a fingerprint tracker and emits only what actually changed, which
 * keeps a no-op poll free on the wire and in the operator's token budget.
 *
 * It also separates "the store did not return this run" from "the run is gone":
 * a run the reader listed but could not read is passed in `unresolvedRunIds`,
 * stays tracked, and emits nothing until it reads again. Only a tracked run
 * absent from both lists is treated as ended.
 *
 * @module orchestration-v2/Adapters/PiWorkflowProgress
 */
import {
  type NodeId,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderThreadId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type {
  PiWorkflowAgentSnapshot,
  PiWorkflowAgentStatus,
  PiWorkflowRunSnapshot,
  PiWorkflowRunStatus,
} from "./PiWorkflowStore.ts";

/**
 * Everything the pure diff needs to materialize a stable entity: identities,
 * the owning thread, and the clock stamp the adapter stamps one sweep with.
 */
export interface PiWorkflowProjectionContext {
  readonly threadId: ThreadId;
  /** Owning orchestration run, when the adapter can name one. */
  readonly runId: RunId | null;
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId | null;
  /** Parent of every coordinator: the turn root the sweep last saw. */
  readonly workflowRootNodeId: NodeId;
  readonly nodeForRun: (runId: string) => NodeId;
  readonly nodeForMember: (runId: string, agentId: string) => NodeId;
  readonly emittedAt: DateTime.Utc;
}

export interface PiWorkflowTracker {
  /** runId -> the coordinator status, rendered-field fingerprint, and last entity. */
  readonly coordinator: ReadonlyMap<
    string,
    {
      readonly status: PiWorkflowRunStatus;
      readonly fingerprint: string;
      readonly subagent: OrchestrationV2Subagent;
    }
  >;
  /** member taskId -> rendered-field fingerprint last emitted. */
  readonly members: ReadonlyMap<string, string>;
}

export const emptyPiWorkflowTracker = (): PiWorkflowTracker => ({
  coordinator: new Map(),
  members: new Map(),
});

/**
 * The same slot marker the pre-v2 activity stream used
 * (`<coordinatorId>:wf:<index>`). Kept as the member's native id so the two
 * surfaces share one identity scheme.
 */
const MEMBER_TASK_ID_SEPARATOR = ":wf:";

const memberNativeId = (runId: string, agentId: string): string =>
  `${runId}${MEMBER_TASK_ID_SEPARATOR}${agentId}`;

/** `NodeId.make` rejects a blank id, and a blank id is unusable anyway. */
const isUsableRunId = (value: string): boolean => value.trim().length > 0;

const parseIso = (value: string | undefined): DateTime.Utc | null => {
  if (value === undefined) return null;
  return Option.getOrElse(DateTime.make(value), () => null);
};

const refFor = (driver: ProviderDriverKind, nativeId: string): OrchestrationV2ProviderRef => ({
  driver,
  nativeId,
  strength: "strong",
});

const coordinatorStatus = (status: PiWorkflowRunStatus): OrchestrationV2Subagent["status"] => {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    // A paused run is resumable, not settled: clients show it idle.
    case "paused":
      return "idle";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "cancelled";
  }
};

const memberStatus = (status: PiWorkflowAgentStatus): OrchestrationV2Subagent["status"] => {
  switch (status) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "done":
    case "skipped":
      return "completed";
    case "error":
      return "failed";
  }
};

/** Phase strings are positional; a blank title still needs a non-empty label. */
const mapPhases = (phases: ReadonlyArray<string>): OrchestrationV2SubagentWorkflow["phases"] =>
  phases.map((title, index) => {
    const trimmed = title.trim();
    return { index, title: trimmed.length > 0 ? trimmed : `Phase ${index + 1}` };
  });

const phaseIndexFor = (
  mapped: OrchestrationV2SubagentWorkflow["phases"],
  phase: string | undefined,
): number | undefined => {
  const trimmed = phase?.trim();
  if (!trimmed) return undefined;
  const index = mapped.findIndex((entry) => entry.title === trimmed);
  return index >= 0 ? index : undefined;
};

/** Run-level total is completion-only; before that, sum the live agent rows. */
const totalTokensFor = (run: PiWorkflowRunSnapshot): number | undefined => {
  if (run.totalTokens !== undefined) return run.totalTokens;
  if (run.agents.length === 0) return undefined;
  return run.agents.reduce((sum, agent) => sum + (agent.tokens ?? 0), 0);
};

const coordinatorFingerprint = (run: PiWorkflowRunSnapshot): string =>
  [
    run.status,
    run.currentPhase ?? "",
    run.phases.join("\u001f"),
    run.agents.length,
    totalTokensFor(run) ?? "",
  ].join("\u0001");

const memberFingerprint = (agent: PiWorkflowAgentSnapshot): string =>
  [
    agent.status,
    agent.label,
    agent.model ?? "",
    agent.phase ?? "",
    agent.tokens ?? "",
    agent.startedAt ?? "",
    agent.endedAt ?? "",
  ].join("\u001f");

const buildCoordinator = (
  run: PiWorkflowRunSnapshot,
  context: PiWorkflowProjectionContext,
  // Reuse the anchor a tracked coordinator was first emitted with: a later
  // sweep can run after the launching turn ended, and moving the parent then
  // would silently extend the card's retention.
  parentNodeId: NodeId = context.workflowRootNodeId,
): OrchestrationV2Subagent => {
  const phases = mapPhases(run.phases);
  const terminal =
    run.status === "completed" || run.status === "failed" || run.status === "aborted";
  return {
    id: context.nodeForRun(run.runId),
    threadId: context.threadId,
    runId: context.runId,
    parentNodeId,
    origin: "provider_native",
    createdBy: "agent",
    driver: context.driver,
    providerInstanceId: context.providerInstanceId,
    providerThreadId: context.providerThreadId,
    childThreadId: null,
    nativeTaskRef: refFor(context.driver, run.runId),
    prompt: run.workflowName,
    title: run.workflowName,
    model: null,
    status: coordinatorStatus(run.status),
    ...(run.currentPhase === undefined ? {} : { progress: run.currentPhase }),
    result: run.status === "failed" ? (run.error ?? null) : null,
    workflow: {
      kind: "workflow",
      workflowName: run.workflowName,
      phases,
      phaseIndex: null,
      phaseTitle: null,
      agentIndex: null,
      runId: run.runId,
    },
    startedAt: parseIso(run.startedAt),
    completedAt: terminal ? parseIso(run.completedAt) : null,
    updatedAt: parseIso(run.updatedAt) ?? context.emittedAt,
  };
};

const buildMember = (
  run: PiWorkflowRunSnapshot,
  agent: PiWorkflowAgentSnapshot,
  index: number,
  mappedPhases: OrchestrationV2SubagentWorkflow["phases"],
  context: PiWorkflowProjectionContext,
): OrchestrationV2Subagent => {
  const phaseIndex = phaseIndexFor(mappedPhases, agent.phase);
  const finished =
    agent.status === "done" || agent.status === "error" || agent.status === "skipped";
  return {
    id: context.nodeForMember(run.runId, agent.id),
    threadId: context.threadId,
    runId: context.runId,
    parentNodeId: context.nodeForRun(run.runId),
    origin: "provider_native",
    createdBy: "agent",
    driver: context.driver,
    providerInstanceId: context.providerInstanceId,
    providerThreadId: context.providerThreadId,
    childThreadId: null,
    nativeTaskRef: refFor(context.driver, memberNativeId(run.runId, agent.id)),
    prompt: agent.label,
    title: agent.label,
    model: agent.model ?? null,
    status: memberStatus(agent.status),
    result: null,
    workflow: {
      kind: "workflow_agent",
      workflowName: run.workflowName,
      // The coordinator owns the phase list; a member only points at its phase.
      phases: [],
      phaseIndex: phaseIndex ?? null,
      phaseTitle: agent.phase ?? null,
      agentIndex: index,
      runId: run.runId,
    },
    startedAt: parseIso(agent.startedAt),
    completedAt: finished ? parseIso(agent.endedAt) : null,
    updatedAt: parseIso(agent.endedAt ?? agent.startedAt) ?? context.emittedAt,
  };
};

const memberProgress = (
  run: PiWorkflowRunSnapshot,
  mappedPhases: OrchestrationV2SubagentWorkflow["phases"],
  members: Map<string, string>,
  context: PiWorkflowProjectionContext,
  force: boolean,
): ReadonlyArray<OrchestrationV2Subagent> => {
  const subagents: Array<OrchestrationV2Subagent> = [];
  run.agents.forEach((agent, index) => {
    const taskId = memberNativeId(run.runId, agent.id);
    const fingerprint = memberFingerprint(agent);
    if (!force && members.get(taskId) === fingerprint) return;
    members.set(taskId, fingerprint);
    subagents.push(buildMember(run, agent, index, mappedPhases, context));
  });
  return subagents;
};

const dropMemberFingerprints = (members: Map<string, string>, runId: string): void => {
  const prefix = `${runId}${MEMBER_TASK_ID_SEPARATOR}`;
  for (const key of members.keys()) {
    if (key.startsWith(prefix)) members.delete(key);
  }
};

/**
 * Diff this sweep's snapshots against the last emitted state. Returns the
 * subagent updates to emit and the tracker to carry into the next sweep.
 */
export function reconcilePiWorkflowRuns(input: {
  readonly runs: ReadonlyArray<PiWorkflowRunSnapshot>;
  /**
   * Runs the store listed but could not read this sweep. They are present, not
   * ended: keep them tracked, emit nothing.
   */
  readonly unresolvedRunIds: ReadonlyArray<string>;
  readonly tracker: PiWorkflowTracker;
  readonly context: PiWorkflowProjectionContext;
}): {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly tracker: PiWorkflowTracker;
} {
  const subagents: Array<OrchestrationV2Subagent> = [];
  const coordinator = new Map(input.tracker.coordinator);
  const members = new Map(input.tracker.members);
  // A run is only really gone when the store neither returned it nor reported it
  // as unreadable. Absence alone is also what an unreadable file looks like, and
  // reporting that as interrupted both lies to the panel and drops the run from
  // the tracker, losing the completion that lands once the file reads again.
  const present = new Set<string>(input.unresolvedRunIds);

  for (const run of input.runs) {
    // The store rejects a record without a usable run id, but this diff is the
    // one place `NodeId.make` would throw, and a throw here happens before the
    // tracker advances: one bad record would repeat on every sweep and silence
    // every run in the thread. A guard beats a defect.
    if (!isUsableRunId(run.runId)) continue;
    present.add(run.runId);
    const previous = coordinator.get(run.runId);
    const terminal =
      run.status === "completed" || run.status === "failed" || run.status === "aborted";

    if (!previous) {
      // Don't adopt history: a run is shown only if this server watched it
      // start or it is live right now. A terminal run found cold is old.
      if (terminal || run.status === "paused") continue;
      const built = buildCoordinator(run, input.context);
      coordinator.set(run.runId, {
        status: run.status,
        fingerprint: coordinatorFingerprint(run),
        subagent: built,
      });
      subagents.push(built);
      subagents.push(...memberProgress(run, mapPhases(run.phases), members, input.context, true));
      continue;
    }

    if (terminal) {
      // Final member states, BEFORE the coordinator's terminal row. A phase only
      // gains members once the run reaches it, and a short run crosses several
      // phases between two sweeps, so the sweep that sees the run end is often
      // the first to see the last agents at all. The coordinator's terminal row
      // still settles the run; these rows only describe what it settled.
      subagents.push(...memberProgress(run, mapPhases(run.phases), members, input.context, false));
      subagents.push(buildCoordinator(run, input.context, previous.subagent.parentNodeId));
      coordinator.delete(run.runId);
      dropMemberFingerprints(members, run.runId);
      continue;
    }

    if (run.status === "paused") {
      const built = buildCoordinator(run, input.context, previous.subagent.parentNodeId);
      if (previous.status !== "paused") subagents.push(built);
      // Store the *paused* fingerprint, not the pre-pause one: a resume whose
      // other fields are unchanged must still emit, or the coordinator row keeps
      // reading idle while the run is running again.
      coordinator.set(run.runId, {
        status: run.status,
        fingerprint: coordinatorFingerprint(run),
        subagent: built,
      });
      continue;
    }

    const fingerprint = coordinatorFingerprint(run);
    if (fingerprint !== previous.fingerprint) {
      const built = buildCoordinator(run, input.context, previous.subagent.parentNodeId);
      subagents.push(built);
      coordinator.set(run.runId, { status: run.status, fingerprint, subagent: built });
    }
    subagents.push(...memberProgress(run, mapPhases(run.phases), members, input.context, false));
  }

  for (const runId of input.tracker.coordinator.keys()) {
    if (present.has(runId)) continue;
    const previous = input.tracker.coordinator.get(runId);
    if (previous === undefined) continue;
    subagents.push({
      ...previous.subagent,
      status: "interrupted",
      completedAt: input.context.emittedAt,
      updatedAt: input.context.emittedAt,
    });
    coordinator.delete(runId);
    dropMemberFingerprints(members, runId);
  }

  return { subagents, tracker: { coordinator, members } };
}
