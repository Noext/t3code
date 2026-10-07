import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { projectedSubagentsToRuntime } from "./subagentRuntime.ts";
import { deriveAgentPanelModel } from "./workflowGroups.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function subagent(
  overrides: Omit<Partial<OrchestrationV2Subagent>, "id"> & { readonly id: string },
): OrchestrationV2Subagent {
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
}

describe("projectedSubagentsToRuntime", () => {
  it("projects a plain subagent without workflow fields", () => {
    const [projected] = projectedSubagentsToRuntime([subagent({ id: "plain" })]);
    expect(projected).toMatchObject({
      id: "plain",
      kind: "subagent",
      workflowName: null,
      phases: [],
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      runHandles: null,
    });
  });

  it("projects a workflow coordinator with its full phase list and run id", () => {
    const [projected] = projectedSubagentsToRuntime([
      subagent({
        id: "run-a",
        title: "audit_auth_flow",
        workflow: {
          kind: "workflow",
          workflowName: "audit_auth_flow",
          phases: [
            { index: 0, title: "Recon" },
            { index: 1, title: "Design" },
          ],
          phaseIndex: null,
          phaseTitle: null,
          agentIndex: null,
          runId: "audit-auth-flow-mu5n6tcx-i253rw",
        },
      }),
    ]);

    expect(projected).toMatchObject({
      id: "run-a",
      kind: "workflow",
      workflowName: "audit_auth_flow",
      phases: [
        { index: 0, title: "Recon" },
        { index: 1, title: "Design" },
      ],
      parentAgentId: null,
      runHandles: { runId: "audit-auth-flow-mu5n6tcx-i253rw" },
    });
  });

  it("projects a workflow member linked to its coordinator phase", () => {
    const [projected] = projectedSubagentsToRuntime([
      subagent({
        id: "run-a:wf:1",
        title: "recon-store",
        parentNodeId: NodeId.make("run-a"),
        workflow: {
          kind: "workflow_agent",
          workflowName: "audit_auth_flow",
          phases: [],
          phaseIndex: 0,
          phaseTitle: "Recon",
          agentIndex: 1,
          runId: "audit-auth-flow-mu5n6tcx-i253rw",
        },
      }),
    ]);

    expect(projected).toMatchObject({
      id: "run-a:wf:1",
      kind: "workflow_agent",
      workflowName: "audit_auth_flow",
      phases: [],
      parentAgentId: "run-a",
      agentIndex: 1,
      phaseIndex: 0,
      phaseTitle: "Recon",
      runHandles: { runId: "audit-auth-flow-mu5n6tcx-i253rw" },
    });
  });

  it("leaves a legacy subagent without a workflow block untouched", () => {
    const [projected] = projectedSubagentsToRuntime([
      subagent({ id: "legacy", parentNodeId: NodeId.make("some-parent") }),
    ]);
    expect(projected).toMatchObject({
      kind: "subagent",
      parentAgentId: null,
      phases: [],
      runHandles: null,
    });
  });

  it("carries a failed status into the error field", () => {
    const [projected] = projectedSubagentsToRuntime([
      subagent({ id: "boom", status: "failed", result: "it broke" }),
    ]);
    expect(projected?.status).toBe("failed");
    expect(projected?.error).toBe("it broke");
  });

  it("feeds the workflow grouping helper end to end", () => {
    const projected = projectedSubagentsToRuntime([
      subagent({
        id: "run-a",
        title: "audit_auth_flow",
        status: "completed",
        workflow: {
          kind: "workflow",
          workflowName: "audit_auth_flow",
          phases: [
            { index: 0, title: "Recon" },
            { index: 1, title: "Design" },
          ],
          phaseIndex: null,
          phaseTitle: null,
          agentIndex: null,
          runId: "audit-auth-flow-mu5n6tcx-i253rw",
        },
      }),
      subagent({
        id: "run-a:wf:0",
        parentNodeId: NodeId.make("run-a"),
        status: "completed",
        workflow: {
          kind: "workflow_agent",
          workflowName: "audit_auth_flow",
          phases: [],
          phaseIndex: 0,
          phaseTitle: "Recon",
          agentIndex: 0,
          runId: "audit-auth-flow-mu5n6tcx-i253rw",
        },
      }),
    ]);

    const model = deriveAgentPanelModel(projected);
    expect(model.workflows).toHaveLength(1);
    expect(model.workflows[0]!.label).toBe("audit_auth_flow · mu5n6tcx-i253rw");
    expect(model.workflows[0]!.phases.map((phase) => `${phase.title}:${phase.state}`)).toEqual([
      "Recon:done",
      "Design:skipped",
    ]);
  });
});
