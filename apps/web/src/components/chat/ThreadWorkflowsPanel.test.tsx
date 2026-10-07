import { act, cloneElement, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
}));

vi.mock("../../state/entities", () => ({
  useThreadProjection: () => (state.projection === null ? null : { projection: state.projection }),
}));

import { ThreadWorkflowsPanel } from "./ThreadWorkflowsPanel";

let renderer: ReactTestRenderer;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  state.projection = null;
});

const startedAt = DateTime.makeUnsafe("2026-09-16T12:00:00Z");
const updatedAt = DateTime.makeUnsafe("2026-09-16T12:01:00Z");
const completedAt = DateTime.makeUnsafe("2026-09-16T12:02:00Z");

const workflowBlock = {
  kind: "workflow" as const,
  workflowName: "pi_workflow_phase_pending_fix",
  phases: [
    { index: 0, title: "Plan" },
    { index: 1, title: "Implement" },
    { index: 2, title: "Verify" },
  ],
  phaseIndex: null,
  phaseTitle: null,
  agentIndex: null,
  runId: "pi_workflow_phase_pending_fix-mu5n6tcx-i253rw",
};

const coordinator = {
  id: "coordinator",
  title: null,
  prompt: "Run the workflow",
  model: null,
  status: "running" as const,
  result: null,
  startedAt,
  completedAt: null,
  updatedAt,
  workflow: workflowBlock,
};

function member(input: {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly phaseIndex: number | null;
  readonly agentIndex?: number;
}) {
  return {
    id: input.id,
    title: input.title,
    prompt: input.title,
    model: null,
    status: input.status,
    result: null,
    parentNodeId: "coordinator",
    startedAt,
    completedAt: input.status === "completed" || input.status === "failed" ? completedAt : null,
    updatedAt,
    workflow: {
      ...workflowBlock,
      kind: "workflow_agent" as const,
      phaseIndex: input.phaseIndex,
      phaseTitle:
        input.phaseIndex === null ? null : (workflowBlock.phases[input.phaseIndex]?.title ?? null),
      agentIndex: input.agentIndex ?? 0,
    },
  };
}

const panel = (
  <ThreadWorkflowsPanel
    environmentId={EnvironmentId.make("test")}
    threadId={ThreadId.make("thread")}
  />
);

async function render(projection: unknown) {
  state.projection = projection;
  await act(async () => {
    renderer = create(panel);
  });
  return () =>
    renderer.root
      .findAll((node) => typeof node.type === "string")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"))
      .join(" ")
      .replace(/\s+/g, " ");
}

it("renders the workflow name with its run suffix, phases, and members", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const text = await render({
    subagents: [
      coordinator,
      member({ id: "plan", title: "Plan the fix", status: "completed", phaseIndex: 0 }),
      member({ id: "implement", title: "Implement the fix", status: "running", phaseIndex: 1 }),
    ],
  });
  expect(text()).toContain("Workflows · 1");
  expect(text()).toContain("pi_workflow_phase_pending_fix · mu5n6tcx-i253rw");
  expect(text()).toContain("Plan");
  expect(text()).toContain("Implement");
  expect(text()).toContain("Verify");
  expect(text()).toContain("Plan the fix");
  expect(text()).toContain("Implement the fix");
});

it("keeps an unreached phase pending while the run is live, then marks it not reached", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const projection = {
    subagents: [
      coordinator,
      member({ id: "plan", title: "Plan the fix", status: "completed", phaseIndex: 0 }),
      member({ id: "implement", title: "Implement the fix", status: "running", phaseIndex: 1 }),
    ],
  };
  const text = await render(projection);
  expect(text()).toContain("Waiting to start");
  expect(text()).not.toContain("Not reached");
  expect(text()).not.toContain("not reached");

  state.projection = {
    subagents: [
      { ...coordinator, status: "completed", completedAt },
      member({ id: "plan", title: "Plan the fix", status: "completed", phaseIndex: 0 }),
      member({ id: "implement", title: "Implement the fix", status: "completed", phaseIndex: 1 }),
    ],
  };
  await act(async () => renderer.update(cloneElement(panel)));
  expect(text()).toContain("not reached");
  expect(text()).toContain("Not reached");
  expect(text()).not.toContain("Waiting to start");
});

it("never paints a terminal state on a live run's unanswered phase", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const text = await render({
    subagents: [
      { ...coordinator, status: "pending", startedAt: null },
      member({ id: "plan", title: "Plan the fix", status: "pending", phaseIndex: 0 }),
    ],
  });
  expect(text()).toContain("Plan the fix");
  expect(text()).toContain("Waiting to start");
  expect(text()).not.toContain("not reached");
  expect(text()).not.toContain("Not reached");
});

it("shows members whose phase is unknown instead of dropping them", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const text = await render({
    subagents: [
      coordinator,
      member({ id: "orphan", title: "Unknown phase worker", status: "running", phaseIndex: 7 }),
    ],
  });
  expect(text()).toContain("Unphased");
  expect(text()).toContain("Unknown phase worker");
});

it("renders nothing for a thread without workflow subagents", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const text = await render({
    subagents: [
      {
        id: "plain",
        title: "Plain subagent",
        prompt: "Do work",
        model: null,
        status: "running",
        result: null,
        startedAt,
        completedAt: null,
        updatedAt,
      },
    ],
  });
  expect(text()).not.toContain("Workflows");
  expect(text()).not.toContain("Plain subagent");
});

it("renders nothing without a projection", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await render(null);
  expect(renderer.toJSON()).toBeNull();
});
