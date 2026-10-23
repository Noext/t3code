import { NodeId, ThreadId, type OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { settleSubagentsOfEndedRuns } from "./settledSubagents.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function subagent(
  overrides: Omit<Partial<OrchestrationV2Subagent>, "id"> & { readonly id: string },
): OrchestrationV2Subagent {
  const { id, ...rest } = overrides;
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: null,
    parentNodeId: NodeId.make("node-root"),
    origin: "provider_native",
    createdBy: "agent",
    driver: "pi" as OrchestrationV2Subagent["driver"],
    providerInstanceId: "pi" as OrchestrationV2Subagent["providerInstanceId"],
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "TRANSITION_NOT_OBSERVED",
    title: "subagents 8c065704",
    model: null,
    status: "running",
    progress: null,
    result: null,
    startedAt: at("2026-10-22T18:50:15.968Z"),
    completedAt: null,
    updatedAt: at("2026-10-22T18:50:16.143Z"),
    ...rest,
  } as OrchestrationV2Subagent;
}

const row = (subagent_id: string, run_status: string, completed_at: string | null = null) => ({
  subagent_id,
  run_status,
  completed_at,
});

it("settles a subagent whose run ended, keeping the run's completion time", () => {
  const [settled] = settleSubagentsOfEndedRuns(
    [subagent({ id: "coordinator" })],
    [row("coordinator", "completed", "2026-10-22T19:10:00.000Z")],
  );
  expect(settled!.status).toBe("completed");
  expect(settled!.completedAt?.toString()).toBe(at("2026-10-22T19:10:00.000Z").toString());
});

it("carries the run's failure onto its subagents", () => {
  const [settled] = settleSubagentsOfEndedRuns(
    [subagent({ id: "coordinator" })],
    [row("coordinator", "failed", "2026-10-22T19:10:00.000Z")],
  );
  expect(settled!.status).toBe("failed");
});

it("reads a rolled-back run as interrupted work", () => {
  const [settled] = settleSubagentsOfEndedRuns(
    [subagent({ id: "coordinator" })],
    [row("coordinator", "rolled_back", "2026-10-22T19:10:00.000Z")],
  );
  expect(settled!.status).toBe("interrupted");
});

it("falls back to the row's own update time when the run has no completion time", () => {
  const [settled] = settleSubagentsOfEndedRuns(
    [subagent({ id: "coordinator" })],
    [row("coordinator", "cancelled")],
  );
  expect(settled!.status).toBe("cancelled");
  expect(settled!.completedAt?.toString()).toBe(at("2026-10-22T18:50:16.143Z").toString());
});

it("leaves a live subagent alone", () => {
  const live = subagent({ id: "coordinator" });
  const [settled] = settleSubagentsOfEndedRuns([live], []);
  expect(settled).toBe(live);
});

it("keeps the array when nothing is stale, so readers keep referential equality", () => {
  const subagents = [subagent({ id: "coordinator" })];
  expect(settleSubagentsOfEndedRuns(subagents, [row("someone-else", "completed")])).toBe(subagents);
});

it("ignores a row whose run status is not terminal", () => {
  const subagents = [subagent({ id: "coordinator" })];
  expect(settleSubagentsOfEndedRuns(subagents, [row("coordinator", "waiting")])).toBe(subagents);
});

it("never rewrites an existing completion time", () => {
  const completed = subagent({
    id: "coordinator",
    status: "running",
    completedAt: at("2026-10-22T18:51:00.000Z"),
  });
  const [settled] = settleSubagentsOfEndedRuns(
    [completed],
    [row("coordinator", "completed", "2026-10-22T19:10:00.000Z")],
  );
  expect(settled!.completedAt?.toString()).toBe(at("2026-10-22T18:51:00.000Z").toString());
});
