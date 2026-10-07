import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  emptyPiWorkflowTracker,
  reconcilePiWorkflowRuns,
  type PiWorkflowProjectionContext,
  type PiWorkflowTracker,
} from "./PiWorkflowProgress.ts";
import type { PiWorkflowRunSnapshot } from "./PiWorkflowStore.ts";

const EMITTED_AT = DateTime.makeUnsafe("2026-09-17T09:00:00.000Z");

const context = (
  overrides: Partial<PiWorkflowProjectionContext> = {},
): PiWorkflowProjectionContext => ({
  threadId: ThreadId.make("thread-1"),
  runId: null,
  driver: ProviderDriverKind.make("pi"),
  providerInstanceId: ProviderInstanceId.make("pi"),
  providerThreadId: ProviderThreadId.make("provider-thread-1"),
  workflowRootNodeId: NodeId.make("node:workflow-root"),
  nodeForRun: (runId) => NodeId.make(`node:workflow:${runId}`),
  nodeForMember: (runId, agentId) => NodeId.make(`node:workflow:${runId}:wf:${agentId}`),
  emittedAt: EMITTED_AT,
  ...overrides,
});

const run = (overrides: Partial<PiWorkflowRunSnapshot> = {}): PiWorkflowRunSnapshot => ({
  runId: "run-1",
  workflowName: "Adapter hardening",
  status: "running",
  phases: ["Recon", "Fix"],
  currentPhase: "Recon",
  agents: [
    {
      id: "1",
      label: "recon-store",
      phase: "Recon",
      status: "running",
      model: "local-openai/opencode-go/deepseek-v4.1-flash:high",
      tokens: 10,
      startedAt: "2026-09-17T08:04:33.118Z",
      endedAt: undefined,
    },
  ],
  sessionId: "session-a",
  parentSessionId: "session-a",
  error: undefined,
  totalTokens: undefined,
  startedAt: "2026-09-17T08:04:33.118Z",
  updatedAt: "2026-09-17T08:05:33.118Z",
  completedAt: undefined,
  durationMs: undefined,
  ...overrides,
});

const reconcile = (
  runs: ReadonlyArray<PiWorkflowRunSnapshot>,
  tracker: PiWorkflowTracker,
  unresolvedRunIds: ReadonlyArray<string> = [],
) =>
  reconcilePiWorkflowRuns({
    runs,
    unresolvedRunIds,
    tracker,
    context: context(),
  });

const kinds = (subagents: ReadonlyArray<OrchestrationV2Subagent>) =>
  subagents.map((subagent) => subagent.workflow?.kind);

describe("PiWorkflowProgress", () => {
  it("adopts a live run with a workflow card and one member row per agent", () => {
    const { subagents } = reconcile([run()], emptyPiWorkflowTracker());

    expect(kinds(subagents)).toEqual(["workflow", "workflow_agent"]);
    const coordinator = subagents[0]!;
    expect(coordinator).toMatchObject({
      id: "node:workflow:run-1",
      parentNodeId: "node:workflow-root",
      status: "running",
      title: "Adapter hardening",
      progress: "Recon",
      workflow: {
        kind: "workflow",
        workflowName: "Adapter hardening",
        phases: [
          { index: 0, title: "Recon" },
          { index: 1, title: "Fix" },
        ],
        phaseIndex: null,
        phaseTitle: null,
        agentIndex: null,
        runId: "run-1",
      },
    });

    const member = subagents[1]!;
    expect(member).toMatchObject({
      id: "node:workflow:run-1:wf:1",
      parentNodeId: "node:workflow:run-1",
      status: "running",
      title: "recon-store",
      model: "local-openai/opencode-go/deepseek-v4.1-flash:high",
      workflow: {
        kind: "workflow_agent",
        workflowName: "Adapter hardening",
        phaseIndex: 0,
        phaseTitle: "Recon",
        agentIndex: 0,
        runId: "run-1",
      },
    });
  });

  it("keeps a tracked coordinator's anchor when a later sweep reports a different root", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const moved = reconcilePiWorkflowRuns({
      runs: [run({ currentPhase: "Fix" })],
      unresolvedRunIds: [],
      tracker: first.tracker,
      context: context({ workflowRootNodeId: NodeId.make("node:new-root") }),
    });

    const coordinator = moved.subagents.find((entry) => entry.workflow?.kind === "workflow");
    expect(coordinator?.parentNodeId).toBe("node:workflow-root");
  });

  it("carries a terminal run's full phase list so an unreached phase cannot read pending", () => {
    const runId = "pi-workflow-sidebar-recon-mu5iej8f-dcgowe";
    const reconAgent = (
      id: string,
      label: string,
      status: PiWorkflowRunSnapshot["agents"][number]["status"],
      endedAt: string | undefined,
    ) => ({
      id,
      label,
      phase: "Recon",
      status,
      model: "local-openai/opencode-go/deepseek-v4.1-flash:high",
      tokens: 100,
      startedAt: "2026-09-17T12:32:00.000Z",
      endedAt,
    });

    const live = run({
      runId,
      phases: ["Recon", "Design"],
      currentPhase: "Recon",
      agents: [reconAgent("1", "recon-store", "running", undefined)],
    });
    const first = reconcile([live], emptyPiWorkflowTracker());
    expect(first.subagents[0]?.workflow?.phases).toEqual([
      { index: 0, title: "Recon" },
      { index: 1, title: "Design" },
    ]);

    const aborted = run({
      runId,
      status: "aborted",
      phases: ["Recon", "Design"],
      currentPhase: "Recon",
      agents: [
        reconAgent("1", "recon-store", "done", "2026-09-17T12:40:00.000Z"),
        reconAgent("2", "recon-surface", "done", "2026-09-17T12:41:00.000Z"),
        reconAgent("3", "recon-precedent", "done", "2026-09-17T12:42:00.000Z"),
        reconAgent("4", "recon-adapter", "skipped", "2026-09-17T12:43:00.000Z"),
      ],
      completedAt: "2026-09-17T12:49:29.570Z",
    });
    const done = reconcile([aborted], first.tracker);

    // The terminal sweep also re-states the members whose final fields changed:
    // agent 1 was running when the run was last emitted and is done here, and
    // agents 2-4 are seen at all only on this sweep.
    expect(kinds(done.subagents)).toEqual([
      "workflow_agent",
      "workflow_agent",
      "workflow_agent",
      "workflow_agent",
      "workflow",
    ]);
    expect(done.subagents[4]).toMatchObject({
      status: "cancelled",
      workflow: {
        kind: "workflow",
        phases: [
          { index: 0, title: "Recon" },
          { index: 1, title: "Design" },
        ],
      },
    });
  });

  it("emits nothing when a poll changed nothing", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const second = reconcile([run()], first.tracker);
    expect(second.subagents).toEqual([]);
    expect(second.tracker).toEqual(first.tracker);
  });

  it("emits only the member whose rendered fields changed", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const changed: PiWorkflowRunSnapshot = run({
      agents: [
        {
          id: "1",
          label: "recon-store",
          phase: "Recon",
          status: "running",
          model: "local-openai/opencode-go/deepseek-v4.1-flash:high",
          tokens: 10,
          startedAt: "2026-09-17T08:04:33.118Z",
          endedAt: undefined,
        },
        {
          id: "2",
          label: "impl",
          phase: "Fix",
          status: "running",
          model: "m",
          tokens: 5,
          startedAt: "2026-09-17T08:06:00.000Z",
          endedAt: undefined,
        },
      ],
      currentPhase: "Fix",
    });
    const second = reconcile([changed], first.tracker);

    expect(kinds(second.subagents)).toEqual(["workflow", "workflow_agent"]);
    expect(second.subagents[0]).toMatchObject({ progress: "Fix" });
    expect(second.subagents[1]).toMatchObject({
      id: "node:workflow:run-1:wf:2",
      workflow: { phaseIndex: 1, phaseTitle: "Fix", agentIndex: 1 },
    });
  });

  it("completes a tracked run once and then stays silent", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const done = reconcile(
      [run({ status: "completed", completedAt: "2026-09-17T09:00:00.000Z", durationMs: 1000 })],
      first.tracker,
    );

    expect(kinds(done.subagents)).toEqual(["workflow"]);
    expect(done.subagents[0]).toMatchObject({ status: "completed" });

    const again = reconcile(
      [run({ status: "completed", completedAt: "2026-09-17T09:00:00.000Z", durationMs: 1000 })],
      done.tracker,
    );
    expect(again.subagents).toEqual([]);
  });

  it("maps failed and aborted runs to their terminal vocabulary", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const failed = reconcile([run({ status: "failed", error: "agent exploded" })], first.tracker);
    expect(failed.subagents).toHaveLength(1);
    expect(failed.subagents[0]).toMatchObject({ status: "failed", result: "agent exploded" });

    const second = reconcile([run()], emptyPiWorkflowTracker());
    const aborted = reconcile([run({ status: "aborted", error: "user stop" })], second.tracker);
    expect(aborted.subagents[0]).toMatchObject({ status: "cancelled" });
  });

  it("maps a paused run to an idle update exactly once", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const paused = reconcile([run({ status: "paused" })], first.tracker);
    expect(paused.subagents).toHaveLength(1);
    expect(paused.subagents[0]).toMatchObject({ status: "idle" });

    const stillPaused = reconcile([run({ status: "paused" })], paused.tracker);
    expect(stillPaused.subagents).toEqual([]);
  });

  it("clears a tracked run that disappeared from the store", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const vanished = reconcile([], first.tracker);
    expect(vanished.subagents).toHaveLength(1);
    expect(vanished.subagents[0]).toMatchObject({
      status: "interrupted",
      completedAt: EMITTED_AT,
      updatedAt: EMITTED_AT,
    });
    expect(vanished.tracker.coordinator.size).toBe(0);
  });

  it("stays silent and keeps tracking a run the store could not read this sweep", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    expect(kinds(first.subagents)).toEqual(["workflow", "workflow_agent"]);

    // A rename, an oversize record, or a transient read error: the run was not
    // returned, but the store knows it is still there. A terminal state here
    // would lie to the panel and drop the run, losing its real completion.
    const unreadable = reconcile([], first.tracker, ["run-1"]);
    expect(unreadable.subagents).toEqual([]);
    expect(unreadable.tracker.coordinator.has("run-1")).toBe(true);

    // Readable again, terminal: the missed completion still lands.
    const completed = reconcile([run({ status: "completed" })], unreadable.tracker);
    expect(kinds(completed.subagents)).toEqual(["workflow"]);
    expect(completed.subagents[0]).toMatchObject({ status: "completed" });
    expect(completed.tracker.coordinator.size).toBe(0);
  });

  it("keeps an unresolved run's own progress flowing once it reads again", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const unreadable = reconcile([], first.tracker, ["run-1"]);
    const resumed = reconcile([run({ currentPhase: "Fix" })], unreadable.tracker, ["run-1"]);

    expect(kinds(resumed.subagents)).toEqual(["workflow"]);
    expect(resumed.subagents[0]).toMatchObject({ progress: "Fix" });
  });

  it("skips a run whose id cannot be branded instead of throwing on every sweep", () => {
    const broken = run({ runId: "   " });
    const good = run({ runId: "run-2" });

    const { subagents, tracker } = reconcile([broken, good], emptyPiWorkflowTracker());

    expect(kinds(subagents)).toEqual(["workflow", "workflow_agent"]);
    expect(subagents[0]).toMatchObject({ id: "node:workflow:run-2" });
    expect([...tracker.coordinator.keys()]).toEqual(["run-2"]);

    // The next sweep sees the same junk and must stay healthy.
    const again = reconcile([broken, good], tracker);
    expect(again.subagents).toEqual([]);
  });

  it("returns a resumed run to running after a pause, not to a stale idle", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const paused = reconcile([run({ status: "paused" })], first.tracker);
    expect(paused.subagents[0]).toMatchObject({ status: "idle" });

    // Nothing else changed across the pause: the coordinator row is idle and has
    // to be told the run is running again.
    const resumed = reconcile([run({ status: "running" })], paused.tracker);
    expect(resumed.subagents).toHaveLength(1);
    expect(resumed.subagents[0]).toMatchObject({ status: "running" });
  });

  it("does not adopt a terminal run found cold", () => {
    const { subagents, tracker } = reconcile(
      [run({ status: "completed" })],
      emptyPiWorkflowTracker(),
    );
    expect(subagents).toEqual([]);
    expect(tracker.coordinator.size).toBe(0);
  });

  it("emits a terminal run's final agent rows so its last phase cannot stay unresolved", () => {
    const runId = "test-3-etapes-mu5n55b1-6cb2pp";
    const step = (
      id: string,
      label: string,
      phase: string,
      status: PiWorkflowRunSnapshot["agents"][number]["status"],
      endedAt: string | undefined,
    ): PiWorkflowRunSnapshot["agents"][number] => ({
      id,
      label,
      phase,
      status,
      model: "local-openai/opencode-go/deepseek-v4.1-flash:high",
      tokens: 6635,
      startedAt: "2026-09-17T14:44:42.400Z",
      endedAt,
    });

    const live = run({
      runId,
      workflowName: "test_3_etapes",
      phases: ["Étape 1", "Étape 2", "Étape 3"],
      currentPhase: "Étape 2",
      agents: [
        step("1", "step1", "Étape 1", "done", "2026-09-17T14:44:43.534Z"),
        step("2", "step2", "Étape 2", "running", undefined),
      ],
    });
    const first = reconcile([live], emptyPiWorkflowTracker());
    expect(kinds(first.subagents)).toEqual(["workflow", "workflow_agent", "workflow_agent"]);

    const finished = run({
      runId,
      workflowName: "test_3_etapes",
      status: "completed",
      phases: ["Étape 1", "Étape 2", "Étape 3"],
      currentPhase: "Étape 3",
      agents: [
        step("1", "step1", "Étape 1", "done", "2026-09-17T14:44:43.534Z"),
        step("2", "step2", "Étape 2", "done", "2026-09-17T14:44:45.180Z"),
        step("3", "step3", "Étape 3", "done", "2026-09-17T14:44:47.257Z"),
      ],
      completedAt: "2026-09-17T14:44:47.258Z",
      totalTokens: 20090,
    });
    const done = reconcile([finished], first.tracker);

    // step2 changed running -> done and step3 is new: both rows must go out,
    // in that order, BEFORE the completion that settles the run.
    expect(kinds(done.subagents)).toEqual(["workflow_agent", "workflow_agent", "workflow"]);
    expect(done.subagents[0]).toMatchObject({
      id: `node:workflow:${runId}:wf:2`,
      status: "completed",
      workflow: { phaseIndex: 1, phaseTitle: "Étape 2" },
    });
    expect(done.subagents[1]).toMatchObject({
      id: `node:workflow:${runId}:wf:3`,
      parentNodeId: `node:workflow:${runId}`,
      status: "completed",
      title: "step3",
      workflow: { phaseIndex: 2, phaseTitle: "Étape 3", agentIndex: 2 },
    });
    expect(done.subagents[2]).toMatchObject({
      status: "completed",
      workflow: {
        phases: [
          { index: 0, title: "Étape 1" },
          { index: 1, title: "Étape 2" },
          { index: 2, title: "Étape 3" },
        ],
      },
    });
    // Settled once: a second terminal poll re-emits nothing.
    const again = reconcile([finished], done.tracker);
    expect(again.subagents).toEqual([]);
  });

  it("does not re-state members a terminal run already reported unchanged", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const done = reconcile(
      [run({ status: "completed", completedAt: "2026-09-17T09:00:00.000Z" })],
      first.tracker,
    );
    expect(kinds(done.subagents)).toEqual(["workflow"]);
  });
});
