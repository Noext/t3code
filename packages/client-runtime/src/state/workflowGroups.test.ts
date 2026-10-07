import { describe, expect, it } from "vite-plus/test";

import type { RuntimeSubagent, RuntimeSubagentStatus } from "./subagentRuntime.ts";
import {
  deriveAgentPanelModel,
  formatWorkflowRunLabel,
  workflowRunSuffix,
} from "./workflowGroups.ts";
import { isTerminalSubagentStatus } from "./subagentRuntime.ts";

const AT = "2026-09-17T14:46:00.000Z";

function agent(overrides: Partial<RuntimeSubagent> & { readonly id: string }): RuntimeSubagent {
  return {
    kind: "subagent",
    title: overrides.id,
    role: null,
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: AT,
    startedAt: AT,
    completedAt: null,
    updatedAt: AT,
    ...overrides,
  };
}

/** A Pi run declares its whole phase list up front on the coordinator. */
function workflow(input: {
  readonly runId: string;
  readonly workflowName?: string;
  readonly status: RuntimeSubagentStatus;
  readonly phases: ReadonlyArray<string>;
  readonly currentPhase?: string;
  readonly firstSeenAt?: string;
}): RuntimeSubagent {
  return agent({
    id: input.runId,
    kind: "workflow",
    title: input.workflowName ?? input.runId,
    workflowName: input.workflowName ?? input.runId,
    status: input.status,
    progress: input.currentPhase ?? null,
    phases: input.phases.map((title, index) => ({ index, title })),
    runHandles: { runId: input.runId },
    ...(input.firstSeenAt === undefined ? {} : { firstSeenAt: input.firstSeenAt }),
  });
}

function member(input: {
  readonly id: string;
  readonly parentId: string;
  readonly phaseIndex: number;
  readonly phaseTitle?: string;
  readonly agentIndex?: number;
  readonly status: RuntimeSubagentStatus;
}): RuntimeSubagent {
  return agent({
    id: input.id,
    title: input.id,
    parentAgentId: input.parentId,
    kind: "workflow_agent",
    phaseIndex: input.phaseIndex,
    phaseTitle: input.phaseTitle ?? null,
    agentIndex: input.agentIndex ?? input.phaseIndex,
    status: input.status,
  });
}

describe("deriveAgentPanelModel", () => {
  const audit = workflow({
    runId: "wf-1",
    workflowName: "audit",
    status: "running",
    phases: ["Audit", "Verify"],
    currentPhase: "Verify",
  });
  const roster: ReadonlyArray<RuntimeSubagent> = [
    audit,
    member({
      id: "wf-1:wf:0",
      parentId: "wf-1",
      phaseIndex: 0,
      phaseTitle: "Audit",
      status: "completed",
    }),
    member({
      id: "wf-1:wf:1",
      parentId: "wf-1",
      phaseIndex: 1,
      phaseTitle: "Verify",
      agentIndex: 1,
      status: "running",
    }),
    agent({ id: "direct-1", title: "Marlow", role: "explorer", status: "idle" }),
  ];

  it("groups workflow members by phase and separates direct spawns", () => {
    const model = deriveAgentPanelModel(roster);
    expect(model.workflows).toHaveLength(1);
    const group = model.workflows[0]!;
    expect(group.phases).toHaveLength(2);
    expect(group.phases[0]!.state).toBe("done");
    expect(group.phases[1]!.state).toBe("running");
    expect(group.phases[0]!.members.map((entry) => entry.id)).toEqual(["wf-1:wf:0"]);
    expect(group.phases[1]!.members.map((entry) => entry.id)).toEqual(["wf-1:wf:1"]);
    expect(model.directAgents.map((entry) => entry.id)).toEqual(["direct-1"]);
  });

  it("counts running and waiting as live, and idle as not", () => {
    const model = deriveAgentPanelModel([
      agent({ id: "run", status: "running" }),
      agent({ id: "wait", status: "waiting" }),
      agent({ id: "idle", status: "idle" }),
    ]);
    expect(model.liveCount).toBe(2);
  });

  it("omits a workflow coordinator from the live count", () => {
    const model = deriveAgentPanelModel(roster);
    // One member still running. The coordinator reports running for the whole
    // workflow and must not inflate the count.
    expect(model.liveCount).toBe(1);
  });

  it("scopes direct spawns to directScope while workflow cards stay thread-level", () => {
    const model = deriveAgentPanelModel(
      [
        audit,
        member({
          id: "wf-1:wf:0",
          parentId: "wf-1",
          phaseIndex: 0,
          phaseTitle: "Audit",
          status: "completed",
        }),
        agent({ id: "old-direct", title: "old turn" }),
      ],
      [agent({ id: "turn-direct", title: "this turn" })],
    );

    // The coordinator and its member carry no turn run id, yet the card stays.
    expect(model.workflows).toHaveLength(1);
    expect(model.workflows[0]!.phases[0]!.members.map((entry) => entry.id)).toEqual(["wf-1:wf:0"]);
    // Direct rows answer "this turn", so the old spawn is gone.
    expect(model.directAgents.map((entry) => entry.id)).toEqual(["turn-direct"]);
    expect(model.hasAgents).toBe(true);
  });

  it("reports no agents when a thread has only old direct spawns", () => {
    const model = deriveAgentPanelModel(
      [agent({ id: "old-direct", title: "old turn", status: "completed" })],
      [],
    );

    expect(model.workflows).toEqual([]);
    expect(model.directAgents).toEqual([]);
    expect(model.hasAgents).toBe(false);
  });

  it("keeps direct spawns in first-seen order as their activity changes", () => {
    const directRoster = [
      agent({
        id: "direct-a",
        title: "First",
        firstSeenAt: "2026-08-01T11:00:00.000Z",
        updatedAt: "2026-08-01T11:00:02.000Z",
      }),
      agent({
        id: "direct-b",
        title: "Second",
        firstSeenAt: "2026-08-01T11:00:01.000Z",
        updatedAt: "2026-08-01T11:00:01.000Z",
      }),
    ];

    expect(deriveAgentPanelModel(directRoster).directAgents.map((entry) => entry.id)).toEqual([
      "direct-a",
      "direct-b",
    ]);
  });

  it("a finished run leaves no phase pending", () => {
    // A run that ended during Recon: Design never received a member, so the
    // rail must resolve it instead of advertising it pending forever.
    const run = workflow({
      runId: "pi-workflow-recon",
      status: "cancelled",
      phases: ["Recon", "Design"],
    });
    const model = deriveAgentPanelModel([
      run,
      member({
        id: "pi-workflow-recon:wf:1",
        parentId: run.id,
        phaseIndex: 0,
        phaseTitle: "Recon",
        status: "completed",
      }),
    ]);
    expect(isTerminalSubagentStatus(model.workflows[0]!.workflow.status)).toBe(true);
    expect(model.workflows[0]!.phases.map((phase) => `${phase.title}:${phase.state}`)).toEqual([
      "Recon:done",
      "Design:skipped",
    ]);
  });

  it("a mid-run workflow still shows phases it has not reached as pending", () => {
    const run = workflow({
      runId: "pi-workflow-phase-pending-fix-mu5n6tcx-i253rw",
      workflowName: "pi_workflow_phase_pending_fix",
      status: "running",
      phases: ["Fix", "Verify"],
    });
    const model = deriveAgentPanelModel([
      run,
      member({
        id: `${run.id}:wf:1`,
        parentId: run.id,
        phaseIndex: 0,
        phaseTitle: "Fix",
        status: "running",
      }),
    ]);
    expect(model.workflows[0]!.phases.map((phase) => `${phase.title}:${phase.state}`)).toEqual([
      "Fix:running",
      "Verify:pending",
    ]);
  });

  it("a terminal run resolves unreached phases, and a paused run keeps them pending", () => {
    const finished = (status: "completed" | "failed") => {
      const run = workflow({
        runId: `pi-workflow-${status}-run`,
        status,
        phases: ["Recon", "Design"],
      });
      return [
        run,
        member({
          id: `${run.id}:wf:1`,
          parentId: run.id,
          phaseIndex: 0,
          phaseTitle: "Recon",
          status: "completed",
        }),
      ];
    };

    for (const status of ["completed", "failed"] as const) {
      expect(
        deriveAgentPanelModel(finished(status)).workflows[0]!.phases.map(
          (phase) => `${phase.title}:${phase.state}`,
        ),
      ).toEqual(["Recon:done", "Design:skipped"]);
    }

    // A paused run is resumable, so a phase it has not reached must stay
    // pending: the rail still has to advance when the run resumes.
    const paused = workflow({
      runId: "pi-workflow-paused-run",
      status: "idle",
      phases: ["Recon", "Design"],
    });
    expect(
      deriveAgentPanelModel([
        paused,
        member({
          id: `${paused.id}:wf:1`,
          parentId: paused.id,
          phaseIndex: 0,
          phaseTitle: "Recon",
          status: "running",
        }),
      ]).workflows[0]!.phases.map((phase) => phase.state),
    ).toEqual(["running", "pending"]);
  });

  it("a phase whose only agent lands on the terminal sweep still renders done", () => {
    // The last phase's member row and the run completion arrive in one update.
    // The phase must read done, not skipped: the run DID run it.
    const run = workflow({
      runId: "test-3-etapes-fixed",
      workflowName: "test_3_etapes",
      status: "completed",
      phases: ["Étape 1", "Étape 2", "Étape 3"],
    });
    const finished = [
      run,
      member({
        id: `${run.id}:wf:1`,
        parentId: run.id,
        phaseIndex: 0,
        phaseTitle: "Étape 1",
        status: "completed",
      }),
      member({
        id: `${run.id}:wf:2`,
        parentId: run.id,
        phaseIndex: 1,
        phaseTitle: "Étape 2",
        status: "completed",
      }),
      member({
        id: `${run.id}:wf:3`,
        parentId: run.id,
        phaseIndex: 2,
        phaseTitle: "Étape 3",
        status: "completed",
      }),
    ];

    expect(
      deriveAgentPanelModel(finished).workflows[0]!.phases.map(
        (phase) => `${phase.title}:${phase.state}`,
      ),
    ).toEqual(["Étape 1:done", "Étape 2:done", "Étape 3:done"]);
  });

  it("a terminal run whose last phase never emitted an agent resolves instead of pending", () => {
    const run = workflow({
      runId: "test-3-etapes-mu5n55b1-6cb2pp",
      workflowName: "test_3_etapes",
      status: "completed",
      phases: ["Étape 1", "Étape 2", "Étape 3"],
    });
    const phases = deriveAgentPanelModel([
      run,
      member({
        id: `${run.id}:wf:1`,
        parentId: run.id,
        phaseIndex: 0,
        phaseTitle: "Étape 1",
        status: "completed",
      }),
      member({
        id: `${run.id}:wf:2`,
        parentId: run.id,
        phaseIndex: 1,
        phaseTitle: "Étape 2",
        status: "running",
      }),
    ]).workflows[0]!.phases;
    expect(phases.map((phase) => `${phase.title}:${phase.state}`)).toEqual([
      "Étape 1:done",
      "Étape 2:done",
      "Étape 3:skipped",
    ]);
    expect(phases.some((phase) => phase.state === "pending")).toBe(false);
  });

  it("a phase with only pending members never reads as done", () => {
    const run = workflow({ runId: "wf-9", status: "running", phases: ["Fix"] });
    const model = deriveAgentPanelModel([
      run,
      member({
        id: "wf-9:wf:0",
        parentId: "wf-9",
        phaseIndex: 0,
        phaseTitle: "Fix",
        status: "pending",
      }),
    ]);
    expect(model.workflows[0]!.phases[0]!.state).toBe("running");
  });

  it("members with unknown phase indices land in unphasedMembers, never vanish", () => {
    const run = workflow({ runId: "wf-p", status: "running", phases: ["Only phase"] });
    const model = deriveAgentPanelModel([
      run,
      member({
        id: "wf-p:wf:0",
        parentId: "wf-p",
        phaseIndex: 0,
        phaseTitle: "Only phase",
        status: "running",
      }),
      member({ id: "wf-p:wf:9", parentId: "wf-p", phaseIndex: 9, status: "running" }),
    ]);
    const group = model.workflows[0]!;
    const visible = [
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedMembers,
    ].map((entry) => entry.id);
    expect(visible).toContain("wf-p:wf:0");
    expect(visible).toContain("wf-p:wf:9");
  });

  it("orphaned members fall back to the direct list", () => {
    const orphans = [
      agent({
        id: "gone:wf:0",
        title: "orphan",
        kind: "workflow_agent",
        parentAgentId: "gone",
        phaseIndex: 0,
      }),
    ];
    const model = deriveAgentPanelModel(orphans);
    expect(model.workflows).toHaveLength(0);
    expect(model.directAgents.map((entry) => entry.id)).toEqual(["gone:wf:0"]);
  });

  it("returns an empty model for an empty roster", () => {
    const model = deriveAgentPanelModel([]);
    expect(model.hasAgents).toBe(false);
    expect(model.workflows).toEqual([]);
  });
});

describe("workflow run identity", () => {
  it("distinguishes two runs of the same workflow by the id tail, not the name", () => {
    const first = "pi-workflow-phase-pending-fix-mu5n6tcx-i253rw";
    const second = "pi-workflow-phase-pending-fix-mu5n6td2-k9p1ab";
    const model = deriveAgentPanelModel([
      workflow({
        runId: first,
        workflowName: "pi_workflow_phase_pending_fix",
        status: "running",
        phases: ["Fix"],
      }),
      workflow({
        runId: second,
        workflowName: "pi_workflow_phase_pending_fix",
        status: "running",
        phases: ["Fix"],
      }),
    ]);
    const labels = model.workflows.map((group) => group.label);
    expect(labels.toSorted()).toEqual([
      "pi_workflow_phase_pending_fix · mu5n6tcx-i253rw",
      "pi_workflow_phase_pending_fix · mu5n6td2-k9p1ab",
    ]);
    expect(new Set(labels).size).toBe(2);
    // The group label is the formatter's own output.
    for (const group of model.workflows) {
      expect(group.label).toBe(formatWorkflowRunLabel(group.workflow));
    }
  });

  it("degrades to the bare name when the run id is missing or unusable", () => {
    const cases: ReadonlyArray<RuntimeSubagent["runHandles"]> = [
      null,
      { runId: "-" },
      { runId: "   " },
      {},
    ];
    for (const runHandles of cases) {
      const entry = agent({
        id: "pi-workflow-nameless-run",
        title: "audit-auth-flow",
        kind: "workflow",
        workflowName: "audit-auth-flow",
        runHandles,
      });
      expect(formatWorkflowRunLabel(entry)).toBe("audit-auth-flow");
    }
  });

  it("does not repeat the tail when the name already is the run id", () => {
    const runId = "pi-workflow-phase-pending-fix-mu5n6tcx-i253rw";
    const entry = agent({
      id: runId,
      title: runId,
      kind: "workflow",
      workflowName: runId,
      status: "interrupted",
      runHandles: { runId },
    });
    expect(formatWorkflowRunLabel(entry)).toBe(runId);
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
