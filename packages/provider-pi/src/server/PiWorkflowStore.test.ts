import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makePiWorkflowStore, piWorkflowProjectKey } from "./PiWorkflowStore.ts";

const writeFile = Effect.fn(function* (filePath: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, contents);
});

const writeJson = (filePath: string, value: unknown) =>
  writeFile(filePath, JSON.stringify(value, null, 2));

const runPath = (path: Path.Path, home: string, cwd: string, runId: string) =>
  path.join(home, "projects", piWorkflowProjectKey(cwd), "runs", `${runId}.json`);

const baseRun = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-1",
  workflowName: "Adapter hardening",
  status: "running",
  phases: ["Recon", "Fix"],
  currentPhase: "Recon",
  agents: [
    {
      id: 1,
      label: "recon-store",
      phase: "Recon",
      status: "running",
      model: "local-openai/opencode-go/deepseek-v4.1-flash:high",
      tokens: 1234,
      startedAt: "2026-09-17T08:04:33.118Z",
      endedAt: null,
    },
  ],
  sessionId: "session-a",
  parentSessionId: "session-a",
  startedAt: "2026-09-17T08:04:33.118Z",
  updatedAt: "2026-09-17T08:05:33.118Z",
  ...overrides,
});

it.layer(NodeServices.layer)("PiWorkflowStore", (it) => {
  it.effect("reads a matching run and maps it to a snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      yield* writeJson(runPath(path, home, cwd, "run-1"), baseRun());

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd,
        sessionIds: ["session-a"],
      });

      assert.lengthOf(runs, 1);
      assert.deepEqual(unresolvedRunIds, []);
      assert.strictEqual(runs[0]?.runId, "run-1");
      assert.strictEqual(runs[0]?.workflowName, "Adapter hardening");
      assert.strictEqual(runs[0]?.currentPhase, "Recon");
      assert.deepEqual(runs[0]?.phases, ["Recon", "Fix"]);
      assert.strictEqual(runs[0]?.agents[0]?.id, "1");
      assert.strictEqual(runs[0]?.agents[0]?.tokens, 1234);
    }),
  );

  it.effect("hides runs that belong to another session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      yield* writeJson(
        runPath(path, home, cwd, "run-other"),
        baseRun({ runId: "run-other", sessionId: "session-b", parentSessionId: "session-b" }),
      );

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const { runs } = yield* store.listRunsForSession({ cwd, sessionIds: ["session-a"] });
      assert.deepEqual(runs, []);
    }),
  );

  it.effect("matches a re-homed run by its delivery owner, never by its parent session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      // The writer re-homes `sessionId` on an in-process fork and leaves the
      // immutable `parentSessionId` on the pre-fork id; its own navigator shows
      // the run only to the delivery owner. Matching the parent here would
      // attribute a run owned by another session to this thread.
      yield* writeJson(
        runPath(path, home, cwd, "run-forked"),
        baseRun({ runId: "run-forked", sessionId: "session-forked", parentSessionId: "session-a" }),
      );

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const owner = yield* store.listRunsForSession({ cwd, sessionIds: ["session-forked"] });
      assert.deepEqual(
        owner.runs.map((run) => run.runId),
        ["run-forked"],
      );

      const parent = yield* store.listRunsForSession({ cwd, sessionIds: ["session-a"] });
      assert.deepEqual(parent.runs, []);
    }),
  );

  it.effect("returns nothing when the store directory is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const store = yield* makePiWorkflowStore({ homeDir: home });
      const listing = yield* store.listRunsForSession({
        cwd: path.join(home, "missing"),
        sessionIds: ["session-a"],
      });
      assert.deepEqual(listing.runs, []);
      assert.deepEqual(listing.unresolvedRunIds, []);
    }),
  );

  it.effect("does not read an unlistable project directory as an empty store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      // `runs` exists but is a regular file: listing it fails with ENOTDIR. That
      // is not evidence that a run ended, so the sweep must fail instead of
      // reporting an empty store — which the caller would read as "all gone".
      yield* writeFile(path.join(home, "projects", piWorkflowProjectKey(cwd), "runs"), "");

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const exit = yield* Effect.exit(store.listRunsForSession({ cwd, sessionIds: ["session-a"] }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("skips a malformed file and keeps reading the directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      yield* writeFile(runPath(path, home, cwd, "run-broken"), "{ not json");
      yield* writeJson(runPath(path, home, cwd, "run-good"), baseRun({ runId: "run-good" }));

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd,
        sessionIds: ["session-a"],
      });
      assert.deepEqual(
        runs.map((run) => run.runId),
        ["run-good"],
      );
      // The broken file still exists: the run it names is unresolved, not gone.
      assert.deepEqual(unresolvedRunIds, ["run-broken"]);
    }),
  );

  it.effect("recovers a truncated primary from its .bak sibling", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      const primary = runPath(path, home, cwd, "run-bak");
      yield* writeFile(primary, "");
      yield* writeJson(`${primary}.bak`, baseRun({ runId: "run-bak", workflowName: "Recovered" }));

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const { runs } = yield* store.listRunsForSession({ cwd, sessionIds: ["session-a"] });
      assert.lengthOf(runs, 1);
      assert.strictEqual(runs[0]?.workflowName, "Recovered");
    }),
  );

  it.effect("caps the .bak size too, so a bad primary cannot pull in a huge backup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      const primary = runPath(path, home, cwd, "run-big-bak");
      yield* writeFile(primary, "{ truncated");
      yield* writeJson(
        `${primary}.bak`,
        baseRun({ runId: "run-big-bak", result: "x".repeat(4 * 1024 * 1024 + 1) }),
      );

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd,
        sessionIds: ["session-a"],
      });
      assert.deepEqual(runs, []);
      assert.deepEqual(unresolvedRunIds, ["run-big-bak"]);
    }),
  );

  it.effect("degrades to silence when the format changes under it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      // A future extension version renames the lifecycle field.
      yield* writeJson(runPath(path, home, cwd, "run-v9"), {
        runId: "run-v9",
        workflowName: "Future shape",
        lifecycle: "running",
        agents: [{ id: 1, label: "a", lifecycle: "running" }],
      });

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd,
        sessionIds: ["session-a"],
      });
      assert.deepEqual(runs, []);
      assert.deepEqual(unresolvedRunIds, ["run-v9"]);
    }),
  );

  it.effect("reports an already-tracked run as unresolved when it stops decoding", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      const filePath = runPath(path, home, cwd, "run-live");
      yield* writeJson(filePath, baseRun({ runId: "run-live" }));

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const first = yield* store.listRunsForSession({ cwd, sessionIds: ["session-a"] });
      assert.deepEqual(
        first.runs.map((run) => run.runId),
        ["run-live"],
      );

      // A writer-side field rename lands on a run the caller is already
      // tracking. The file is still there and the run may still be running.
      yield* writeJson(filePath, {
        runId: "run-live",
        workflowName: "Renamed",
        lifecycle: "running",
      });
      const renamed = yield* store.listRunsForSession({ cwd, sessionIds: ["session-a"] });
      assert.deepEqual(renamed.runs, []);
      assert.deepEqual(renamed.unresolvedRunIds, ["run-live"]);

      // A record past the size cap takes the same path: unreadable, not gone.
      yield* writeJson(
        filePath,
        baseRun({ runId: "run-live", status: "completed", result: "x".repeat(4 * 1024 * 1024) }),
      );
      const oversized = yield* store.listRunsForSession({ cwd, sessionIds: ["session-a"] });
      assert.deepEqual(oversized.runs, []);
      assert.deepEqual(oversized.unresolvedRunIds, ["run-live"]);
    }),
  );

  it.effect("skips a run file past the size cap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      const huge = baseRun({ runId: "run-huge", result: "x".repeat(4 * 1024 * 1024 + 1) });
      yield* writeJson(runPath(path, home, cwd, "run-huge"), huge);
      yield* writeJson(runPath(path, home, cwd, "run-small"), baseRun({ runId: "run-small" }));

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const { runs } = yield* store.listRunsForSession({ cwd, sessionIds: ["session-a"] });
      assert.deepEqual(
        runs.map((run) => run.runId),
        ["run-small"],
      );
    }),
  );

  it.effect("orders matches by updatedAt and ignores non-run files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      yield* writeJson(
        runPath(path, home, cwd, "run-old"),
        baseRun({ runId: "run-old", updatedAt: "2026-09-17T08:00:00.000Z" }),
      );
      yield* writeJson(
        runPath(path, home, cwd, "run-new"),
        baseRun({ runId: "run-new", updatedAt: "2026-09-17T09:00:00.000Z" }),
      );
      yield* writeFile(runPath(path, home, cwd, "run-old") + ".lock", "{}");
      yield* writeFile(runPath(path, home, cwd, "run-old") + ".json.tmp", "{}");
      // A decodable record under a name that is not a run file must stay out of
      // the listing, whichever way the directory is scanned.
      yield* writeJson(
        path.join(home, "projects", piWorkflowProjectKey(cwd), "runs", "run-sidecar.txt"),
        baseRun({ runId: "run-sidecar" }),
      );

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd,
        sessionIds: ["session-a"],
      });
      assert.deepEqual(
        runs.map((run) => run.runId),
        ["run-new", "run-old"],
      );
      assert.deepEqual(unresolvedRunIds, []);
    }),
  );

  it.effect("trims and bounds untrusted fields before they reach a payload", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      yield* writeJson(
        runPath(path, home, cwd, "run-long"),
        baseRun({
          runId: "run-long",
          workflowName: "w".repeat(5_000),
          phases: ["p".repeat(5_000)],
          agents: [{ id: 1, label: "l".repeat(5_000), status: "running" }],
        }),
      );
      // An id that is empty once trimmed cannot be attributed or rendered.
      yield* writeJson(runPath(path, home, cwd, "run-blank"), baseRun({ runId: "  " }));

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd,
        sessionIds: ["session-a"],
      });
      assert.deepEqual(
        runs.map((run) => run.runId),
        ["run-long"],
      );
      assert.isAtMost(runs[0]?.workflowName.length ?? 0, 200);
      assert.isAtMost(runs[0]?.phases[0]?.length ?? 0, 200);
      assert.isAtMost(runs[0]?.agents[0]?.label.length ?? 0, 200);
      assert.deepEqual(unresolvedRunIds, ["run-blank"]);
    }),
  );

  it.effect("caps how many matches it returns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      for (let index = 0; index < 60; index += 1) {
        const runId = `run-${String(index).padStart(3, "0")}`;
        yield* writeJson(runPath(path, home, cwd, runId), baseRun({ runId }));
      }

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd,
        sessionIds: ["session-a"],
      });
      assert.strictEqual(runs.length, 50);
      // Matched but not returned: the caller must be told, not left to read the
      // omission as "the run ended".
      assert.strictEqual(unresolvedRunIds.length, 10);
    }),
  );

  it.effect("keeps the newest runs when the read cap truncates the directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-workflow-" });
      const cwd = path.join(home, "workspace", "t3code");
      // The reader's read cap (private, asserted here): file names start with a
      // workflow-name slug, so the oldest runs deliberately sort first and the
      // newest last. A name-based truncation keeps the wrong end.
      const readCap = 400;
      const freshRuns = 4;
      const base = Date.parse("2026-09-01T00:00:00.000Z");
      const freshIds: Array<string> = [];
      for (let index = 0; index < readCap + freshRuns; index += 1) {
        const fresh = index >= readCap;
        const runId = fresh
          ? `zzz-${String(index).padStart(4, "0")}-freshx`
          : `aaa-${String(index).padStart(4, "0")}-seedxx`;
        if (fresh) freshIds.push(runId);
        const filePath = runPath(path, home, cwd, runId);
        yield* writeJson(filePath, baseRun({ runId }));
        // mtime is the recency signal the reader selects on; the fixture sets it
        // explicitly so the assertion cannot ride on filesystem timestamp
        // granularity.
        const at = DateTime.toDate(DateTime.makeUnsafe(base + index));
        yield* fs.utimes(filePath, at, at);
      }

      const store = yield* makePiWorkflowStore({ homeDir: home });
      const { runs, unresolvedRunIds } = yield* store.listRunsForSession({
        cwd,
        sessionIds: ["session-a"],
      });
      const returned = new Set(runs.map((run) => run.runId));
      for (const runId of freshIds) assert.ok(returned.has(runId));
      assert.ok(!returned.has("aaa-0000-seedxx"));
      // Files past the read cap were listed but not read: unresolved, so a
      // tracked run cannot be mistaken for one that ended. (Matches past the
      // return cap land there too, which is why this asserts containment.)
      assert.includeMembers(
        [...unresolvedRunIds],
        ["aaa-0000-seedxx", "aaa-0001-seedxx", "aaa-0002-seedxx", "aaa-0003-seedxx"],
      );
      for (const runId of unresolvedRunIds) assert.ok(!returned.has(runId));
    }),
  );
});
