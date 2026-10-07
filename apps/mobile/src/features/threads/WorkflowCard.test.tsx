import { EnvironmentId, NodeId, type OrchestrationV2Subagent } from "@t3tools/contracts";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import { deriveAgentPanelModel } from "@t3tools/client-runtime/state/workflow-groups";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: "div",
  Pressable: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/AppSymbol", () => ({
  SymbolView: ({ name }: { name: string }) => <span data-icon={name} />,
}));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("./AgentSheetRow", () => ({
  AgentSheetRow: ({ subagent }: { subagent: OrchestrationV2Subagent }) => (
    <div data-agent={subagent.id}>{subagent.title}</div>
  ),
}));

import { makeRawSubagent } from "../../test-fixtures";
import { WorkflowCard } from "./WorkflowCard";

const phases = [
  { index: 0, title: "Plan" },
  { index: 1, title: "Build" },
  { index: 2, title: "Verify" },
];

const subagents: ReadonlyArray<OrchestrationV2Subagent> = [
  makeRawSubagent({
    id: NodeId.make("workflow"),
    title: "phase-fixer",
    status: "running",
    workflow: {
      kind: "workflow",
      workflowName: "phase-fixer",
      phases,
      phaseIndex: null,
      phaseTitle: null,
      agentIndex: null,
      runId: "phase-fixer-mu5n6tcx-i253rw",
    },
  }),
  makeRawSubagent({
    id: NodeId.make("member-plan"),
    parentNodeId: NodeId.make("workflow"),
    title: "planner",
    status: "completed",
    workflow: {
      kind: "workflow_agent",
      workflowName: "phase-fixer",
      phases: [],
      phaseIndex: 0,
      phaseTitle: "Plan",
      agentIndex: 0,
      runId: "phase-fixer-mu5n6tcx-i253rw",
    },
  }),
  makeRawSubagent({
    id: NodeId.make("member-build"),
    parentNodeId: NodeId.make("workflow"),
    title: "builder",
    status: "running",
    workflow: {
      kind: "workflow_agent",
      workflowName: "phase-fixer",
      phases: [],
      phaseIndex: 1,
      phaseTitle: "Build",
      agentIndex: 0,
      runId: "phase-fixer-mu5n6tcx-i253rw",
    },
  }),
];

function renderCard() {
  const model = deriveAgentPanelModel(projectedSubagentsToRuntime(subagents));
  const group = model.workflows[0];
  if (group === undefined) throw new Error("expected a workflow group");
  const subagentById = new Map(subagents.map((subagent) => [subagent.id, subagent]));
  return renderToStaticMarkup(
    <WorkflowCard
      group={group}
      subagentById={subagentById}
      environmentId={EnvironmentId.make("environment-test")}
      tickSeconds={false}
      onOpen={() => {}}
    />,
  );
}

describe("WorkflowCard", () => {
  it("renders a live run with its phases, members, and run suffix", () => {
    const markup = renderCard();
    expect(markup).toContain("phase-fixer · mu5n6tcx-i253rw");
    expect(markup).toContain("1/2 settled");
    expect(markup).toContain("Plan");
    expect(markup).toContain("Build");
    expect(markup).toContain("Verify");
    // The running phase opens itself and shows its member.
    expect(markup).toContain("builder");
  });

  it("does not mark a phase the live run never reached as done", () => {
    const markup = renderCard();
    // Verify has no member yet and the run is not terminal: pending, not done.
    expect(markup).toContain("pending");
    expect(markup).not.toContain("✓ Verify");
  });
});
