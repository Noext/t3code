import { NodeId, type OrchestrationV2Subagent } from "@t3tools/contracts";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import { deriveAgentPanelModel } from "@t3tools/client-runtime/state/workflow-groups";
import { describe, expect, it } from "vite-plus/test";

import { makeRawSubagent } from "../../test-fixtures";
import { workflowIsLive, workflowMembers, workflowPhaseSummary } from "./workflowCardPresentation";

const phases = [
  { index: 0, title: "Plan" },
  { index: 1, title: "Build" },
  { index: 2, title: "Verify" },
];

function coordinator(overrides: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent {
  return makeRawSubagent({
    id: NodeId.make("workflow"),
    title: "phase-fixer",
    status: "completed",
    completedAt: null,
    workflow: {
      kind: "workflow",
      workflowName: "phase-fixer",
      phases,
      phaseIndex: null,
      phaseTitle: null,
      agentIndex: null,
      runId: "phase-fixer-mu5n6tcx-i253rw",
    },
    ...overrides,
  });
}

function member(
  id: string,
  phaseIndex: number,
  status: OrchestrationV2Subagent["status"],
): OrchestrationV2Subagent {
  return makeRawSubagent({
    id: NodeId.make(id),
    parentNodeId: NodeId.make("workflow"),
    title: `agent ${id}`,
    status,
    workflow: {
      kind: "workflow_agent",
      workflowName: "phase-fixer",
      phases: [],
      phaseIndex,
      phaseTitle: phases[phaseIndex]?.title ?? null,
      agentIndex: 0,
      runId: "phase-fixer-mu5n6tcx-i253rw",
    },
  });
}

function groupOf(subagents: ReadonlyArray<OrchestrationV2Subagent>) {
  const model = deriveAgentPanelModel(projectedSubagentsToRuntime(subagents));
  const group = model.workflows[0];
  if (group === undefined) throw new Error("expected a workflow group");
  return { model, group };
}

describe("workflowCardPresentation", () => {
  it("keeps a phase the run never reached out of the done state", () => {
    const { group } = groupOf([coordinator(), member("m0", 0, "completed")]);
    const verified = group.phases.find((phase) => phase.index === 2);
    expect(verified?.state).toBe("skipped");
    expect(workflowPhaseSummary(verified!)).toBe("not reached");
    expect(workflowMembers(group)).toHaveLength(1);
    expect(workflowIsLive(group)).toBe(false);
  });

  it("keeps an unreached phase pending while a paused run can resume", () => {
    const { group } = groupOf([coordinator({ status: "idle" }), member("m0", 0, "completed")]);
    const verified = group.phases.find((phase) => phase.index === 2);
    // Idle is resumable, not terminal: the rail must not claim the phase is gone.
    expect(verified?.state).toBe("pending");
    expect(workflowPhaseSummary(verified!)).toBe("pending");
    expect(workflowIsLive(group)).toBe(true);
  });

  it("summarizes a running phase with active and settled counts", () => {
    const { group } = groupOf([
      coordinator({ status: "running" }),
      member("m0", 1, "running"),
      member("m1", 1, "completed"),
    ]);
    const build = group.phases.find((phase) => phase.index === 1);
    expect(workflowPhaseSummary(build!)).toBe("1 active · 1 done");
  });
});
