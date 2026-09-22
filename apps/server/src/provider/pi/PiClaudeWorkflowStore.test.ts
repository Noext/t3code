import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makePiClaudeWorkflowStore } from "./PiClaudeWorkflowStore.ts";

const SESSION = "session-a";
const RUN_ID = "wf_a1b2c3d4-e5f";

const feedPath = (path: Path.Path, sessionDir: string, runId: string) =>
  path.join(sessionDir, "workflows", `${runId}.events.jsonl`);

const writeFile = Effect.fn(function* (filePath: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, contents);
});

const appendFile = Effect.fn(function* (filePath: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(filePath, contents, { flag: "a" });
});

/** One feed line, stamped the way the writer stamps it. */
const record = (value: Record<string, unknown>, t = 1_000) =>
  `${JSON.stringify({ t, ...value })}\n`;

/** A record's JSON, as the writer would leave it on one line. */
const jsonOf = (value: Record<string, unknown>): string => JSON.stringify(value);

const runRecord = (overrides: Record<string, unknown> = {}) => ({
  type: "run",
  runId: RUN_ID,
  sessionId: SESSION,
  workflowName: "Adapter hardening",
  title: "harden the adapter",
  startTime: 1_000,
  phases: [
    { index: 1, title: "Recon" },
    { index: 2, title: "Fix" },
  ],
  ...overrides,
});

const agentRecord = (index: number, overrides: Record<string, unknown> = {}) => ({
  type: "workflow_agent",
  index,
  label: `agent-${index}`,
  phaseTitle: "Recon",
  state: "start",
  queuedAt: 1_000,
  lastProgressAt: 1_000,
  ...overrides,
});

const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

it.layer(NodeServices.layer)("PiClaudeWorkflowStore", (it) => {
  it.effect("folds a live feed into a run snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-claude-workflow-" });
      yield* writeFile(
        feedPath(path, sessionDir, RUN_ID),
        [
          record(runRecord()),
          record({ type: "workflow_phase", index: 1, title: "Recon" }),
          record(agentRecord(1)),
          record(agentRecord(1, { state: "done", tokens: 120, lastProgressAt: 1_400 }), 1_400),
        ].join(""),
      );

      const store = yield* makePiClaudeWorkflowStore({ sessionDir });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({ sessionIds: [SESSION] });

      assert.deepEqual(unresolvedRunIds, []);
      assert.lengthOf(runs, 1);
      const run = runs[0]!;
      assert.strictEqual(run.runId, RUN_ID);
      assert.strictEqual(run.workflowName, "Adapter hardening");
      assert.strictEqual(run.sessionId, SESSION);
      // No status record yet is exactly what a run in flight looks like.
      assert.strictEqual(run.status, "running");
      assert.deepEqual(run.phases, ["Recon", "Fix"]);
      assert.strictEqual(run.currentPhase, "Recon");
      assert.strictEqual(run.startedAt, iso(1_000));
      assert.strictEqual(run.updatedAt, iso(1_400));
      assert.strictEqual(run.completedAt, undefined);
      assert.deepEqual(run.agents, [
        {
          id: "1",
          label: "agent-1",
          phase: "Recon",
          status: "done",
          model: undefined,
          tokens: 120,
          startedAt: undefined,
          endedAt: iso(1_400),
        },
      ]);
    }),
  );

  it.effect("keeps what a later record for the same agent omits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-claude-workflow-" });
      yield* writeFile(
        feedPath(path, sessionDir, RUN_ID),
        [
          record(runRecord()),
          record(agentRecord(1, { model: "local-openai/opencode-go/deepseek-v4.1-flash" })),
          // A progress record says only what changed: a reader that let its
          // absence stand for "now empty" would erase the label and the model.
          record(
            { type: "workflow_agent", index: 1, state: "progress", lastProgressAt: 1_200 },
            1_200,
          ),
        ].join(""),
      );

      const store = yield* makePiClaudeWorkflowStore({ sessionDir });
      const { runs } = yield* store.listRunsForSession({ sessionIds: [SESSION] });

      assert.strictEqual(runs[0]?.agents[0]?.label, "agent-1");
      assert.strictEqual(runs[0]?.agents[0]?.model, "local-openai/opencode-go/deepseek-v4.1-flash");
      assert.strictEqual(runs[0]?.agents[0]?.status, "running");
    }),
  );

  it.effect("surfaces only runs owned by a session it was asked about", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-claude-workflow-" });
      yield* writeFile(
        feedPath(path, sessionDir, RUN_ID),
        record(runRecord({ sessionId: "session-b" })),
      );
      // Written before the writer recorded an owner: readable, but nothing here
      // may attribute it to this thread.
      yield* writeFile(
        feedPath(path, sessionDir, "wf_ownerless"),
        record(runRecord({ runId: "wf_ownerless", sessionId: undefined })),
      );
      yield* writeFile(
        feedPath(path, sessionDir, "wf_ours"),
        record(runRecord({ runId: "wf_ours" })),
      );

      const store = yield* makePiClaudeWorkflowStore({ sessionDir });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({ sessionIds: [SESSION] });

      assert.deepEqual(
        runs.map((run) => run.runId),
        ["wf_ours"],
      );
      // Unattributable is not unreadable: these runs were read, so nothing is
      // reported as an unresolved run that a tracked card would wait on.
      assert.deepEqual(unresolvedRunIds, []);
    }),
  );

  it.effect("reads the terminal status, its totals and its failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-claude-workflow-" });
      yield* writeFile(
        feedPath(path, sessionDir, RUN_ID),
        [
          record(runRecord()),
          record(
            {
              type: "status",
              status: "failed",
              endTime: 9_000,
              error: "agent blew up",
              totalTokens: 456,
            },
            9_000,
          ),
        ].join(""),
      );

      const store = yield* makePiClaudeWorkflowStore({ sessionDir });
      const { runs } = yield* store.listRunsForSession({ sessionIds: [SESSION] });

      const run = runs[0]!;
      assert.strictEqual(run.status, "failed");
      assert.strictEqual(run.error, "agent blew up");
      assert.strictEqual(run.totalTokens, 456);
      assert.strictEqual(run.completedAt, iso(9_000));
      assert.strictEqual(run.updatedAt, iso(9_000));
    }),
  );

  it.effect("settles the agents a terminal run left running", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-claude-workflow-" });
      yield* writeFile(
        feedPath(path, sessionDir, RUN_ID),
        [
          record(runRecord()),
          record(agentRecord(1)),
          record(agentRecord(2, { state: "done", lastProgressAt: 1_300 }), 1_300),
          // This engine calls an aborted run `killed`.
          record({ type: "status", status: "killed", endTime: 2_000 }, 2_000),
        ].join(""),
      );

      const store = yield* makePiClaudeWorkflowStore({ sessionDir });
      const { runs } = yield* store.listRunsForSession({ sessionIds: [SESSION] });

      const run = runs[0]!;
      assert.strictEqual(run.status, "aborted");
      // Left as it was, the agent that never finished would read as in progress
      // under a run that already ended.
      assert.deepEqual(
        run.agents.map((agent) => agent.status),
        ["error", "done"],
      );
      assert.strictEqual(run.agents[0]?.endedAt, iso(2_000));
      assert.strictEqual(run.agents[1]?.endedAt, iso(1_300));
    }),
  );

  it.effect("folds only complete records and picks up the rest next sweep", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-claude-workflow-" });
      const filePath = feedPath(path, sessionDir, RUN_ID);
      // A record being written right now: `appendFile` lands in one write, but a
      // reader that sweeps between two writes sees a line whose newline has not
      // arrived yet.
      const pending = jsonOf({
        t: 1_100,
        type: "workflow_agent",
        index: 1,
        label: "late",
        state: "start",
      });
      const splitAt = 20;
      yield* writeFile(filePath, record(runRecord()) + pending.slice(0, splitAt));

      const store = yield* makePiClaudeWorkflowStore({ sessionDir });
      const first = yield* store.listRunsForSession({ sessionIds: [SESSION] });
      assert.deepEqual(first.runs[0]?.agents, []);

      yield* appendFile(filePath, `${pending.slice(splitAt)}\n`);
      const second = yield* store.listRunsForSession({ sessionIds: [SESSION] });

      assert.strictEqual(second.runs[0]?.agents[0]?.label, "late");
    }),
  );

  it.effect("refolds a feed that was truncated under it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-claude-workflow-" });
      const filePath = feedPath(path, sessionDir, "wf_reused");
      yield* writeFile(
        filePath,
        [
          record(runRecord({ runId: "wf_reused" })),
          record(agentRecord(1)),
          record(agentRecord(2)),
        ].join(""),
      );

      const store = yield* makePiClaudeWorkflowStore({ sessionDir });
      const before = yield* store.listRunsForSession({ sessionIds: [SESSION] });
      assert.lengthOf(before.runs[0]?.agents ?? [], 2);

      // The writer this reader was built for only appends. A file that came back
      // shorter is a different file, and folding it at the old offset would mix
      // two runs' state.
      yield* writeFile(
        filePath,
        record(runRecord({ runId: "wf_reused", workflowName: "second life" })),
      );
      const after = yield* store.listRunsForSession({ sessionIds: [SESSION] });

      assert.deepEqual(after.runs[0]?.agents, []);
      assert.strictEqual(after.runs[0]?.workflowName, "second life");
    }),
  );

  it.effect("ignores the settle snapshot and the control files beside a feed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-claude-workflow-" });
      const workflows = path.join(sessionDir, "workflows");
      yield* writeFile(
        path.join(workflows, `${RUN_ID}.json`),
        jsonOf({ runId: RUN_ID, sessionId: SESSION, status: "completed" }),
      );
      yield* writeFile(path.join(workflows, `${RUN_ID}.control.json`), jsonOf({ action: "stop" }));
      yield* writeFile(path.join(workflows, `${RUN_ID}.control.ack.json`), jsonOf({ ok: true }));
      yield* writeFile(path.join(workflows, `${RUN_ID}.js`), "export const meta = {}");

      const store = yield* makePiClaudeWorkflowStore({ sessionDir });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({ sessionIds: [SESSION] });

      assert.deepEqual(runs, []);
      assert.deepEqual(unresolvedRunIds, []);
    }),
  );

  it.effect("orders matches by their last update and ignores the file name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-claude-workflow-" });
      // Run ids are opaque; only the feed's own timestamps say which run moved last.
      yield* writeFile(
        feedPath(path, sessionDir, "wf_aaa"),
        record(runRecord({ runId: "wf_aaa" }), 5_000),
      );
      yield* writeFile(
        feedPath(path, sessionDir, "wf_zzz"),
        record(runRecord({ runId: "wf_zzz" }), 2_000),
      );

      const store = yield* makePiClaudeWorkflowStore({ sessionDir });
      const { runs } = yield* store.listRunsForSession({ sessionIds: [SESSION] });

      assert.deepEqual(
        runs.map((run) => run.runId),
        ["wf_aaa", "wf_zzz"],
      );
    }),
  );

  it.effect("treats an absent feed directory as an empty store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-claude-workflow-" });

      const store = yield* makePiClaudeWorkflowStore({ sessionDir });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({ sessionIds: [SESSION] });

      assert.deepEqual(runs, []);
      assert.deepEqual(unresolvedRunIds, []);
    }),
  );

  it.effect("reports a feed it cannot read as unresolved rather than as gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-claude-workflow-" });
      // A directory where a feed should be: listed, unreadable as a file.
      yield* fs.makeDirectory(path.join(sessionDir, "workflows", "wf_broken.events.jsonl"), {
        recursive: true,
      });

      const store = yield* makePiClaudeWorkflowStore({ sessionDir });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({ sessionIds: [SESSION] });

      assert.deepEqual(runs, []);
      assert.deepEqual(unresolvedRunIds, ["wf_broken"]);
    }),
  );
});
