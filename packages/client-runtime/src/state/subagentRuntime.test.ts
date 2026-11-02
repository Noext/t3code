import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveWorkflowGroups,
  isWorkflowScriptMessage,
  projectedSubagentsToRuntime,
  resolveWorkflowOpening,
  settleSubagentsOfTerminalRuns,
} from "./subagentRuntime.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

type ProjectedSubagent = Parameters<typeof projectedSubagentsToRuntime>[0][number];

function subagent(overrides: Partial<ProjectedSubagent> = {}): ProjectedSubagent {
  return {
    id: "coordinator",
    title: "probe",
    prompt: "export const meta = …",
    model: "claude-opus-5[1m]",
    status: "running" satisfies OrchestrationV2Subagent["status"],
    result: null,
    startedAt: at("2026-08-01T10:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-08-01T10:00:05.000Z"),
    ...overrides,
  };
}

const member = (
  overrides: Partial<OrchestrationV2SubagentWorkflow["agents"][number]> = {},
): OrchestrationV2SubagentWorkflow["agents"][number] => ({
  index: 1,
  label: "alpha:one",
  state: "running",
  phaseIndex: 1,
  phaseTitle: "Alpha",
  ...overrides,
});

const groupsOf = (subagents: ReadonlyArray<ProjectedSubagent>) =>
  deriveWorkflowGroups(projectedSubagentsToRuntime(subagents));

describe("projectedSubagentsToRuntime workflow expansion", () => {
  it("uses a settled member's wall-clock completion separately from its execution duration", () => {
    const [, settled] = projectedSubagentsToRuntime([
      subagent({
        status: "completed",
        completedAt: at("2026-08-01T10:00:09.000Z"),
        workflow: {
          phases: [],
          agents: [
            member({
              state: "completed",
              model: "claude-opus-5[1m]",
              effort: "xhigh",
              speed: "standard",
              startedAt: Date.UTC(2026, 7, 1, 10, 0, 0),
              durationMs: 1500,
              completedAt: Date.UTC(2026, 7, 1, 10, 0, 4, 432),
              totalTokens: 71_141,
              toolCalls: 3,
              prompt: "Reply with exactly: A1",
              result: "A1",
            }),
          ],
        },
      }),
    ]);
    expect(settled?.status).toBe("completed");
    expect(settled?.completedAt).toBe("2026-08-01T10:00:04.432Z");
    expect(settled?.result).toBe("A1");
    expect(settled?.model).toBe("claude-opus-5[1m]");
    expect(settled?.effort).toBe("xhigh");
    expect(settled?.speed).toBe("standard");
    expect(settled?.progress).toBe("Reply with exactly: A1");
    expect(settled?.usage).toEqual({ totalTokens: 71_141, toolUses: 3, durationMs: 1500 });
  });

  it.each(["completed", "cancelled", "failed"] as const)(
    "settles unfinished members when the coordinator is %s",
    (status) => {
      const groups = groupsOf([
        subagent({
          status,
          completedAt: at("2026-08-01T10:00:09.000Z"),
          workflow: {
            phases: [],
            agents: [
              member(),
              member({ index: 2, state: "queued" }),
              member({
                index: 3,
                state: "completed",
                startedAt: Date.UTC(2026, 7, 1, 10, 0, 0),
                durationMs: 1500,
              }),
            ],
          },
        }),
      ]);
      expect(groups[0]?.workflow.status).toBe(status);
      const members = groups[0]?.phases.flatMap((phase) => phase.members);
      expect(members?.map((agent) => agent.status)).toEqual([status, status, "completed"]);
      expect(members?.map((agent) => agent.completedAt)).toEqual([
        "2026-08-01T10:00:09.000Z",
        "2026-08-01T10:00:09.000Z",
        "2026-08-01T10:00:01.500Z",
      ]);
      expect(members?.[0]?.model).toBeNull();
      expect(members?.[0]?.effort).toBeNull();
      expect(members?.[0]?.speed).toBeUndefined();
    },
  );
});

describe("deriveWorkflowGroups over a dynamic workflow", () => {
  it("groups members under their phases and counts the run", () => {
    const groups = groupsOf([
      subagent({
        workflow: {
          name: "probe-wf",
          phases: [
            { index: 1, title: "Alpha" },
            { index: 2, title: "Beta" },
          ],
          agents: [
            member({ state: "completed" }),
            member({ index: 2, label: "alpha:two", state: "failed" }),
            member({ index: 3, label: "beta:one", phaseIndex: 2, phaseTitle: "Beta" }),
            member({
              index: 4,
              label: "beta:two",
              phaseIndex: 2,
              phaseTitle: "Beta",
              state: "queued",
            }),
          ],
        },
      }),
    ]);
    const group = groups[0];
    expect(group?.phases.map((phase) => [phase.title, phase.state])).toEqual([
      ["Alpha", "done"],
      ["Beta", "running"],
    ]);
    expect(group?.phases.map((phase) => phase.settledCount)).toEqual([2, 0]);
    expect(group?.phases.flatMap((phase) => phase.members)).toHaveLength(4);
    expect(group?.unphasedMembers).toEqual([]);
  });

  it.each([false, true])("keeps a reported phase title, missing title first=%s", (missingFirst) => {
    const agents = [member({ phaseTitle: "Review" }), member({ index: 2, phaseTitle: undefined })];
    const groups = groupsOf([
      subagent({ workflow: { phases: [], agents: missingFirst ? agents.toReversed() : agents } }),
    ]);
    expect(groups[0]?.phases[0]?.title).toBe("Review");
  });

  it("keeps unphased members with their workflow and excludes unrelated agents", () => {
    const runtime = projectedSubagentsToRuntime([
      subagent({ id: "ordinary" }),
      subagent({
        id: "__proto__",
        workflow: {
          phases: [],
          agents: [member({ phaseIndex: undefined, phaseTitle: undefined })],
        },
      }),
      subagent({ id: "constructor", workflow: { phases: [], agents: [] } }),
      subagent({ id: "orphan", workflow: { phases: [], agents: [member()] } }),
    ]);
    const groups = deriveWorkflowGroups(runtime.filter((agent) => agent.id !== "orphan"));
    expect(groups.map((group) => group.workflow.id)).toEqual(["__proto__", "constructor"]);
    expect(groups[0]?.phases).toEqual([]);
    expect(groups[0]?.unphasedMembers.map((agent) => agent.title)).toEqual(["alpha:one"]);
    expect(groups[1]?.phases).toEqual([]);
    expect(groups[1]?.unphasedMembers).toEqual([]);
  });
});

describe("resolveWorkflowOpening", () => {
  const SCRIPT = '// probe\nexport const meta = { name: "probe-wf" };\nconst GROUPS = [];';
  const childThread = {
    id: ThreadId.make("child"),
    lineage: {
      parentThreadId: ThreadId.make("parent"),
      relationshipToParent: "subagent" as const,
      rootThreadId: ThreadId.make("parent"),
    },
    creationSource: "provider" as const,
  };
  const coordinator = (workflow?: OrchestrationV2SubagentWorkflow) => ({
    ...subagent({
      title: "Run the alpha workflow",
      childThreadId: "child",
      ...(workflow === undefined ? {} : { workflow }),
    }),
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claude"),
  });
  const brief = (text: string, workflowScript?: boolean) => ({
    id: "message-1",
    role: "user",
    text,
    ...(workflowScript === undefined ? {} : { workflowScript }),
  });

  it("opens a marked thread with the coordinator's plan and members", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT, true)],
      parentSubagents: [
        coordinator({
          name: "probe-wf",
          phases: [{ index: 1, title: "Alpha" }],
          agents: [member({ childThreadId: ThreadId.make("member-1") })],
        }),
      ],
    });
    expect(opening).toMatchObject({
      messageId: "message-1",
      script: SCRIPT,
      name: "probe-wf",
      description: "Run the alpha workflow",
    });
    expect(
      opening?.group?.phases.map((phase) => ({
        title: phase.title,
        members: phase.members.map((agent) => [agent.title, agent.status, agent.childThreadId]),
      })),
    ).toEqual([{ title: "Alpha", members: [["alpha:one", "running", "member-1"]] }]);
  });

  it("recognizes an unmarked script before the parent loads", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT)],
      parentSubagents: null,
    });
    expect(opening).toMatchObject({ script: SCRIPT, name: null, group: null });
  });

  it("leaves an ordinary subagent thread and other threads alone", () => {
    expect(
      resolveWorkflowOpening({
        thread: childThread,
        messages: [brief("Audit the last five commits.")],
        parentSubagents: [coordinator()],
      }),
    ).toBeNull();
    expect(
      resolveWorkflowOpening({
        thread: {
          ...childThread,
          lineage: { ...childThread.lineage, relationshipToParent: null, parentThreadId: null },
        },
        messages: [brief(SCRIPT)],
        parentSubagents: null,
      }),
    ).toBeNull();
    expect(isWorkflowScriptMessage({ role: "user", text: "Explain `export const meta`." })).toBe(
      false,
    );
    expect(isWorkflowScriptMessage({ role: "assistant", text: SCRIPT })).toBe(false);
  });
});

describe("settleSubagentsOfTerminalRuns", () => {
  const run = (id: string, status: string, completedAt: DateTime.Utc | null = null) => ({
    id,
    status,
    completedAt,
  });
  const fleetSubagent = (
    overrides: Omit<Partial<OrchestrationV2Subagent>, "id"> & { readonly id: string },
  ): OrchestrationV2Subagent => {
    const { id, ...rest } = overrides;
    return {
      id: NodeId.make(id),
      threadId: ThreadId.make("thread-1"),
      runId: RunId.make("run-1"),
      parentNodeId: NodeId.make("node-root"),
      origin: "provider_native",
      createdBy: "agent",
      driver: ProviderDriverKind.make("pi"),
      providerInstanceId: ProviderInstanceId.make("pi"),
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Do the thing",
      title: "Worker",
      model: "claude-sonnet-5",
      status: "running",
      result: null,
      startedAt: at("2026-09-17T14:46:00.000Z"),
      completedAt: null,
      updatedAt: at("2026-09-17T14:46:01.000Z"),
      ...rest,
    };
  };
  // A workflow coordinator carries no orchestration run id: it is known through the run's root node.
  const coordinator = (id: string) => fleetSubagent({ id, runId: null });

  it("settles a subagent whose run already completed", () => {
    const [settled] = settleSubagentsOfTerminalRuns({
      runs: [run("run-1", "completed", at("2026-09-17T15:00:00.000Z"))],
      subagents: [fleetSubagent({ id: "worker" })],
    });
    expect(settled!.status).toBe("completed");
    expect(settled!.completedAt?.toString()).toBe(at("2026-09-17T15:00:00.000Z").toString());
  });

  it("settles a workflow coordinator that only links to its parent node", () => {
    const [settled] = settleSubagentsOfTerminalRuns({
      runs: [run("run-448", "completed", at("2026-10-22T18:50:16.000Z"))],
      nodes: [{ id: "node-root", runId: "run-448" }],
      subagents: [coordinator("coordinator")],
    });
    expect(settled!.status).toBe("completed");
  });

  it("settles a member through its coordinator", () => {
    const settled = settleSubagentsOfTerminalRuns({
      runs: [run("run-448", "completed")],
      nodes: [{ id: "node-root", runId: "run-448" }],
      subagents: [
        coordinator("coordinator"),
        fleetSubagent({
          id: "member",
          runId: null,
          parentNodeId: NodeId.make("coordinator"),
          status: "running",
        }),
      ],
    });
    expect(settled.map((entry) => entry.status)).toEqual(["completed", "completed"]);
  });

  it("leaves a live run's subagents alone", () => {
    const [settled] = settleSubagentsOfTerminalRuns({
      runs: [run("run-1", "running")],
      subagents: [fleetSubagent({ id: "worker" })],
    });
    expect(settled!.status).toBe("running");
    expect(settled!.completedAt).toBeNull();
  });

  it("leaves a delegated subagent alone: its child thread outlives the run", () => {
    const [settled] = settleSubagentsOfTerminalRuns({
      runs: [run("run-1", "completed")],
      subagents: [fleetSubagent({ id: "delegated", childThreadId: ThreadId.make("thread-child") })],
    });
    expect(settled!.status).toBe("running");
  });

  it("carries the run's failure onto its subagents", () => {
    const [settled] = settleSubagentsOfTerminalRuns({
      runs: [run("run-1", "failed")],
      subagents: [fleetSubagent({ id: "worker" })],
    });
    expect(settled!.status).toBe("failed");
  });

  it("leaves terminal subagents untouched", () => {
    const [settled] = settleSubagentsOfTerminalRuns({
      runs: [run("run-1", "completed")],
      subagents: [
        fleetSubagent({
          id: "done",
          status: "completed",
          completedAt: at("2026-09-17T14:47:00.000Z"),
        }),
      ],
    });
    expect(settled!.status).toBe("completed");
    expect(settled!.completedAt?.toString()).toBe(at("2026-09-17T14:47:00.000Z").toString());
  });

  it("does not loop on a cyclic parent chain", () => {
    const settled = settleSubagentsOfTerminalRuns({
      runs: [run("run-1", "completed")],
      subagents: [
        fleetSubagent({ id: "a", runId: null, parentNodeId: NodeId.make("b") }),
        fleetSubagent({ id: "b", runId: null, parentNodeId: NodeId.make("a") }),
      ],
    });
    expect(settled.map((entry) => entry.status)).toEqual(["running", "running"]);
  });
});
