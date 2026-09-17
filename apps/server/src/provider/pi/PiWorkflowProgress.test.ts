import { expect, it } from "vite-plus/test";

import {
  emptyPiWorkflowTracker,
  reconcilePiWorkflowRuns,
  type PiWorkflowEmission,
  type PiWorkflowTracker,
} from "./PiWorkflowProgress.ts";
import type { PiWorkflowRunSnapshot } from "./PiWorkflowStore.ts";

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
) => reconcilePiWorkflowRuns({ runs, unresolvedRunIds, tracker });

const types = (emissions: ReadonlyArray<PiWorkflowEmission>) => emissions.map((e) => e.type);

const payloads = (emissions: ReadonlyArray<PiWorkflowEmission>) =>
  emissions.map((e) => e.payload as Record<string, unknown>);

it("adopts a live run with a coordinator row and one row per agent", () => {
  const { emissions } = reconcile([run()], emptyPiWorkflowTracker());

  expect(types(emissions)).toEqual(["task.started", "task.progress"]);
  const started = payloads(emissions)[0]!;
  expect(started).toMatchObject({
    taskId: "run-1",
    taskType: "local_workflow",
    workflowName: "Adapter hardening",
    title: "Adapter hardening",
    runHandles: { runId: "run-1" },
    phases: [
      { index: 0, title: "Recon" },
      { index: 1, title: "Fix" },
    ],
  });
  const member = payloads(emissions)[1]!;
  expect(member).toMatchObject({
    // The `:wf:` slot marker is what both work-log surfaces group on: its prefix
    // is the coordinator's group, so the member rows join the run's CTA row.
    taskId: "run-1:wf:1",
    parentAgentId: "run-1",
    agentIndex: 0,
    title: "recon-store",
    status: "running",
    phaseIndex: 0,
    phaseTitle: "Recon",
    timelineBypass: true,
  });
});

it("carries a terminal run's full phase list so an unreached phase cannot read pending", () => {
  // Real shape: pi-workflow-sidebar-recon-mu5iej8f-dcgowe.json — status
  // "aborted", phases ["Recon","Design"], currentPhase "Recon", and all four
  // agents (three done, one skipped) in Recon. Design never received a member,
  // so the phase rail only knows it was never reached if the terminal row still
  // names it.
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
  expect(payloads(first.emissions)[0]).toMatchObject({
    taskId: runId,
    phases: [
      { index: 0, title: "Recon" },
      { index: 1, title: "Design" },
    ],
  });

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
  // agent 1 was still "running" when the run was last emitted and is "done"
  // here, and agents 2-4 are seen at all only on this sweep. The phase list on
  // the terminal row is what proves Design was never reached.
  expect(types(done.emissions)).toEqual([
    "task.progress",
    "task.progress",
    "task.progress",
    "task.progress",
    "task.completed",
  ]);
  expect(payloads(done.emissions)[4]).toMatchObject({
    taskId: runId,
    status: "stopped",
    phases: [
      { index: 0, title: "Recon" },
      { index: 1, title: "Design" },
    ],
  });
});

it("emits nothing when a poll changed nothing", () => {
  const first = reconcile([run()], emptyPiWorkflowTracker());
  const second = reconcile([run()], first.tracker);
  expect(second.emissions).toEqual([]);
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

  expect(types(second.emissions)).toEqual(["task.progress", "task.progress"]);
  const members = payloads(second.emissions);
  expect(members[0]).toMatchObject({ taskId: "run-1", summary: "Fix" });
  expect(members[1]).toMatchObject({ taskId: "run-1:wf:2", phaseIndex: 1, phaseTitle: "Fix" });
});

it("completes a tracked run once and then stays silent", () => {
  const first = reconcile([run()], emptyPiWorkflowTracker());
  const done = reconcile(
    [run({ status: "completed", completedAt: "2026-09-17T09:00:00.000Z", durationMs: 1000 })],
    first.tracker,
  );

  expect(types(done.emissions)).toEqual(["task.completed"]);
  expect(payloads(done.emissions)[0]).toMatchObject({ taskId: "run-1", status: "completed" });

  const again = reconcile(
    [run({ status: "completed", completedAt: "2026-09-17T09:00:00.000Z", durationMs: 1000 })],
    done.tracker,
  );
  expect(again.emissions).toEqual([]);
});

it("maps failed and aborted runs to their terminal vocabulary", () => {
  const first = reconcile([run()], emptyPiWorkflowTracker());
  const failed = reconcile([run({ status: "failed", error: "agent exploded" })], first.tracker);
  expect(types(failed.emissions)).toEqual(["task.completed"]);
  expect(payloads(failed.emissions)[0]).toMatchObject({
    status: "failed",
    summary: "agent exploded",
  });

  const second = reconcile([run()], emptyPiWorkflowTracker());
  const aborted = reconcile([run({ status: "aborted", error: "user stop" })], second.tracker);
  expect(types(aborted.emissions)).toEqual(["task.completed"]);
  expect(payloads(aborted.emissions)[0]).toMatchObject({
    status: "stopped",
    summary: "Workflow run stopped.",
  });
});

it("maps a paused run to an idle update exactly once", () => {
  const first = reconcile([run()], emptyPiWorkflowTracker());
  const paused = reconcile([run({ status: "paused" })], first.tracker);
  expect(types(paused.emissions)).toEqual(["task.updated"]);
  expect(payloads(paused.emissions)[0]).toMatchObject({ taskId: "run-1", status: "idle" });

  const stillPaused = reconcile([run({ status: "paused" })], paused.tracker);
  expect(stillPaused.emissions).toEqual([]);
});

it("clears a tracked run that disappeared from the store", () => {
  const first = reconcile([run()], emptyPiWorkflowTracker());
  const vanished = reconcile([], first.tracker);
  expect(types(vanished.emissions)).toEqual(["task.updated"]);
  expect(payloads(vanished.emissions)[0]).toMatchObject({
    taskId: "run-1",
    status: "interrupted",
  });
  expect(vanished.tracker.coordinator.size).toBe(0);
});

it("stays silent and keeps tracking a run the store could not read this sweep", () => {
  const first = reconcile([run()], emptyPiWorkflowTracker());
  expect(types(first.emissions)).toEqual(["task.started", "task.progress"]);

  // A rename, an oversize record, or a transient read error: the run was not
  // returned, but the store knows it is still there. A terminal state here
  // would lie to the panel and drop the run, losing its real completion.
  const unreadable = reconcile([], first.tracker, ["run-1"]);
  expect(unreadable.emissions).toEqual([]);
  expect(unreadable.tracker.coordinator.has("run-1")).toBe(true);

  // Readable again, terminal: the missed completion still lands.
  const completed = reconcile([run({ status: "completed" })], unreadable.tracker);
  expect(types(completed.emissions)).toEqual(["task.completed"]);
  expect(payloads(completed.emissions)[0]).toMatchObject({ taskId: "run-1", status: "completed" });
  expect(completed.tracker.coordinator.size).toBe(0);
});

it("keeps an unresolved run's own progress flowing once it reads again", () => {
  const first = reconcile([run()], emptyPiWorkflowTracker());
  const unreadable = reconcile([], first.tracker, ["run-1"]);
  const resumed = reconcile([run({ currentPhase: "Fix" })], unreadable.tracker, ["run-1"]);

  expect(types(resumed.emissions)).toEqual(["task.progress"]);
  expect(payloads(resumed.emissions)[0]).toMatchObject({ taskId: "run-1", summary: "Fix" });
});

it("skips a run whose id cannot be branded instead of throwing on every sweep", () => {
  const broken = run({ runId: "   " });
  const good = run({ runId: "run-2" });

  const { emissions, tracker } = reconcile([broken, good], emptyPiWorkflowTracker());

  expect(types(emissions)).toEqual(["task.started", "task.progress"]);
  expect(payloads(emissions)[0]).toMatchObject({ taskId: "run-2" });
  expect([...tracker.coordinator.keys()]).toEqual(["run-2"]);

  // The next sweep sees the same junk and must stay healthy.
  const again = reconcile([broken, good], tracker);
  expect(again.emissions).toEqual([]);
});

it("returns a resumed run to running after a pause, not to a stale idle", () => {
  const first = reconcile([run()], emptyPiWorkflowTracker());
  const paused = reconcile([run({ status: "paused" })], first.tracker);
  expect(types(paused.emissions)).toEqual(["task.updated"]);

  // Nothing else changed across the pause: the coordinator row is idle and has
  // to be told the run is running again.
  const resumed = reconcile([run({ status: "running" })], paused.tracker);
  expect(types(resumed.emissions)).toEqual(["task.progress"]);
  expect(payloads(resumed.emissions)[0]).toMatchObject({ taskId: "run-1", status: "running" });
});

it("does not adopt a terminal run found cold", () => {
  const { emissions, tracker } = reconcile(
    [run({ status: "completed" })],
    emptyPiWorkflowTracker(),
  );
  expect(emissions).toEqual([]);
  expect(tracker.coordinator.size).toBe(0);
});

it("emits a terminal run's final agent rows so its last phase cannot stay unresolved", () => {
  // Real shape: test-3-etapes-mu5n55b1-6cb2pp (the operator's report). The
  // script is sequential and the whole run lasts ~5s, which is two sweeps end
  // to end. The first sweep sees only phases 1-2 with step1 done and step2
  // running; the next sweep sees the run completed with all three agents done.
  // The terminal sweep is therefore the FIRST time step3 is visible at all —
  // dropping member rows there left `Étape 3` with no member in the stored
  // activity stream, so the panel could only render it unresolved.
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
  expect(types(first.emissions)).toEqual(["task.started", "task.progress", "task.progress"]);

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

  // step2 changed running -> done and step3 is new: both rows must go out, in
  // that order, BEFORE the completion that settles the run.
  expect(types(done.emissions)).toEqual(["task.progress", "task.progress", "task.completed"]);
  const members = payloads(done.emissions);
  expect(members[0]).toMatchObject({
    taskId: `${runId}:wf:2`,
    phaseIndex: 1,
    phaseTitle: "Étape 2",
    status: "completed",
  });
  expect(members[1]).toMatchObject({
    taskId: `${runId}:wf:3`,
    parentAgentId: runId,
    agentIndex: 2,
    title: "step3",
    phaseIndex: 2,
    phaseTitle: "Étape 3",
    status: "completed",
  });
  expect(members[2]).toMatchObject({
    taskId: runId,
    status: "completed",
    phases: [
      { index: 0, title: "Étape 1" },
      { index: 1, title: "Étape 2" },
      { index: 2, title: "Étape 3" },
    ],
  });
  // Settled once: a second terminal poll re-emits nothing.
  const again = reconcile([finished], done.tracker);
  expect(again.emissions).toEqual([]);
});

it("does not re-state members a terminal run already reported unchanged", () => {
  // A long run (trackshop-convex-typecheck-refactor) emits each agent while it
  // runs. On the terminal sweep only the agents whose final fields changed are
  // re-stated; re-sending the whole roster on every completion would be pure
  // wire weight.
  const first = reconcile([run()], emptyPiWorkflowTracker());
  const done = reconcile(
    [run({ status: "completed", completedAt: "2026-09-17T09:00:00.000Z" })],
    first.tracker,
  );
  expect(types(done.emissions)).toEqual(["task.completed"]);
});
