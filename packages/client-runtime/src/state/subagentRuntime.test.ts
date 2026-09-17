import { describe, expect, it } from "vite-plus/test";
import { classifyTaskAgentKind, type OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  formatWorkflowRunLabel,
  isTerminalSubagentStatus,
  workflowRunSuffix,
} from "./subagentRuntime.ts";

let sequence = 0;
/**
 * Fixtures model POST-INGESTION rows: ingestion stamps agentKind on every
 * task.* payload, so the helper stamps too (same classifier). Pass an
 * explicit agentKind (or agentKind: undefined via legacy()) to override.
 */
function activity(
  kind: string,
  payload: Record<string, unknown>,
  at = `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
): OrchestrationThreadActivity {
  sequence += 1;
  const stamped =
    kind.startsWith("task.") && !("agentKind" in payload)
      ? {
          ...payload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
            agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
          }),
        }
      : payload;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: stamped,
    turnId: null,
    createdAt: at,
  } as unknown as OrchestrationThreadActivity;
}

/** A pre-stamp row (legacy thread / old server): no agentKind at all. */
function legacyActivity(
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

function fold(rows: ReadonlyArray<OrchestrationThreadActivity>) {
  return foldSubagentActivities(rows);
}

describe("foldSubagentActivities", () => {
  it("shows the batch status limit after its parent turn ends without claiming a result", () => {
    const running = activity("task.progress", {
      taskId: "batch-1",
      taskType: "subagent_batch",
      title: "Antigravity subagent batch",
      status: "running",
      summary: "Launch readers",
    });
    const agents = fold([
      running,
      activity("task.updated", {
        taskId: "batch-1",
        taskType: "subagent_batch",
        status: "idle",
        detail: "Turn ended. Individual agent status is unavailable.",
        timelineBypass: true,
      }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      title: "Antigravity subagent batch",
      kind: "subagent_batch",
      status: "idle",
      progress: "Turn ended. Individual agent status is unavailable.",
      result: null,
      error: null,
    });
  });

  it("learns batch identity from a later update and retains it on sparse updates", () => {
    const agents = fold([
      activity("task.progress", { taskId: "batch-1", taskType: "subagent", status: "running" }),
      activity("task.updated", { taskId: "batch-1", taskType: "subagent_batch", status: "idle" }),
      activity("task.updated", { taskId: "batch-1", status: "idle" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ kind: "subagent_batch", status: "idle" });
  });

  it("builds an agent from start → progress → completion", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "task-1",
        title: "Audit auth flow",
        role: "explorer",
      }),
      activity("task.progress", {
        taskId: "task-1",
        lastToolName: "Read",
        typedUsage: { totalTokens: 1200, toolUses: 3 },
      }),
      activity("task.completed", {
        taskId: "task-1",
        status: "completed",
        summary: "Found 2 issues",
        typedUsage: { totalTokens: 5000, toolUses: 9 },
      }),
    ]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.title).toBe("Audit auth flow");
    expect(agent.role).toBe("explorer");
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("Found 2 issues");
    expect(agent.usage?.totalTokens).toBe(5000);
    expect(agent.activationCount).toBe(1);
    expect(agent.completedAt).not.toBeNull();
  });

  it("progress can create an agent when its start row aged out of retention", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "task-orphan",
        title: "Recovered agent",
        role: "verifier",
        typedUsage: { totalTokens: 100 },
      }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.title).toBe("Recovered agent");
    expect(agents[0]!.status).toBe("running");
  });

  it("completion before start stays terminal; a late start only fills metadata", () => {
    const agents = fold([
      activity("task.completed", {
        taskId: "task-2",
        status: "failed",
        summary: "boom",
        role: "fixer",
      }),
      activity("task.started", { taskId: "task-2", title: "Late metadata", role: "fixer" }),
    ]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.title).toBe("Late metadata");
    expect(agent.role).toBe("fixer");
    // The late start must NOT reopen the terminal activation as a new run.
    expect(agent.status).toBe("failed");
    expect(agent.error).toBe("boom");
  });

  it("duplicate terminal events are idempotent (timestamps do not slide)", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-3", taskType: "local_agent" }),
      activity(
        "task.completed",
        { taskId: "task-3", status: "completed" },
        "2026-08-01T11:00:00.000Z",
      ),
      activity(
        "task.completed",
        { taskId: "task-3", status: "completed" },
        "2026-08-01T12:00:00.000Z",
      ),
    ]);
    expect(agents[0]!.completedAt).toBe("2026-08-01T11:00:00.000Z");
  });

  it("reactivation increments the run count and clears result/error", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-4", taskType: "local_agent" }),
      activity("task.completed", { taskId: "task-4", status: "completed", summary: "run 1 done" }),
      activity("task.updated", { taskId: "task-4", status: "running" }),
    ]);
    const agent = agents[0]!;
    expect(agent.activationCount).toBe(2);
    expect(agent.result).toBeNull();
    expect(agent.completedAt).toBeNull();
    expect(agent.status).toBe("running");
  });

  it("idle is nonterminal: an idle agent resumes without losing identity", () => {
    const agents = fold([
      activity("task.started", { taskId: "codex-child-1", title: "Marlow", role: "explorer" }),
      activity("task.updated", { taskId: "codex-child-1", status: "idle" }),
      activity("task.updated", { taskId: "codex-child-1", status: "running" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.activationCount).toBe(2);
    expect(agents[0]!.status).toBe("running");
  });

  it("cumulative usage max-merges: duplicate and late frames never shrink or double-count", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-5", taskType: "local_agent" }),
      activity("task.progress", {
        taskId: "task-5",
        typedUsage: { totalTokens: 900, inputTokens: 700 },
      }),
      activity("task.progress", {
        taskId: "task-5",
        typedUsage: { totalTokens: 900, inputTokens: 700 },
      }),
      activity("task.progress", { taskId: "task-5", typedUsage: { totalTokens: 500 } }),
    ]);
    expect(agents[0]!.usage).toEqual({ totalTokens: 900, inputTokens: 700 });
  });

  it("usage snapshots enrich an existing agent without changing its status", () => {
    const [agent] = fold([
      activity("task.started", { taskId: "usage-waiting", taskType: "local_agent" }),
      activity("task.progress", { taskId: "usage-waiting", status: "waiting" }),
      activity("task.progress", {
        taskId: "usage-waiting",
        usageSnapshot: true,
        typedUsage: { totalTokens: 1_200 },
      }),
    ]);

    expect(agent?.status).toBe("waiting");
    expect(agent?.usage?.totalTokens).toBe(1_200);
  });

  it("a retained usage snapshot can still reconstruct a running agent", () => {
    const [agent] = fold([
      activity("task.progress", {
        taskId: "usage-only",
        usageSnapshot: true,
        typedUsage: { totalTokens: 800 },
      }),
    ]);

    expect(agent?.status).toBe("running");
    expect(agent?.usage?.totalTokens).toBe(800);
  });

  it("partial terminal usage preserves known breakdown fields", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-6", taskType: "local_agent" }),
      activity("task.progress", {
        taskId: "task-6",
        typedUsage: { totalTokens: 800, inputTokens: 600, outputTokens: 150 },
      }),
      activity("task.completed", {
        taskId: "task-6",
        status: "completed",
        typedUsage: { totalTokens: 1000 },
      }),
    ]);
    expect(agents[0]!.usage).toEqual({ totalTokens: 1000, inputTokens: 600, outputTokens: 150 });
  });

  it("skips malformed rows individually without failing the fold", () => {
    const agents = fold([
      activity("task.started", { taskId: "task-7", title: "Good", taskType: "local_agent" }),
      activity("task.progress", { bogus: true }),
      activity("task.progress", { taskId: 42 }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.title).toBe("Good");
  });

  it("bounds repeated strings at 180 chars and the activity ring at 6 deduped entries", () => {
    const long = "x".repeat(500);
    const rows = [activity("task.started", { taskId: "task-8", taskType: "local_agent" })];
    for (let i = 0; i < 10; i += 1) {
      rows.push(activity("task.progress", { taskId: "task-8", summary: `${long}-${i}` }));
    }
    rows.push(activity("task.progress", { taskId: "task-8", summary: `${long}-9` }));
    const agents = fold(rows);
    const agent = agents[0]!;
    expect(agent.recentActivity.length).toBeLessThanOrEqual(6);
    for (const entry of agent.recentActivity) {
      expect(entry.summary.length).toBeLessThanOrEqual(180);
    }
    // Consecutive identical summaries dedupe (truncation makes them equal).
    const summaries = agent.recentActivity.map((entry) => entry.summary);
    expect(new Set(summaries).size).toBe(summaries.length);
  });

  it("plan tasks are not agents", () => {
    const agents = fold([activity("task.started", { taskId: "plan-1", taskType: "plan" })]);
    expect(agents).toHaveLength(0);
  });

  it("workflow members key by stable slot and attach to their coordinator", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-1",
        taskType: "local_workflow",
        title: "audit-auth-flow",
        workflowName: "audit-auth-flow",
      }),
      activity("task.progress", {
        taskId: "wf-1",
        phases: [
          { index: 0, title: "Audit" },
          { index: 1, title: "Verify" },
        ],
      }),
      activity("task.progress", {
        taskId: "wf-1:wf:0",
        title: "audit:entrypoints",
        status: "running",
        parentAgentId: "wf-1",
        agentIndex: 0,
        phaseIndex: 0,
        phaseTitle: "Audit",
        timelineBypass: true,
      }),
    ]);
    const workflow = agents.find((agent) => agent.id === "wf-1");
    const member = agents.find((agent) => agent.id === "wf-1:wf:0");
    expect(workflow?.kind).toBe("workflow");
    expect(workflow?.phases).toEqual([
      { index: 0, title: "Audit" },
      { index: 1, title: "Verify" },
    ]);
    expect(member?.kind).toBe("workflow_agent");
    expect(member?.parentAgentId).toBe("wf-1");
  });

  it("a workflow member retry (attempt bump) is a reactivation of the same slot", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "wf-2:wf:1",
        title: "verify:refresh",
        status: "failed",
        error: "attempt 1 died",
        parentAgentId: "wf-2",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-2:wf:1",
        title: "verify:refresh",
        status: "running",
        parentAgentId: "wf-2",
        attempt: 2,
      }),
    ]);
    expect(agents).toHaveLength(1);
    const member = agents[0]!;
    expect(member.activationCount).toBeGreaterThanOrEqual(2);
    expect(member.error).toBeNull();
    expect(member.status).toBe("running");
  });

  it("drops non-http(s) session urls at the fold boundary", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "wf-3",
        taskType: "local_workflow",
        runHandles: { sessionUrl: "javascript:alert(1)", runId: "run-1" },
      }),
    ]);
    expect(agents[0]!.runHandles?.sessionUrl).toBeUndefined();
    expect(agents[0]!.runHandles?.runId).toBe("run-1");
  });
});

describe("deriveAgentPanelModel", () => {
  const roster = fold([
    activity("task.started", { taskId: "wf-1", taskType: "local_workflow", title: "audit" }),
    activity("task.progress", {
      taskId: "wf-1",
      phases: [
        { index: 0, title: "Audit" },
        { index: 1, title: "Verify" },
      ],
    }),
    activity("task.progress", {
      taskId: "wf-1:wf:0",
      title: "audit:a",
      status: "completed",
      parentAgentId: "wf-1",
      agentIndex: 0,
      phaseIndex: 0,
    }),
    activity("task.completed", { taskId: "wf-1:wf:0", status: "completed", parentAgentId: "wf-1" }),
    activity("task.progress", {
      taskId: "wf-1:wf:1",
      title: "verify:b",
      status: "running",
      parentAgentId: "wf-1",
      agentIndex: 1,
      phaseIndex: 1,
      typedUsage: { totalTokens: 4000 },
    }),
    activity("task.started", { taskId: "direct-1", title: "Marlow", role: "explorer" }),
    activity("task.updated", { taskId: "direct-1", status: "idle" }),
  ]);

  it("groups workflow members by phase and separates direct spawns", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    expect(model.workflows).toHaveLength(1);
    const group = model.workflows[0]!;
    expect(group.phases).toHaveLength(2);
    expect(group.phases[0]!.state).toBe("done");
    expect(group.phases[1]!.state).toBe("running");
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["direct-1"]);
  });

  it("counts idle deliberately and waiting as active", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    expect(model.idleCount).toBe(1);
    // Member 1 is running; the wf-1 coordinator is a container, not a worker.
    expect(model.runningCount).toBe(1);
    // Every agent lands in exactly one bucket, except coordinators that stand
    // in for their members.
    expect(model.idleCount + model.runningCount + model.waitingCount + model.settledCount).toBe(
      roster.length - 1,
    );
  });

  it("omits a workflow coordinator from the working-agent count", () => {
    const model = deriveAgentPanelModel({ agents: roster });
    // One member still running plus one idle direct spawn. The coordinator
    // reports running for the whole workflow and must not inflate the banner.
    expect(model.liveCount).toBe(1);
  });

  it("omits a finished workflow coordinator from the settled count", () => {
    const finished = fold([
      activity("task.started", { taskId: "wf-2", taskType: "local_workflow", title: "sweep" }),
      activity("task.progress", {
        taskId: "wf-2:wf:0",
        title: "sweep:a",
        status: "completed",
        parentAgentId: "wf-2",
        agentIndex: 0,
        phaseIndex: 0,
      }),
      activity("task.completed", {
        taskId: "wf-2:wf:0",
        status: "completed",
        parentAgentId: "wf-2",
      }),
      activity("task.completed", { taskId: "wf-2", status: "completed" }),
    ]);

    const model = deriveAgentPanelModel({ agents: finished });

    // Only the member settled. The coordinator stands in for it, so counting
    // both would report two finished agents where one ran.
    expect(model.settledCount).toBe(1);
    expect(model.liveCount).toBe(0);
  });

  it("keeps direct spawns in first-seen order as their activity changes", () => {
    const directRoster = fold([
      activity("task.started", { taskId: "direct-a", title: "First" }, "2026-08-01T11:00:00.000Z"),
      activity("task.started", { taskId: "direct-b", title: "Second" }, "2026-08-01T11:00:01.000Z"),
      activity(
        "task.progress",
        { taskId: "direct-a", summary: "Newest activity" },
        "2026-08-01T11:00:02.000Z",
      ),
    ]);

    expect(
      deriveAgentPanelModel({ agents: directRoster }).directAgents.map((agent) => agent.id),
    ).toEqual(["direct-a", "direct-b"]);
  });

  it("keeps first-seen order after the roster retention ranking runs", () => {
    const starts = Array.from({ length: 101 }, (_, index) =>
      activity(
        "task.started",
        { taskId: `capped-${index}`, title: `Agent ${index}` },
        `2026-08-01T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
          index % 60,
        ).padStart(2, "0")}.000Z`,
      ),
    );
    const cappedRoster = fold([
      ...starts,
      activity(
        "task.progress",
        { taskId: "capped-0", summary: "Newest activity" },
        "2026-08-01T12:02:00.000Z",
      ),
    ]);

    const ids = deriveAgentPanelModel({ agents: cappedRoster }).directAgents.map(
      (agent) => agent.id,
    );
    expect(ids).toHaveLength(100);
    expect(ids.slice(0, 3)).toEqual(["capped-0", "capped-2", "capped-3"]);
    expect(ids.at(-1)).toBe("capped-100");
  });

  // Real shapes below read from the operator's own Pi run store
  // (~/.pi/workflows/projects/t3code-d2f7aa1bf007/runs). A Pi run declares its
  // whole phase list up front and a later phase only gains members when the
  // run reaches it, so "a phase with no members" is the ordinary state of any
  // phase a run stopped or failed before reaching.
  const piRunRows = (options: {
    readonly runId: string;
    readonly phases: ReadonlyArray<string>;
    readonly currentPhase: string;
    readonly at: string;
  }) => {
    const started = activity(
      "task.started",
      {
        taskId: options.runId,
        taskType: "local_workflow",
        title: "pi_workflow",
        workflowName: "pi_workflow",
        runHandles: { runId: options.runId },
      },
      options.at,
    );
    const phases = activity(
      "task.progress",
      {
        taskId: options.runId,
        phases: options.phases.map((title, index) => ({ index, title })),
        summary: options.currentPhase,
      },
      new Date(Date.parse(options.at) + 1_000).toISOString(),
    );
    return { started, phases };
  };
  const piMemberRow = (
    runId: string,
    slot: number,
    label: string,
    phase: string,
    phaseIndex: number,
    status: string,
    at: string,
  ) =>
    activity(
      "task.progress",
      {
        taskId: `${runId}:wf:${slot}`,
        title: label,
        status,
        parentAgentId: runId,
        agentIndex: slot,
        phaseIndex,
        phaseTitle: phase,
        timelineBypass: true,
      },
      at,
    );

  it("a finished run leaves no phase pending", () => {
    // pi-workflow-sidebar-recon-mu5iej8f-dcgowe.json: status "aborted",
    // phases ["Recon","Design"], currentPhase "Recon", and all four agents
    // (three done, one skipped) in Recon. The run ended during Recon, so
    // Design never received a member and the rail showed it "pending" forever.
    const runId = "pi-workflow-sidebar-recon-mu5iej8f-dcgowe";
    const { started, phases } = piRunRows({
      runId,
      phases: ["Recon", "Design"],
      currentPhase: "Recon",
      at: "2026-09-17T12:32:00.000Z",
    });
    const aborted = fold([
      started,
      phases,
      piMemberRow(runId, 1, "recon-store", "Recon", 0, "completed", "2026-09-17T12:40:00.000Z"),
      piMemberRow(runId, 2, "recon-surface", "Recon", 0, "completed", "2026-09-17T12:41:00.000Z"),
      piMemberRow(runId, 3, "recon-precedent", "Recon", 0, "completed", "2026-09-17T12:42:00.000Z"),
      piMemberRow(runId, 4, "recon-adapter", "Recon", 0, "completed", "2026-09-17T12:43:00.000Z"),
      // The server maps the run's "aborted" to task.completed/stopped and
      // repeats the declared phase list on that terminal row.
      activity(
        "task.completed",
        {
          taskId: runId,
          status: "stopped",
          summary: "Workflow run stopped.",
          phases: [
            { index: 0, title: "Recon" },
            { index: 1, title: "Design" },
          ],
        },
        "2026-09-17T12:49:29.570Z",
      ),
    ]);

    const model = deriveAgentPanelModel({ agents: aborted });
    expect(isTerminalSubagentStatus(model.workflows[0]!.workflow.status)).toBe(true);
    expect(model.workflows[0]!.phases.map((phase) => `${phase.title}:${phase.state}`)).toEqual([
      "Recon:done",
      "Design:skipped",
    ]);
  });

  it("a mid-run workflow still shows phases it has not reached as pending", () => {
    // pi-workflow-phase-pending-fix-mu5n6tcx-i253rw.json: status "running",
    // phases ["Fix","Verify"], currentPhase "Fix", one running agent in Fix.
    const runId = "pi-workflow-phase-pending-fix-mu5n6tcx-i253rw";
    const { started, phases } = piRunRows({
      runId,
      phases: ["Fix", "Verify"],
      currentPhase: "Fix",
      at: "2026-09-17T14:46:00.000Z",
    });
    const running = fold([
      started,
      phases,
      piMemberRow(runId, 1, "fix-phase-pending", "Fix", 0, "running", "2026-09-17T14:47:00.000Z"),
    ]);

    const model = deriveAgentPanelModel({ agents: running });
    expect(model.workflows[0]!.phases.map((phase) => `${phase.title}:${phase.state}`)).toEqual([
      "Fix:running",
      "Verify:pending",
    ]);
  });

  it("a terminal run resolves unreached phases, and a paused run keeps them pending", () => {
    const finished = (status: "completed" | "failed", at: string) => {
      const runId = `pi-workflow-${status}-run`;
      const rows = piRunRows({
        runId,
        phases: ["Recon", "Design"],
        currentPhase: "Recon",
        at,
      });
      return fold([
        rows.started,
        rows.phases,
        piMemberRow(runId, 1, "recon-store", "Recon", 0, "completed", "2026-09-17T11:01:00.000Z"),
        activity(
          "task.completed",
          { taskId: runId, status, summary: "done" },
          "2026-09-17T11:02:00.000Z",
        ),
      ]);
    };

    // A completed or failed run is over: the phase it never reached is not
    // "pending", it is skipped.
    for (const status of ["completed", "failed"] as const) {
      expect(
        deriveAgentPanelModel({
          agents: finished(status, "2026-09-17T11:00:00.000Z"),
        }).workflows[0]!.phases.map((phase) => `${phase.title}:${phase.state}`),
      ).toEqual(["Recon:done", "Design:skipped"]);
    }

    // A paused run is resumable, so a phase it has not reached must stay
    // pending: the rail still has to advance when the run resumes.
    const pausedId = "pi-workflow-paused-run";
    const pausedRows = piRunRows({
      runId: pausedId,
      phases: ["Recon", "Design"],
      currentPhase: "Recon",
      at: "2026-09-17T11:10:00.000Z",
    });
    const paused = fold([
      pausedRows.started,
      pausedRows.phases,
      piMemberRow(pausedId, 1, "recon-store", "Recon", 0, "running", "2026-09-17T11:11:00.000Z"),
      activity("task.updated", { taskId: pausedId, status: "idle" }, "2026-09-17T11:12:00.000Z"),
    ]);
    expect(
      deriveAgentPanelModel({ agents: paused }).workflows[0]!.phases.map((phase) => phase.state),
    ).toEqual(["running", "pending"]);
  });

  it("a phase whose only agent lands on the terminal sweep still renders done", () => {
    // The operator's test_3_etapes run rebuilt as the server now emits it. The
    // run is short enough that step3 is first visible on the same sweep that
    // reports the run completed, so the member row and the completion arrive in
    // one batch. The phase must read done, not skipped: the run DID run it.
    const runId = "test-3-etapes-fixed";
    const finished = fold([
      activity("task.started", {
        taskId: runId,
        taskType: "local_workflow",
        title: "test_3_etapes",
        workflowName: "test_3_etapes",
        phases: [
          { index: 0, title: "Étape 1" },
          { index: 1, title: "Étape 2" },
        ],
      }),
      piMemberRow(runId, 1, "step1", "Étape 1", 0, "completed", "2026-09-17T14:44:43.534Z"),
      piMemberRow(runId, 2, "step2", "Étape 2", 1, "running", "2026-09-17T14:44:44.830Z"),
      // The terminal sweep restates step2 and introduces step3 (the fix).
      piMemberRow(runId, 2, "step2", "Étape 2", 1, "completed", "2026-09-17T14:44:45.180Z"),
      piMemberRow(runId, 3, "step3", "Étape 3", 2, "completed", "2026-09-17T14:44:47.257Z"),
      activity(
        "task.completed",
        {
          taskId: runId,
          status: "completed",
          phases: [
            { index: 0, title: "Étape 1" },
            { index: 1, title: "Étape 2" },
            { index: 2, title: "Étape 3" },
          ],
        },
        "2026-09-17T14:44:47.831Z",
      ),
    ]);

    expect(
      deriveAgentPanelModel({ agents: finished }).workflows[0]!.phases.map(
        (phase) => `${phase.title}:${phase.state}`,
      ),
    ).toEqual(["Étape 1:done", "Étape 2:done", "Étape 3:done"]);
  });

  it("a terminal run whose last phase never emitted an agent resolves instead of pending", () => {
    // The operator's stored rows (test-3-etapes-mu5n55b1-6cb2pp) before the
    // server emitted final agent rows: the completion carries all three phases
    // but step3 never appears. The run is over, so the phase must not advertise
    // work that will never arrive — it resolves as skipped, never pending.
    const runId = "test-3-etapes-mu5n55b1-6cb2pp";
    const stored = fold([
      activity("task.started", {
        taskId: runId,
        taskType: "local_workflow",
        title: "test_3_etapes",
        workflowName: "test_3_etapes",
        phases: [
          { index: 0, title: "Étape 1" },
          { index: 1, title: "Étape 2" },
        ],
      }),
      piMemberRow(runId, 1, "step1", "Étape 1", 0, "completed", "2026-09-17T14:44:44.830Z"),
      piMemberRow(runId, 2, "step2", "Étape 2", 1, "running", "2026-09-17T14:44:44.830Z"),
      activity(
        "task.completed",
        {
          taskId: runId,
          status: "completed",
          phases: [
            { index: 0, title: "Étape 1" },
            { index: 1, title: "Étape 2" },
            { index: 2, title: "Étape 3" },
          ],
        },
        "2026-09-17T14:44:47.831Z",
      ),
    ]);

    const phases = deriveAgentPanelModel({ agents: stored }).workflows[0]!.phases;
    expect(phases.map((phase) => `${phase.title}:${phase.state}`)).toEqual([
      "Étape 1:done",
      "Étape 2:done",
      "Étape 3:skipped",
    ]);
    expect(phases.some((phase) => phase.state === "pending")).toBe(false);
  });

  it("a phase with only pending members never reads as running", () => {
    const pendingRoster = fold([
      activity("task.started", { taskId: "wf-9", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-9",
        phases: [{ index: 0, title: "Fix" }],
      }),
      activity("task.progress", {
        taskId: "wf-9:wf:0",
        title: "fixer",
        status: "pending",
        parentAgentId: "wf-9",
        agentIndex: 0,
        phaseIndex: 0,
      }),
    ]);
    const model = deriveAgentPanelModel({ agents: pendingRoster });
    // "pending" counts as active liveness (queued work), so the phase reads
    // running only if a member is genuinely pending/running — this asserts
    // the settled-count rule: no member settled, phase not done.
    expect(model.workflows[0]!.phases[0]!.state).not.toBe("done");
  });

  it("v2 projection wins outright and sources are never merged", () => {
    const v2Agent = { ...roster[0]!, id: "v2-only", title: "From v2" };
    const model = deriveAgentPanelModel({ agents: roster, v2Projection: [v2Agent] });
    const allIds = [
      ...model.workflows.map((group) => group.workflow.id),
      ...model.directAgents.map((agent) => agent.id),
    ];
    expect(allIds).toContain("v2-only");
    expect(allIds).not.toContain("direct-1");
  });

  it("orphaned members fall back to the direct list", () => {
    const orphans = fold([
      activity("task.progress", {
        taskId: "gone:wf:0",
        title: "orphan",
        status: "running",
        parentAgentId: "gone",
      }),
    ]);
    const model = deriveAgentPanelModel({ agents: orphans });
    expect(model.workflows).toHaveLength(0);
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["gone:wf:0"]);
  });
});

describe("workflow run identity", () => {
  // Real shape from the operator's Pi run store. The writer names a run
  // `<workflow-slug>-<ts36>-<rand>` (generateRunId), and the workflow's own
  // name is the slug spelled with underscores, so two runs of one workflow
  // differ ONLY in the trailing timestamp-random tail: the name is identical
  // and a card keyed on the name alone renders two indistinguishable rows.
  const piWorkflowStarted = (runId: string, at: string) =>
    activity(
      "task.started",
      {
        taskId: runId,
        taskType: "local_workflow",
        title: "pi_workflow_phase_pending_fix",
        workflowName: "pi_workflow_phase_pending_fix",
        runHandles: { runId },
      },
      at,
    );

  it("distinguishes two runs of the same workflow by the id tail, not the name", () => {
    const first = "pi-workflow-phase-pending-fix-mu5n6tcx-i253rw";
    const second = "pi-workflow-phase-pending-fix-mu5n6td2-k9p1ab";
    const model = deriveAgentPanelModel({
      agents: fold([
        piWorkflowStarted(first, "2026-09-17T14:46:00.000Z"),
        piWorkflowStarted(second, "2026-09-17T15:10:00.000Z"),
      ]),
    });
    const labels = model.workflows.map((group) => formatWorkflowRunLabel(group.workflow));
    // Both keep the workflow name; only the tail tells them apart.
    expect(labels.toSorted()).toEqual([
      "pi_workflow_phase_pending_fix · mu5n6tcx-i253rw",
      "pi_workflow_phase_pending_fix · mu5n6td2-k9p1ab",
    ]);
    expect(new Set(labels).size).toBe(2);
  });

  it("degrades to the bare name when the run id is missing or unusable", () => {
    // Absent handles, blank ids (the fold drops whitespace anyway), and a
    // hyphen-only id that yields no usable tail must all render the name
    // alone — never a trailing/empty `·`.
    const cases: ReadonlyArray<Record<string, unknown>> = [
      {},
      { runHandles: { runId: "-" } },
      { runHandles: { runId: "   " } },
      { runHandles: {} },
    ];
    for (const extra of cases) {
      const agent = fold([
        activity("task.started", {
          taskId: "pi-workflow-nameless-run",
          taskType: "local_workflow",
          title: "audit-auth-flow",
          workflowName: "audit-auth-flow",
          ...extra,
        }),
      ])[0]!;
      expect(formatWorkflowRunLabel(agent)).toBe("audit-auth-flow");
    }
  });

  it("does not repeat the tail when the name already is the run id", () => {
    // The server's interrupted fallback (buildInterrupted) sets
    // workflowName to the run id; appending its own tail would stutter.
    const runId = "pi-workflow-phase-pending-fix-mu5n6tcx-i253rw";
    const agent = fold([
      activity("task.updated", {
        taskId: runId,
        status: "interrupted",
        taskType: "local_workflow",
        title: runId,
        workflowName: runId,
        runHandles: { runId },
      }),
    ])[0]!;
    expect(formatWorkflowRunLabel(agent)).toBe(runId);
  });

  it("keeps a short foreign id intact and only tail-truncates absurd ones", () => {
    expect(workflowRunSuffix("run-1")).toBe("run-1");
    expect(workflowRunSuffix("abcdef")).toBe("abcdef");
    expect(workflowRunSuffix("  ")).toBeNull();
    expect(workflowRunSuffix("-")).toBeNull();
    expect(workflowRunSuffix(undefined)).toBeNull();
    const long = "z".repeat(80);
    expect(workflowRunSuffix(long)).toHaveLength(32);
  });
});

describe("formatSubagentTokenCount", () => {
  it("formats plain counters", () => {
    expect(formatSubagentTokenCount(950)).toBe("950");
    expect(formatSubagentTokenCount(41200)).toBe("41.2k");
    expect(formatSubagentTokenCount(247000)).toBe("247k");
    expect(formatSubagentTokenCount(1_400_000)).toBe("1.4M");
  });
});

describe("model and effort attribution", () => {
  it("carries model/effort from start rows and refines model from later rows", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "task-m",
        title: "Verify math",
        model: "sonnet",
        effort: "high",
      }),
      // Later row refines with the authoritative API model id; effort absent
      // must not clear the known value.
      activity("task.progress", { taskId: "task-m", model: "claude-sonnet-5[1m]" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.model).toBe("claude-sonnet-5[1m]");
    expect(agents[0]!.effort).toBe("high");
  });

  it("applies metadata-only updates without changing the current status", () => {
    const waitingRows = [
      activity("task.updated", {
        taskId: "task-metadata",
        title: "Check metadata",
        status: "waiting",
      }),
      activity("task.updated", {
        taskId: "task-metadata",
        model: "gpt-5.6-sol",
        effort: "high",
      }),
    ];
    const waitingAgent = fold(waitingRows)[0]!;
    expect(waitingAgent.status).toBe("waiting");
    expect(formatSubagentModelLabel(waitingAgent.model, waitingAgent.effort)).toBe(
      "gpt-5.6-sol · high",
    );

    const idleRows = [
      ...waitingRows,
      activity("task.updated", { taskId: "task-metadata", status: "idle" }),
      activity("task.updated", { taskId: "task-metadata", model: "gpt-5.6-sol" }),
    ];
    expect(fold(idleRows)[0]!.status).toBe("idle");

    const completedAgent = fold([
      ...idleRows,
      activity("task.progress", { taskId: "task-metadata", typedUsage: { totalTokens: 42 } }),
      activity("task.completed", { taskId: "task-metadata", status: "completed" }),
      activity("task.updated", { taskId: "task-metadata", effort: "high" }),
    ])[0]!;
    expect(completedAgent.status).toBe("completed");
    expect(completedAgent.model).toBe("gpt-5.6-sol");
    expect(completedAgent.effort).toBe("high");
  });

  it("formatSubagentModelLabel compacts ids and appends effort", () => {
    expect(formatSubagentModelLabel("claude-sonnet-5[1m]", "high")).toBe("sonnet-5[1m] · high");
    expect(formatSubagentModelLabel("claude-opus-4-20250514", null)).toBe("opus-4");
    expect(formatSubagentModelLabel("gpt-5.6-sol", "low")).toBe("gpt-5.6-sol · low");
    expect(formatSubagentModelLabel(null, "high")).toBeNull();
  });
});

describe("background task exclusion", () => {
  it("shells and monitors never join the roster (from any lifecycle row)", () => {
    const agents = fold([
      activity("task.started", { taskId: "shell-1", taskType: "shell", title: "Run 12s stall" }),
      activity("task.progress", { taskId: "shell-2", taskType: "shell", title: "Run stall" }),
      activity("task.completed", { taskId: "mon-1", taskType: "monitor", status: "completed" }),
      activity("task.started", { taskId: "agent-1", taskType: "subagent", title: "Real agent" }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["agent-1"]);
  });

  it("rows without a taskType stay in the roster (workflow members, Codex children)", () => {
    const agents = fold([
      activity("task.progress", { taskId: "wf-1:wf:0", status: "running", parentAgentId: "wf-1" }),
    ]);
    expect(agents).toHaveLength(1);
  });

  it("the server stamp is the only classifier: no stamp means no roster row", () => {
    const agents = fold([
      // Stamped background: agent-looking fields don't matter.
      activity("task.started", {
        taskId: "bg-1",
        agentKind: "background",
        role: "watcher",
        model: "sonnet",
      }),
      // Stamped agent: plain row still joins the roster.
      activity("task.started", { taskId: "ag-1", agentKind: "agent", detail: "plain row" }),
      // Legacy pre-stamp rows (old threads/servers) stay in the work log —
      // exactly their pre-upgrade behavior.
      legacyActivity("task.started", { taskId: "old-task", detail: "tailing logs" }),
      legacyActivity("task.progress", { taskId: "old-task", summary: "still tailing" }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["ag-1"]);
  });

  it("membership is sticky: a stampless later row still reaches a known agent", () => {
    const agents = fold([
      activity("task.started", { taskId: "a1", taskType: "local_agent", title: "Agent" }),
      // Terminal row missing the stamp (defensive: adapters synthesize some
      // rows) — sticky membership still routes it to the agent.
      legacyActivity("task.completed", { taskId: "a1", status: "completed", summary: "done" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("completed");
    expect(agents[0]!.result).toBe("done");
  });
});

describe("session-derived interruption", () => {
  it("dead session interrupts live agents but preserves idle and settled", () => {
    const rows = [
      activity("task.started", { taskId: "live-1", taskType: "local_agent" }),
      activity("task.started", { taskId: "idle-1", taskType: "local_agent" }),
      activity("task.updated", { taskId: "idle-1", status: "idle" }),
      activity("task.started", { taskId: "done-1", taskType: "local_agent" }),
      activity("task.completed", { taskId: "done-1", status: "completed" }),
    ];
    const dead = foldSubagentActivities(rows, { sessionLive: false });
    expect(dead.find((agent) => agent.id === "live-1")?.status).toBe("interrupted");
    expect(dead.find((agent) => agent.id === "idle-1")?.status).toBe("idle");
    expect(dead.find((agent) => agent.id === "done-1")?.status).toBe("completed");
    const alive = foldSubagentActivities(rows, { sessionLive: true });
    expect(alive.find((agent) => agent.id === "live-1")?.status).toBe("running");
  });
});

describe("terminal robustness", () => {
  it("task.updated creating an agent (start row aged out) counts one activation", () => {
    const agents = fold([
      activity("task.updated", { taskId: "orphan-u", status: "running", role: "worker" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.activationCount).toBe(1);
    expect(agents[0]!.status).toBe("running");
  });

  it("a late start after a terminal task.updated does not reopen the run", () => {
    const agents = fold([
      activity("task.updated", { taskId: "t1", status: "failed", role: "worker" }),
      activity("task.started", { taskId: "t1", taskType: "local_agent", title: "Late" }),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.status).toBe("failed");
    expect(agents[0]!.title).toBe("Late");
  });

  it("a completion after a terminal task.updated still enriches result and usage", () => {
    // Claude commonly emits terminal task.updated before task.completed;
    // the completion carries the summary and final usage the update lacked.
    const agents = fold([
      activity("task.started", { taskId: "te-1", taskType: "local_agent" }),
      activity(
        "task.updated",
        { taskId: "te-1", status: "completed", endedAt: "2026-08-01T10:59:00.000Z" },
        "2026-08-01T11:00:00.000Z",
      ),
      activity(
        "task.completed",
        {
          taskId: "te-1",
          status: "completed",
          summary: "final answer",
          typedUsage: { totalTokens: 4200, toolUses: 7 },
        },
        "2026-08-01T11:00:01.000Z",
      ),
    ]);
    const agent = agents[0]!;
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("final answer");
    expect(agent.usage?.totalTokens).toBe(4200);
    // Timestamps stay pinned to the transition that settled the run.
    expect(agent.completedAt).toBe("2026-08-01T10:59:00.000Z");
  });

  it("duplicate completions keep the FIRST result, not the last", () => {
    const agents = fold([
      activity("task.started", { taskId: "t2", taskType: "local_agent" }),
      activity("task.completed", { taskId: "t2", status: "completed", summary: "first result" }),
      activity("task.completed", { taskId: "t2", status: "completed", summary: "second result" }),
    ]);
    expect(agents[0]!.result).toBe("first result");
  });

  it("provider endedAt wins over ingestion time on the settling transition", () => {
    const agents = fold([
      activity("task.started", { taskId: "t3", taskType: "local_agent" }),
      activity(
        "task.updated",
        { taskId: "t3", status: "failed", endedAt: "2026-08-01T09:59:59.000Z" },
        "2026-08-01T10:00:30.000Z",
      ),
    ]);
    expect(agents[0]!.completedAt).toBe("2026-08-01T09:59:59.000Z");
  });

  it("workflow retries count each attempt once", () => {
    const agents = fold([
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "running",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "failed",
        attempt: 1,
      }),
      activity("task.progress", {
        taskId: "wf-r:wf:0",
        parentAgentId: "wf-r",
        status: "running",
        attempt: 2,
      }),
    ]);
    expect(agents[0]!.activationCount).toBe(2);
  });
});

describe("phase membership", () => {
  it("members with unknown phase indices land in unphasedMembers, never vanish", () => {
    const model = deriveAgentPanelModel({
      agents: fold([
        activity("task.started", {
          taskId: "wf-p",
          taskType: "local_workflow",
          phases: [{ index: 0, title: "Only phase" }],
        }),
        activity("task.progress", {
          taskId: "wf-p:wf:0",
          parentAgentId: "wf-p",
          status: "running",
          phaseIndex: 0,
        }),
        activity("task.progress", {
          taskId: "wf-p:wf:9",
          parentAgentId: "wf-p",
          status: "running",
          phaseIndex: 9,
        }),
      ]),
    });
    const group = model.workflows[0]!;
    const visible = [
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedMembers,
    ].map((member) => member.id);
    expect(visible).toContain("wf-p:wf:0");
    expect(visible).toContain("wf-p:wf:9");
  });
});

describe("coordinator settle cascade", () => {
  it("members without their own terminal row settle when the coordinator does", () => {
    const agents = fold([
      activity("task.started", { taskId: "wf-1", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-1:wf:0",
        title: "stalled member",
        status: "running",
        parentAgentId: "wf-1",
      }),
      activity("task.completed", {
        taskId: "wf-1",
        status: "completed",
        taskType: "local_workflow",
      }),
    ]);
    const member = agents.find((agent) => agent.id === "wf-1:wf:0");
    expect(member?.status).toBe("completed");
    expect(member?.completedAt).not.toBeNull();
  });

  it("a failed coordinator marks unfinished members interrupted, not completed", () => {
    const agents = fold([
      activity("task.started", { taskId: "wf-2", taskType: "local_workflow" }),
      activity("task.progress", {
        taskId: "wf-2:wf:0",
        status: "running",
        parentAgentId: "wf-2",
      }),
      activity("task.completed", { taskId: "wf-2", status: "failed", taskType: "local_workflow" }),
    ]);
    const member = agents.find((agent) => agent.id === "wf-2:wf:0");
    expect(member?.status).toBe("interrupted");
  });
});

describe("task type classification is a denylist", () => {
  it("unknown agent-flavored types (local_agent, future names) join the roster", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "a1",
        taskType: "local_agent",
        title: "Math test 1",
        role: "claude",
      }),
      activity("task.started", { taskId: "a2", taskType: "some_future_agent_kind", title: "X" }),
    ]);
    expect(agents.map((agent) => agent.id).toSorted()).toEqual(["a1", "a2"]);
  });
});

describe("nested agents vs subagent shells", () => {
  it("a nested agent (agentId + agent taskType) stays in the roster; its shells do not", () => {
    const agents = fold([
      activity("task.started", {
        taskId: "nested-1",
        taskType: "local_agent",
        agentId: "parent-agent",
        title: "Nested researcher",
      }),
      activity("task.started", {
        taskId: "shell-1",
        taskType: "local_bash",
        agentId: "parent-agent",
        title: "Nested sleep",
      }),
    ]);
    expect(agents.map((agent) => agent.id)).toEqual(["nested-1"]);
  });
});

describe("the operator's own persisted test_3_etapes streams", () => {
  // Read verbatim (via t3-sqlite-state query) from
  // .t3/userdata/state.sqlite -> projection_thread_activities. These are the
  // rows the client actually rendered, so this is the regression that matters:
  // the real run store declared fewer phases than the terminal row, and the
  // last phase(s) never got a member row at all because the whole run crossed
  // several phases between two 3 s sweeps. A memberless phase on a terminal run
  // must not keep reading pending.
  const started = (
    taskId: string,
    phases: ReadonlyArray<string>,
    at: string,
  ): OrchestrationThreadActivity =>
    activity(
      "task.started",
      {
        taskId,
        taskType: "local_workflow",
        detail: "test_3_etapes",
        title: "test_3_etapes",
        workflowName: "test_3_etapes",
        phases: phases.map((title, index) => ({ index, title })),
        runHandles: { runId: taskId },
      },
      at,
    );
  const member = (
    taskId: string,
    slot: number,
    label: string,
    phase: string,
    phaseIndex: number,
    status: string,
    at: string,
  ): OrchestrationThreadActivity =>
    activity(
      "task.progress",
      {
        taskId: `${taskId}:wf:${slot}`,
        title: label,
        detail: label,
        status,
        parentAgentId: taskId,
        agentIndex: slot - 1,
        phaseIndex,
        phaseTitle: phase,
        timelineBypass: true,
      },
      at,
    );
  const completed = (
    taskId: string,
    phases: ReadonlyArray<string>,
    at: string,
  ): OrchestrationThreadActivity =>
    activity(
      "task.completed",
      {
        taskId,
        status: "completed",
        title: "test_3_etapes",
        taskType: "local_workflow",
        workflowName: "test_3_etapes",
        phases: phases.map((title, index) => ({ index, title })),
        runHandles: { runId: taskId },
      },
      at,
    );
  const phaseStates = (rows: ReadonlyArray<OrchestrationThreadActivity>) => {
    const model = deriveAgentPanelModel({ agents: foldSubagentActivities(rows) });
    expect(model.workflows).toHaveLength(1);
    expect(isTerminalSubagentStatus(model.workflows[0]!.workflow.status)).toBe(true);
    return model.workflows[0]!.phases.map((phase) => `${phase.title}:${phase.state}`);
  };

  it("run mu5n55b1 (thread 33341374): step1 and step2 reported, step3 never did", () => {
    const runId = "test-3-etapes-mu5n55b1-6cb2pp";
    expect(
      phaseStates([
        // The start row knew only two of the three phases.
        started(runId, ["Étape 1", "Étape 2"], "2026-09-17T14:44:44.830Z"),
        member(runId, 1, "step1", "Étape 1", 0, "completed", "2026-09-17T14:44:44.830Z"),
        member(runId, 2, "step2", "Étape 2", 1, "running", "2026-09-17T14:44:44.830Z"),
        // No wf:3 row was ever persisted; the completion restates all phases.
        completed(runId, ["Étape 1", "Étape 2", "Étape 3"], "2026-09-17T14:44:47.831Z"),
      ]),
    ).toEqual(["Étape 1:done", "Étape 2:done", "Étape 3:skipped"]);
  });

  it("run mu5ovdm1 (thread 2b4787a2): only step1 was ever reported", () => {
    const runId = "test-3-etapes-mu5ovdm1-allc79";
    expect(
      phaseStates([
        started(runId, ["Etape 1"], "2026-09-17T15:33:07.035Z"),
        member(runId, 1, "Etape 1 agent 1", "Etape 1", 0, "running", "2026-09-17T15:33:07.035Z"),
        completed(runId, ["Etape 1", "Etape 2", "Etape 3"], "2026-09-17T15:33:10.037Z"),
      ]),
    ).toEqual(["Etape 1:done", "Etape 2:skipped", "Etape 3:skipped"]);
  });
});
