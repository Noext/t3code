/** Projects Pi workflow run snapshots as one coordinator subagent whose `agents[]` holds the members. */
import {
  type NodeId,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2WorkflowAgent,
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
}

export const emptyPiWorkflowTracker = (): PiWorkflowTracker => ({
  coordinator: new Map(),
});

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

/** The contract's agent states, which are coarser than Pi's (skipped completed too). */
const agentState = (status: PiWorkflowAgentStatus): OrchestrationV2WorkflowAgent["state"] => {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "done":
    case "skipped":
      return "completed";
    case "error":
      return "failed";
  }
};

const epochMillis = (value: string | undefined): number | undefined => {
  const parsed = value === undefined ? null : Option.getOrNull(DateTime.make(value));
  return parsed === null ? undefined : DateTime.toEpochMillis(parsed);
};

/** One workflow agent as the contract holds it: nested timestamps are epoch millis. */
const toWorkflowAgent = (
  agent: PiWorkflowAgentSnapshot,
  index: number,
  phases: OrchestrationV2SubagentWorkflow["phases"],
): OrchestrationV2WorkflowAgent => {
  const phaseIndex = phaseIndexFor(phases, agent.phase);
  const startedAt = epochMillis(agent.startedAt);
  const completedAt = epochMillis(agent.endedAt);
  return {
    index,
    label: agent.label,
    agentId: agent.id,
    state: agentState(agent.status),
    ...(phaseIndex === undefined ? {} : { phaseIndex }),
    ...(agent.phase === undefined ? {} : { phaseTitle: agent.phase }),
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.tokens === undefined ? {} : { totalTokens: agent.tokens }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
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
    totalTokensFor(run) ?? "",
    run.agents
      .map((agent) =>
        [
          agent.id,
          agent.status,
          agent.label,
          agent.model ?? "",
          agent.phase ?? "",
          agent.tokens ?? "",
          agent.startedAt ?? "",
          agent.endedAt ?? "",
        ].join("\u001e"),
      )
      .join("\u001f"),
  ].join("\u0001");

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
      name: run.workflowName,
      runHandles: { runId: run.runId },
      phases,
      agents: run.agents.map((agent, index) => toWorkflowAgent(agent, index, phases)),
      ...(totalTokensFor(run) === undefined ? {} : { totalTokens: totalTokensFor(run) }),
    },
    startedAt: parseIso(run.startedAt),
    completedAt: terminal ? parseIso(run.completedAt) : null,
    updatedAt: parseIso(run.updatedAt) ?? context.emittedAt,
  };
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
      continue;
    }

    if (terminal) {
      // The terminal row carries the final member states too: a short run crosses
      // several phases between two sweeps, so this is often the first row that
      // sees the last agents at all.
      subagents.push(buildCoordinator(run, input.context, previous.subagent.parentNodeId));
      coordinator.delete(run.runId);
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
  }

  return { subagents, tracker: { coordinator } };
}
