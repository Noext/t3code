import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  emptyPiWorkflowTracker,
  reconcilePiWorkflowRuns,
  type PiWorkflowProjectionContext,
  type PiWorkflowTracker,
} from "./PiWorkflowProgress.ts";
import type { PiWorkflowAgentSnapshot, PiWorkflowRunSnapshot } from "./PiWorkflowStore.ts";

const EMITTED_AT = DateTime.makeUnsafe("2026-09-17T09:00:00.000Z");

/** The contract holds nested workflow timestamps as epoch millis, not ISO strings. */
const epochMillis = (iso: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

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

const agent = (overrides: Partial<PiWorkflowAgentSnapshot> = {}): PiWorkflowAgentSnapshot => ({
  id: "1",
  label: "recon-store",
  phase: "Recon",
  status: "running",
  model: "local-openai/opencode-go/deepseek-v4.1-flash:high",
  tokens: 10,
  startedAt: "2026-09-17T08:04:33.118Z",
  endedAt: undefined,
  ...overrides,
});

const run = (overrides: Partial<PiWorkflowRunSnapshot> = {}): PiWorkflowRunSnapshot => ({
  runId: "run-1",
  workflowName: "Adapter hardening",
  status: "running",
  phases: ["Recon", "Fix"],
  currentPhase: "Recon",
  agents: [agent()],
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

describe("PiWorkflowProgress", () => {
  it("adopts a live run as one coordinator carrying its phases and agents", () => {
    const { subagents, tracker } = reconcile([run()], emptyPiWorkflowTracker());

    expect(subagents).toHaveLength(1);
    const coordinator = subagents[0]!;
    expect(coordinator).toMatchObject({
      id: "node:workflow:run-1",
      parentNodeId: "node:workflow-root",
      status: "running",
      title: "Adapter hardening",
      progress: "Recon",
    });
    expect(coordinator.workflow).toEqual({
      name: "Adapter hardening",
      runHandles: { runId: "run-1" },
      phases: [
        { index: 0, title: "Recon" },
        { index: 1, title: "Fix" },
      ],
      agents: [
        {
          index: 0,
          label: "recon-store",
          agentId: "1",
          state: "running",
          phaseIndex: 0,
          phaseTitle: "Recon",
          model: "local-openai/opencode-go/deepseek-v4.1-flash:high",
          totalTokens: 10,
          startedAt: epochMillis("2026-09-17T08:04:33.118Z"),
        },
      ],
      totalTokens: 10,
    });
    expect([...tracker.coordinator.keys()]).toEqual(["run-1"]);
  });

  it("folds a member's status change into the coordinator it already owns", () => {
    const first = reconcile(
      [
        run({
          agents: [
            agent({ id: "1", label: "recon-store", phase: "Recon" }),
            agent({
              id: "2",
              label: "impl",
              phase: "Fix",
              status: "queued",
              model: "m",
              tokens: 0,
            }),
          ],
        }),
      ],
      emptyPiWorkflowTracker(),
    );
    expect(first.subagents).toHaveLength(1);

    // Only the second agent moved: no phase change, no run status change.
    const moved = reconcile(
      [
        run({
          agents: [
            agent({ id: "1", label: "recon-store", phase: "Recon" }),
            agent({
              id: "2",
              label: "impl",
              phase: "Fix",
              status: "running",
              model: "m",
              tokens: 5,
              startedAt: "2026-09-17T08:06:00.000Z",
            }),
          ],
        }),
      ],
      first.tracker,
    );

    // One row, not one row per member: the changed agent is folded in and the
    // untouched one travels with it.
    expect(moved.subagents).toHaveLength(1);
    const coordinator = moved.subagents[0]!;
    expect(coordinator).toMatchObject({
      id: "node:workflow:run-1",
      status: "running",
      progress: "Recon",
    });
    expect(coordinator.workflow?.agents).toEqual([
      {
        index: 0,
        label: "recon-store",
        agentId: "1",
        state: "running",
        phaseIndex: 0,
        phaseTitle: "Recon",
        model: "local-openai/opencode-go/deepseek-v4.1-flash:high",
        totalTokens: 10,
        startedAt: epochMillis("2026-09-17T08:04:33.118Z"),
      },
      {
        index: 1,
        label: "impl",
        agentId: "2",
        state: "running",
        phaseIndex: 1,
        phaseTitle: "Fix",
        model: "m",
        totalTokens: 5,
        startedAt: epochMillis("2026-09-17T08:06:00.000Z"),
      },
    ]);
    expect(coordinator.workflow?.totalTokens).toBe(15);
    expect([...moved.tracker.coordinator.keys()]).toEqual(["run-1"]);
  });

  it("carries a terminal run's full phase list so an unreached phase cannot read pending", () => {
    const runId = "pi-workflow-sidebar-recon-mu5iej8f-dcgowe";
    const live = run({
      runId,
      phases: ["Recon", "Design"],
      currentPhase: "Recon",
      agents: [agent({ id: "1", label: "recon-store", status: "running" })],
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
        agent({
          id: "1",
          label: "recon-store",
          status: "done",
          endedAt: "2026-09-17T12:40:00.000Z",
        }),
        agent({
          id: "2",
          label: "recon-surface",
          status: "done",
          endedAt: "2026-09-17T12:41:00.000Z",
        }),
        agent({
          id: "3",
          label: "recon-precedent",
          status: "done",
          endedAt: "2026-09-17T12:42:00.000Z",
        }),
        agent({
          id: "4",
          label: "recon-adapter",
          status: "skipped",
          endedAt: "2026-09-17T12:43:00.000Z",
        }),
      ],
      completedAt: "2026-09-17T12:49:29.570Z",
    });
    const done = reconcile([aborted], first.tracker);

    // Agents 2-4 were seen at all only on this sweep: the terminal row is where
    // they land, so a skipped step cannot stay rendered as running.
    expect(done.subagents).toHaveLength(1);
    const coordinator = done.subagents[0]!;
    expect(coordinator).toMatchObject({ status: "cancelled" });
    expect(coordinator.workflow?.phases).toEqual([
      { index: 0, title: "Recon" },
      { index: 1, title: "Design" },
    ]);
    expect(coordinator.workflow?.agents.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(coordinator.workflow?.agents.map((entry) => entry.state)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(coordinator.workflow?.agents[3]).toMatchObject({
      label: "recon-adapter",
      agentId: "4",
      phaseIndex: 0,
      phaseTitle: "Recon",
      completedAt: epochMillis("2026-09-17T12:43:00.000Z"),
    });
    expect(done.tracker.coordinator.size).toBe(0);
  });

  it("emits nothing when a poll changed nothing", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const second = reconcile([run()], first.tracker);
    expect(second.subagents).toEqual([]);
    expect(second.tracker).toEqual(first.tracker);
  });

  it("maps failed runs and errored agents to their terminal vocabulary", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const failed = reconcile(
      [
        run({
          status: "failed",
          error: "agent exploded",
          agents: [agent({ id: "1", label: "recon-store", status: "error" })],
        }),
      ],
      first.tracker,
    );

    expect(failed.subagents).toHaveLength(1);
    expect(failed.subagents[0]).toMatchObject({ status: "failed", result: "agent exploded" });
    expect(failed.subagents[0]?.workflow?.agents[0]?.state).toBe("failed");
    expect(failed.tracker.coordinator.size).toBe(0);
  });

  it("maps a paused run to an idle update exactly once", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const paused = reconcile([run({ status: "paused" })], first.tracker);
    expect(paused.subagents).toHaveLength(1);
    expect(paused.subagents[0]).toMatchObject({ status: "idle", progress: "Recon" });

    const stillPaused = reconcile([run({ status: "paused" })], paused.tracker);
    expect(stillPaused.subagents).toEqual([]);
    expect([...stillPaused.tracker.coordinator.keys()]).toEqual(["run-1"]);
  });

  it("returns a resumed run to running after a pause, not to a stale idle", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const paused = reconcile([run({ status: "paused" })], first.tracker);
    expect(paused.subagents[0]).toMatchObject({ status: "idle" });

    // Nothing else changed across the pause: the coordinator row is idle and has
    // to be told the run is running again.
    const resumed = reconcile([run({ status: "running" })], paused.tracker);
    expect(resumed.subagents).toHaveLength(1);
    expect(resumed.subagents[0]).toMatchObject({ status: "running", progress: "Recon" });
  });

  it("keeps a tracked coordinator's anchor when a later sweep reports a different root", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const moved = reconcilePiWorkflowRuns({
      runs: [run({ currentPhase: "Fix" })],
      unresolvedRunIds: [],
      tracker: first.tracker,
      context: context({ workflowRootNodeId: NodeId.make("node:new-root") }),
    });

    expect(moved.subagents).toHaveLength(1);
    expect(moved.subagents[0]?.parentNodeId).toBe("node:workflow-root");
  });

  it("marks a tracked run interrupted when it disappears from the store", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const vanished = reconcile([], first.tracker);
    expect(vanished.subagents).toHaveLength(1);
    expect(vanished.subagents[0]).toMatchObject({
      status: "interrupted",
      completedAt: EMITTED_AT,
      updatedAt: EMITTED_AT,
    });
    expect(vanished.subagents[0]?.workflow?.agents).toHaveLength(1);
    expect(vanished.tracker.coordinator.size).toBe(0);
  });

  it("stays silent and keeps tracking a run the store could not read this sweep", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    expect(first.subagents).toHaveLength(1);

    // A rename, an oversize record, or a transient read error: the run was not
    // returned, but the store knows it is still there. A terminal state here
    // would lie to the panel and drop the run, losing its real completion.
    const unreadable = reconcile([], first.tracker, ["run-1"]);
    expect(unreadable.subagents).toEqual([]);
    expect(unreadable.tracker.coordinator.has("run-1")).toBe(true);

    // Readable again, terminal: the missed completion still lands.
    const completed = reconcile([run({ status: "completed" })], unreadable.tracker);
    expect(completed.subagents).toHaveLength(1);
    expect(completed.subagents[0]).toMatchObject({ status: "completed" });
    expect(completed.tracker.coordinator.size).toBe(0);
  });

  it("keeps an unresolved run's own progress flowing once it reads again", () => {
    const first = reconcile([run()], emptyPiWorkflowTracker());
    const unreadable = reconcile([], first.tracker, ["run-1"]);
    const resumed = reconcile([run({ currentPhase: "Fix" })], unreadable.tracker, ["run-1"]);

    expect(resumed.subagents).toHaveLength(1);
    expect(resumed.subagents[0]).toMatchObject({ progress: "Fix" });
  });

  it("skips a run whose id cannot be branded instead of throwing on every sweep", () => {
    const broken = run({ runId: "   " });
    const good = run({ runId: "run-2" });

    const { subagents, tracker } = reconcile([broken, good], emptyPiWorkflowTracker());

    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({ id: "node:workflow:run-2" });
    expect([...tracker.coordinator.keys()]).toEqual(["run-2"]);

    // The next sweep sees the same junk and must stay healthy.
    const again = reconcile([broken, good], tracker);
    expect(again.subagents).toEqual([]);
  });

  it("does not adopt a terminal run found cold", () => {
    const { subagents, tracker } = reconcile(
      [run({ status: "completed" })],
      emptyPiWorkflowTracker(),
    );
    expect(subagents).toEqual([]);
    expect(tracker.coordinator.size).toBe(0);
  });
});
