import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  defaultPiSubagentRunsRoot,
  makePiSubagentRunStore,
  piSessionIdFromRunSession,
} from "./PiSubagentRunStore.ts";

const writeFile = Effect.fn(function* (filePath: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, contents);
});

const writeJson = (filePath: string, value: unknown) =>
  writeFile(filePath, JSON.stringify(value, null, 2));

/** The shape the extension writes for a three-lane fan-out; see the module note. */
const workflowRun = (overrides: Record<string, unknown> = {}) => ({
  runId: "ffff9ac9-b04e-438f-a291-bc85985394ea",
  mode: "workflow",
  state: "running",
  sessionId:
    "/root/.pi/agent/sessions/--root-Dev--/2026-10-10T09-23-23-682Z_01a1251f-cda1-7014-93ab-46b577b5e876.jsonl",
  startedAt: 1_791_622_585_321,
  lastUpdate: 1_791_622_585_340,
  workflow: { trace: [] },
  steps: [
    {
      agent: "researcher",
      label: "axe1",
      workflowKey: "axe1",
      status: "running",
      startedAt: 1_791_622_585_373,
      runId: "88a97834-42af-4c91-8e5e-30b38bd39eb2",
      tokens: { total: 1000, input: 700, output: 300 },
    },
    {
      agent: "researcher",
      label: "axe2",
      workflowKey: "axe2",
      status: "complete",
      startedAt: 1_791_622_585_400,
      durationMs: 60_000,
      runId: "e4aa93cf-416f-49ae-90db-85f81484ebae",
      tokens: { total: 2500 },
    },
  ],
  ...overrides,
});

const statusPath = (path: Path.Path, root: string, runId: string) =>
  path.join(root, runId, "status.json");

/** Same representation the reader builds, so the assertion is about the value. */
const iso = (epochMs: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

it.layer(NodeServices.layer)("PiSubagentRunStore", (it) => {
  it.effect("maps a workflow run's lanes into one snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-subagent-runs-" });
      const record = workflowRun();
      yield* writeJson(statusPath(path, root, record.runId), record);

      const store = yield* makePiSubagentRunStore({ runsRoot: root });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd: "/root/Dev",
        sessionIds: ["01a1251f-cda1-7014-93ab-46b577b5e876"],
      });

      assert.lengthOf(runs, 1);
      assert.deepEqual(unresolvedRunIds, []);
      const run = runs[0];
      assert.strictEqual(run?.runId, record.runId);
      assert.strictEqual(run?.status, "running");
      assert.strictEqual(run?.sessionId, "01a1251f-cda1-7014-93ab-46b577b5e876");
      assert.deepEqual(run?.phases, ["axe1", "axe2"]);
      assert.strictEqual(run?.currentPhase, "axe1");
      assert.lengthOf(run?.agents ?? [], 2);
      assert.strictEqual(run?.agents[0]?.label, "axe1");
      assert.strictEqual(run?.agents[0]?.status, "running");
      assert.strictEqual(run?.agents[0]?.tokens, 1000);
      assert.strictEqual(run?.agents[1]?.status, "done");
      assert.strictEqual(run?.agents[1]?.tokens, 2500);
      // A single lane's tokens are not the run's total while it is still running.
      assert.strictEqual(run?.totalTokens, undefined);
    }),
  );

  it.effect("reports a settled run's total, duration and end", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-subagent-runs-" });
      const record = workflowRun({
        state: "complete",
        lastUpdate: 1_791_622_585_321 + 90_000,
        steps: [
          {
            label: "axe1",
            agent: "researcher",
            status: "complete",
            startedAt: 1_791_622_585_373,
            durationMs: 90_000,
            tokens: { total: 1000 },
          },
          { label: "axe2", agent: "researcher", status: "complete", tokens: { total: 500 } },
        ],
      });
      yield* writeJson(statusPath(path, root, record.runId), record);

      const store = yield* makePiSubagentRunStore({ runsRoot: root });
      const { runs } = yield* store.listRunsForSession({
        cwd: "/root/Dev",
        sessionIds: ["01a1251f-cda1-7014-93ab-46b577b5e876"],
      });

      assert.strictEqual(runs[0]?.status, "completed");
      assert.strictEqual(runs[0]?.totalTokens, 1500);
      assert.strictEqual(runs[0]?.durationMs, 90_000);
      assert.strictEqual(runs[0]?.startedAt, iso(1_791_622_585_321));
      assert.strictEqual(runs[0]?.completedAt, iso(1_791_622_585_321 + 90_000));
      assert.strictEqual(runs[0]?.currentPhase, undefined);
    }),
  );

  it.effect("ignores a child run and a run of another session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-subagent-runs-" });
      const record = workflowRun();
      yield* writeJson(statusPath(path, root, record.runId), record);
      // A workflow's children are written beside it as `single` runs.
      yield* writeJson(statusPath(path, root, "88a97834-42af-4c91-8e5e-30b38bd39eb2"), {
        runId: "88a97834-42af-4c91-8e5e-30b38bd39eb2",
        mode: "single",
        state: "complete",
        sessionId: record.sessionId,
        steps: [{ agent: "researcher", status: "complete", runId: "88a97834" }],
      });
      // Same fan-out, launched by a session this thread does not own.
      yield* writeJson(statusPath(path, root, "9b0d48af-b408-4eb9-9ba6-6009285f8265"), {
        ...workflowRun({ runId: "9b0d48af-b408-4eb9-9ba6-6009285f8265" }),
        sessionId: "/root/.pi/agent/sessions/--root-Dev--/2026-10-10T07-00-00-000Z_other.jsonl",
      });

      const store = yield* makePiSubagentRunStore({ runsRoot: root });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd: "/root/Dev",
        sessionIds: ["01a1251f-cda1-7014-93ab-46b577b5e876"],
      });

      assert.deepEqual(
        runs.map((run) => run.runId),
        [record.runId],
      );
      // Neither skip is a problem with the file: nothing is unresolved.
      assert.deepEqual(unresolvedRunIds, []);
    }),
  );

  it.effect("treats an undecodable record as unresolved rather than ended", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-subagent-runs-" });
      const runId = "0a385ab4-0000-4000-8000-000000000001";
      yield* writeFile(statusPath(path, root, runId), "{ not json");

      const store = yield* makePiSubagentRunStore({ runsRoot: root });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd: "/root/Dev",
        sessionIds: ["01a1251f-cda1-7014-93ab-46b577b5e876"],
      });

      assert.deepEqual(runs, []);
      assert.deepEqual(unresolvedRunIds, [runId]);
    }),
  );

  it.effect("reads an absent root as an empty listing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-subagent-runs-" });

      const store = yield* makePiSubagentRunStore({ runsRoot: path.join(root, "absent") });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd: "/root/Dev",
        sessionIds: ["01a1251f-cda1-7014-93ab-46b577b5e876"],
      });

      assert.deepEqual(runs, []);
      assert.deepEqual(unresolvedRunIds, []);
    }),
  );

  it.effect("re-reads a run whose status file changed in place", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-subagent-runs-" });
      const record = workflowRun();
      const filePath = statusPath(path, root, record.runId);
      yield* writeJson(filePath, record);

      const store = yield* makePiSubagentRunStore({ runsRoot: root });
      const sessions = { cwd: "/root/Dev", sessionIds: ["01a1251f-cda1-7014-93ab-46b577b5e876"] };
      const first = yield* store.listRunsForSession(sessions);
      assert.strictEqual(first.runs[0]?.status, "running");

      // The writer replaces the file by rename; the cache must notice even when
      // size and mtime look unchanged at filesystem resolution.
      yield* writeJson(filePath, workflowRun({ state: "complete", lastUpdate: 1_791_622_585_900 }));
      const second = yield* store.listRunsForSession(sessions);
      assert.strictEqual(second.runs[0]?.status, "completed");
    }),
  );

  it("reduces the writer's session path to the id T3 matches on", () => {
    assert.strictEqual(
      piSessionIdFromRunSession(
        "/root/.pi/agent/sessions/--root-Dev--/2026-10-10T09-23-23-682Z_01a1251f-cda1-7014-93ab-46b577b5e876.jsonl",
      ),
      "01a1251f-cda1-7014-93ab-46b577b5e876",
    );
    assert.strictEqual(
      piSessionIdFromRunSession("01a1251f-cda1-7014-93ab-46b577b5e876"),
      "01a1251f-cda1-7014-93ab-46b577b5e876",
    );
    assert.strictEqual(piSessionIdFromRunSession(undefined), undefined);
    assert.strictEqual(piSessionIdFromRunSession("   "), undefined);
  });

  it("resolves the same temp root the extension writes under", () => {
    assert.strictEqual(
      defaultPiSubagentRunsRoot({ PI_SUBAGENTS_TEMP_ROOT: "/var/tmp/pi-runs" }),
      "/var/tmp/pi-runs/async-subagent-runs",
    );
    const fallback = defaultPiSubagentRunsRoot({});
    assert.isTrue(fallback.endsWith("/async-subagent-runs"));
    assert.isTrue(fallback.includes("/pi-subagents-"));
  });
});
