/**
 * Pure translation from Pi workflow run snapshots to T3's canonical `task.*`
 * events.
 *
 * A Pi workflow surfaces through the same activity stream Claude's Workflow
 * tool already uses: one coordinator row (`taskType: "local_workflow"`) plus a
 * `task.progress` row per workflow agent, keyed off the coordinator. Reusing
 * that vocabulary is why this feature needs no new contract, transport, or
 * client component — the Agents panel, the sidebar pulse, and the mobile
 * work-log banner all consume it already. Members carry the same `:wf:` slot
 * marker Claude's rows do, so both work-log surfaces fold them into the
 * coordinator's `wf:<runId>` group instead of rendering loose direct spawns.
 *
 * The extension rewrites the run file on a throttle (per-agent completion plus
 * a heartbeat), so a poll usually changes nothing. `reconcilePiWorkflowRuns`
 * carries a fingerprint tracker and emits only what actually changed, which
 * keeps a no-op poll free on the wire and in the operator's token budget.
 *
 * It also separates "the store did not return this run" from "the run is gone":
 * a run the reader listed but could not read is passed in `unresolvedRunIds`,
 * stays tracked, and emits nothing until it reads again. Only a tracked run
 * absent from both lists is treated as ended.
 *
 * @module provider/pi/PiWorkflowProgress
 */
import {
  RuntimeTaskId,
  type RuntimeTaskStatus,
  type TaskCompletedPayload,
  type TaskProgressPayload,
  type TaskStartedPayload,
  type TaskUpdatedPayload,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  PiWorkflowAgentSnapshot,
  PiWorkflowAgentStatus,
  PiWorkflowRunSnapshot,
  PiWorkflowRunStatus,
} from "./PiWorkflowStore.ts";

export const PI_WORKFLOW_TASK_TYPE = "local_workflow";

/**
 * The same slot marker Claude's workflow rows use (`<coordinatorId>:wf:<index>`).
 * Both work-log surfaces group any task id containing it under `wf:<prefix>`,
 * and the coordinator groups under `wf:<taskId>`, so the same marker is what puts
 * a member row in its coordinator's group rather than in a loose direct spawn.
 */
const MEMBER_TASK_ID_SEPARATOR = ":wf:";

const decodeTaskId = Schema.decodeUnknownOption(RuntimeTaskId);

/** `RuntimeTaskId.make` throws on an empty id; a blank id is unusable too. */
const isUsableTaskId = (value: string): boolean => Option.isSome(decodeTaskId(value));

export type PiWorkflowEmission =
  | { readonly type: "task.started"; readonly payload: TaskStartedPayload }
  | { readonly type: "task.progress"; readonly payload: TaskProgressPayload }
  | { readonly type: "task.updated"; readonly payload: TaskUpdatedPayload }
  | { readonly type: "task.completed"; readonly payload: TaskCompletedPayload };

export interface PiWorkflowTracker {
  /** runId -> the status and rendered-field fingerprint last emitted. */
  readonly coordinator: ReadonlyMap<
    string,
    { readonly status: PiWorkflowRunStatus; readonly fingerprint: string }
  >;
  /** member taskId -> rendered-field fingerprint last emitted. */
  readonly members: ReadonlyMap<string, string>;
}

export const emptyPiWorkflowTracker = (): PiWorkflowTracker => ({
  coordinator: new Map(),
  members: new Map(),
});

const memberTaskId = (runId: string, agentId: string): string =>
  `${runId}${MEMBER_TASK_ID_SEPARATOR}${agentId}`;

const runtimeStatusForAgent = (status: PiWorkflowAgentStatus | undefined): RuntimeTaskStatus => {
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
    default:
      return "pending";
  }
};

/** Phase strings are positional; a blank title still needs a non-empty label. */
const mapPhases = (
  phases: ReadonlyArray<string>,
): ReadonlyArray<{ index: number; title: string }> =>
  phases.map((title, index) => {
    const trimmed = title.trim();
    return { index, title: trimmed.length > 0 ? trimmed : `Phase ${index + 1}` };
  });

const phaseIndexFor = (
  mapped: ReadonlyArray<{ readonly index: number; readonly title: string }>,
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

const boundedTokens = (tokens: number | undefined): { totalTokens: number } | undefined =>
  tokens === undefined ? undefined : { totalTokens: Math.max(0, Math.trunc(tokens)) };

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

const coordinatorLinkage = (run: PiWorkflowRunSnapshot) => ({
  taskType: PI_WORKFLOW_TASK_TYPE,
  title: run.workflowName,
  workflowName: run.workflowName,
  runHandles: { runId: run.runId },
});

const buildStarted = (run: PiWorkflowRunSnapshot): PiWorkflowEmission => {
  const phases = mapPhases(run.phases);
  return {
    type: "task.started",
    payload: {
      taskId: RuntimeTaskId.make(run.runId),
      description: run.workflowName,
      ...coordinatorLinkage(run),
      ...(phases.length > 0 ? { phases } : {}),
    },
  };
};

const buildProgress = (run: PiWorkflowRunSnapshot): PiWorkflowEmission => {
  const phases = mapPhases(run.phases);
  const tokens = boundedTokens(totalTokensFor(run));
  return {
    type: "task.progress",
    payload: {
      taskId: RuntimeTaskId.make(run.runId),
      description: run.workflowName,
      status: "running",
      ...coordinatorLinkage(run),
      ...(run.currentPhase ? { summary: run.currentPhase } : {}),
      ...(phases.length > 0 ? { phases } : {}),
      ...(tokens ? { typedUsage: tokens } : {}),
    },
  };
};

/** A paused run is still resumable, so the card stays but the pulse stops. */
const buildIdle = (run: PiWorkflowRunSnapshot): PiWorkflowEmission => ({
  type: "task.updated",
  payload: {
    taskId: RuntimeTaskId.make(run.runId),
    status: "idle",
    description: run.workflowName,
    ...coordinatorLinkage(run),
  },
});

const buildCompleted = (run: PiWorkflowRunSnapshot): PiWorkflowEmission => {
  const phases = mapPhases(run.phases);
  const tokens = boundedTokens(totalTokensFor(run));
  const status =
    run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "stopped";
  return {
    type: "task.completed",
    payload: {
      taskId: RuntimeTaskId.make(run.runId),
      status,
      ...coordinatorLinkage(run),
      ...(status === "failed" && run.error ? { summary: run.error } : {}),
      ...(status === "stopped" ? { summary: "Workflow run stopped." } : {}),
      ...(tokens ? { typedUsage: tokens } : {}),
      ...(phases.length > 0 ? { phases } : {}),
    },
  };
};

/**
 * A tracked run that is absent from the whole sweep — not merely unreadable —
 * clears its liveness instead of pulsing forever.
 */
const buildInterrupted = (runId: string): PiWorkflowEmission => ({
  type: "task.updated",
  payload: {
    taskId: RuntimeTaskId.make(runId),
    status: "interrupted",
    error: "The workflow run is no longer available.",
    taskType: PI_WORKFLOW_TASK_TYPE,
    title: runId,
    workflowName: runId,
    runHandles: { runId },
  },
});

const memberProgress = (
  run: PiWorkflowRunSnapshot,
  members: Map<string, string>,
  force: boolean,
): ReadonlyArray<PiWorkflowEmission> => {
  const mappedPhases = mapPhases(run.phases);
  const emissions: Array<PiWorkflowEmission> = [];
  run.agents.forEach((agent, index) => {
    const taskId = memberTaskId(run.runId, agent.id);
    const fingerprint = memberFingerprint(agent);
    if (!force && members.get(taskId) === fingerprint) return;
    members.set(taskId, fingerprint);
    const phaseIndex = phaseIndexFor(mappedPhases, agent.phase);
    const tokens = boundedTokens(agent.tokens);
    emissions.push({
      type: "task.progress",
      payload: {
        taskId: RuntimeTaskId.make(taskId),
        description: agent.label,
        status: runtimeStatusForAgent(agent.status),
        title: agent.label,
        parentAgentId: run.runId,
        agentIndex: index,
        timelineBypass: true,
        ...(agent.phase ? { phaseTitle: agent.phase } : {}),
        ...(phaseIndex !== undefined ? { phaseIndex } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(tokens ? { typedUsage: tokens } : {}),
      },
    });
  });
  return emissions;
};

const dropMemberFingerprints = (members: Map<string, string>, runId: string): void => {
  const prefix = `${runId}${MEMBER_TASK_ID_SEPARATOR}`;
  for (const key of members.keys()) {
    if (key.startsWith(prefix)) members.delete(key);
  }
};

/**
 * Diff this sweep's snapshots against the last emitted state. Returns the
 * events to emit and the tracker to carry into the next sweep.
 */
export function reconcilePiWorkflowRuns(input: {
  readonly runs: ReadonlyArray<PiWorkflowRunSnapshot>;
  /**
   * Runs the store listed but could not read this sweep. They are present, not
   * ended: keep them tracked, emit nothing.
   */
  readonly unresolvedRunIds: ReadonlyArray<string>;
  readonly tracker: PiWorkflowTracker;
}): { readonly emissions: ReadonlyArray<PiWorkflowEmission>; readonly tracker: PiWorkflowTracker } {
  const emissions: Array<PiWorkflowEmission> = [];
  const coordinator = new Map(input.tracker.coordinator);
  const members = new Map(input.tracker.members);
  // A run is only really gone when the store neither returned it nor reported it
  // as unreadable. Absence alone is also what an unreadable file looks like, and
  // reporting that as interrupted both lies to the panel and drops the run from
  // the tracker, losing the completion that lands once the file reads again.
  const present = new Set<string>(input.unresolvedRunIds);

  for (const run of input.runs) {
    // The store rejects a record without a usable run id, but this diff is the
    // one place `RuntimeTaskId.make` would throw, and a throw here happens
    // before the tracker advances: one bad record would repeat on every sweep
    // and silence every run in the thread. A guard beats a defect.
    if (!isUsableTaskId(run.runId)) continue;
    present.add(run.runId);
    const previous = coordinator.get(run.runId);
    const terminal =
      run.status === "completed" || run.status === "failed" || run.status === "aborted";

    if (!previous) {
      // Don't adopt history: a run is shown only if this server watched it
      // start or it is live right now. A terminal run found cold is old.
      if (terminal || run.status === "paused") continue;
      coordinator.set(run.runId, {
        status: run.status,
        fingerprint: coordinatorFingerprint(run),
      });
      emissions.push(buildStarted(run));
      emissions.push(...memberProgress(run, members, true));
      continue;
    }

    if (terminal) {
      // Final member states, BEFORE the completion row. A phase only gains
      // members once the run reaches it, and a short run crosses several phases
      // between two sweeps (the operator's `test_3_etapes` ran end to end in
      // ~5s, i.e. two sweeps), so the sweep that sees the run end is often the
      // first to see the last agents at all. Emitting only the completion
      // dropped those rows on the floor: the phase then had no member in the
      // stored state, so the panel could never render the work that actually
      // ran and showed the phase unresolved instead. The coordinator's terminal
      // row still settles the run; these rows only describe what it settled.
      emissions.push(...memberProgress(run, members, false));
      emissions.push(buildCompleted(run));
      coordinator.delete(run.runId);
      dropMemberFingerprints(members, run.runId);
      continue;
    }

    if (run.status === "paused") {
      if (previous.status !== "paused") emissions.push(buildIdle(run));
      // Store the *paused* fingerprint, not the pre-pause one: a resume whose
      // other fields are unchanged must still emit, or the coordinator row keeps
      // reading idle while the run is running again.
      coordinator.set(run.runId, { status: run.status, fingerprint: coordinatorFingerprint(run) });
      continue;
    }

    const fingerprint = coordinatorFingerprint(run);
    if (fingerprint !== previous.fingerprint) {
      emissions.push(buildProgress(run));
      coordinator.set(run.runId, { status: run.status, fingerprint });
    }
    emissions.push(...memberProgress(run, members, false));
  }

  for (const runId of input.tracker.coordinator.keys()) {
    if (present.has(runId)) continue;
    emissions.push(buildInterrupted(runId));
    coordinator.delete(runId);
    dropMemberFingerprints(members, runId);
  }

  return { emissions, tracker: { coordinator, members } };
}
