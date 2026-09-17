import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import { expect, it as effectIt } from "@effect/vitest";
import {
  ApprovalRequestId,
  DEFAULT_RUNTIME_MODE,
  PiSettings,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, it as plainIt } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { makePiAdapter, buildPiLaunchArgs, splitPiModelSlug } from "./PiAdapter.ts";
import * as PiRpcTransport from "../pi/PiRpcTransport.ts";
import { piWorkflowProjectKey } from "../pi/PiWorkflowStore.ts";

const instanceId = ProviderInstanceId.make("pi-test");
const decodePiSettings = Schema.decodeSync(PiSettings);

const enabledSettings = decodePiSettings({ enabled: true });

/**
 * The adapter needs the platform tags themselves, not the umbrella
 * `NodeServices` tag, so each is merged explicitly. That keeps the layer's
 * success type honest — and therefore lets every test body stay free of casts.
 */
/**
 * `Layer.mergeAll` runs its members in parallel, so it never satisfies a
 * dependency between them. Each platform layer that needs FileSystem/Path gets
 * them through `Layer.provide` before the merge, which is what keeps both the
 * input and the success sides of this layer honest — and therefore keeps every
 * test body free of casts.
 */
const fileSystemAndPath = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const spawnerLayer = NodeChildProcessSpawner.layer.pipe(Layer.provide(fileSystemAndPath));

const platformLayer = Layer.mergeAll(fileSystemAndPath, NodeCrypto.layer, spawnerLayer);

const layer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-pi-adapter-test-",
}).pipe(Layer.provideMerge(platformLayer));

type TestEnv = Layer.Success<typeof layer>;

/** Records the argv the adapter would have launched, so flags stay asserted. */
interface Harness {
  readonly adapter: Awaited<ReturnType<typeof makeAdapterEffect>>;
  readonly launches: Array<ReadonlyArray<string>>;
  readonly events: Queue.Queue<ProviderRuntimeEvent>;
}

/**
 * The rewind boundaries the adapter published, so a test can assert that a
 * resume carries them without reaching into the cursor's shape by hand.
 */
const turnStartEntryIds = (cursor: unknown): ReadonlyArray<unknown> => {
  if (typeof cursor !== "object" || cursor === null) return [];
  const stored = (cursor as { turnStartEntryIds?: unknown }).turnStartEntryIds;
  return Array.isArray(stored) ? stored : [];
};

const makeAdapterEffect = (
  settings: PiSettings = enabledSettings,
  environment: NodeJS.ProcessEnv = process.env,
  workflow: { readonly workflowStoreRoot?: string; readonly workflowSweepIntervalMs?: number } = {},
) =>
  Effect.gen(function* () {
    const executable = yield* HostProcessExecutablePath;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const scriptPath = path.join(import.meta.dirname, "../testFixtures/fakePiAgent.mjs");
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const launches: Array<ReadonlyArray<string>> = [];
    // The fixture persists its session tree here, so a test that resumes a
    // thread from a second adapter sees what the first process left behind.
    const sessionDir = path.join(serverConfig.baseDir, "pi-sessions");
    // Hermetic by default: a test must never read the operator's real
    // `~/.pi/workflows` store, and the fixture root keeps runs isolated.
    const workflowStoreRoot =
      workflow.workflowStoreRoot ?? path.join(serverConfig.baseDir, "workflow-home");
    const adapter = yield* makePiAdapter(settings, {
      instanceId,
      environment,
      sessionDir,
      childProcessSpawner,
      workflowStoreRoot,
      ...(workflow.workflowSweepIntervalMs !== undefined
        ? { workflowSweepIntervalMs: workflow.workflowSweepIntervalMs }
        : {}),
      makeTransport: ({ cwd, args, env }) => {
        launches.push(args);
        return PiRpcTransport.make({
          binaryPath: executable,
          args: [scriptPath, ...args],
          cwd,
          env,
        });
      },
    });
    return { adapter, launches, sessionDir, baseDir: serverConfig.baseDir };
  });

const makeHarness = (
  settings?: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  workflow: { readonly workflowStoreRoot?: string; readonly workflowSweepIntervalMs?: number } = {},
) =>
  Effect.gen(function* () {
    const { adapter, launches, sessionDir, baseDir } = yield* makeAdapterEffect(
      settings,
      environment,
      workflow,
    );
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
      Effect.forkScoped,
    );
    /**
     * Waits for the first event matching `predicate`, re-queueing the events it
     * skipped so a later drain still observes the whole stream in order.
     */
    const waitFor = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
      Effect.gen(function* () {
        const skipped: Array<ProviderRuntimeEvent> = [];
        while (true) {
          const event = yield* Queue.take(events);
          if (predicate(event)) {
            for (const pending of skipped) {
              yield* Queue.offer(events, pending);
            }
            return event;
          }
          skipped.push(event);
        }
      }).pipe(Effect.timeout("10 seconds"));
    /** Non-blocking drain: `Queue.takeAll` waits for one event, this does not. */
    const drain = () => Queue.takeBetween(events, 0, Number.POSITIVE_INFINITY);
    return { adapter, launches, sessionDir, baseDir, events, waitFor, drain };
  });

const startInput = (
  threadId: ThreadId,
  overrides: Partial<ProviderSessionStartInput> = {},
): ProviderSessionStartInput => ({
  threadId,
  providerInstanceId: instanceId,
  cwd: process.cwd(),
  runtimeMode: DEFAULT_RUNTIME_MODE,
  ...overrides,
});

const test = <E>(name: string, body: () => Effect.Effect<void, E, TestEnv | Scope.Scope>) =>
  effectIt.live(name, () => Effect.provide(body(), layer));

/** Pi session id the adapter launched this thread with (from its resume cursor). */
const sessionIdOf = (cursor: unknown): string => {
  if (typeof cursor === "object" && cursor !== null && "sessionId" in cursor) {
    const id = (cursor as { sessionId?: unknown }).sessionId;
    if (typeof id === "string") return id;
  }
  throw new Error("the session did not report a session id");
};

const workflowRunRecord = (
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
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
    },
  ],
  sessionId,
  parentSessionId: sessionId,
  startedAt: "2026-09-17T08:04:33.118Z",
  updatedAt: "2026-09-17T08:05:33.118Z",
  ...overrides,
});

/** Writes a run file where the extension would, for the thread's cwd key. */
const writeWorkflowRunRaw = (storeRoot: string, runId: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runsDir = path.join(storeRoot, "projects", piWorkflowProjectKey(process.cwd()), "runs");
    yield* fs.makeDirectory(runsDir, { recursive: true });
    yield* fs.writeFileString(path.join(runsDir, `${runId}.json`), contents);
  });

const writeWorkflowRun = (storeRoot: string, runId: string, record: Record<string, unknown>) =>
  writeWorkflowRunRaw(storeRoot, runId, JSON.stringify(record));

const makeWorkflowHarness = (
  options: { readonly store?: "valid" | "missing"; readonly intervalMs?: number } = {},
) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const path = yield* Path.Path;
    const workflowStoreRoot = path.join(
      serverConfig.baseDir,
      options.store === "missing" ? "no-such-workflow-home" : "workflow-home",
    );
    const harness = yield* makeHarness(undefined, process.env, {
      workflowStoreRoot,
      workflowSweepIntervalMs: options.intervalMs ?? 20,
    });
    return { ...harness, workflowStoreRoot };
  });

test("starts an RPC session and reports it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-start");
      const session = yield* harness.adapter.startSession(startInput(threadId));

      expect(session.provider).toBe("pi");
      expect(session.status).toBe("ready");
      expect(session.resumeCursor).toEqual({
        schemaVersion: 1,
        sessionId: "01a0ae8e-fake-session-id",
      });
      expect(harness.launches[0]).toEqual(["--mode", "rpc", "--session-dir", harness.sessionDir]);
      expect(yield* harness.adapter.hasSession(threadId)).toBe(true);
    }),
  ));

test("resumes a saved session by passing its id to the CLI", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-resume");
      const session = yield* harness.adapter.startSession(
        startInput(threadId, {
          resumeCursor: { schemaVersion: 1, sessionId: "01a0ae8e-existing" },
        }),
      );

      expect(harness.launches[0]?.slice(harness.launches[0].indexOf("--session-id"))).toEqual([
        "--session-id",
        "01a0ae8e-existing",
      ]);
      expect(session.resumeCursor).toEqual({
        schemaVersion: 1,
        sessionId: "01a0ae8e-existing",
      });
    }),
  ));

test("rejects a resume cursor it cannot read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const exit = yield* harness.adapter
        .startSession(
          startInput(ThreadId.make("pi-thread-bad-cursor"), { resumeCursor: { nope: true } }),
        )
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
    }),
  ));

test("rejects a session when the provider is disabled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(decodePiSettings({ enabled: false }));
      const exit = yield* harness.adapter
        .startSession(startInput(ThreadId.make("pi-thread-disabled")))
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  ));

test("surfaces a workflow run attached to this thread's Pi session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWorkflowHarness();
      const threadId = ThreadId.make("pi-thread-workflow");
      const session = yield* harness.adapter.startSession(startInput(threadId));
      const sessionId = sessionIdOf(session.resumeCursor);
      yield* Queue.takeAll(harness.events);

      yield* writeWorkflowRun(
        harness.workflowStoreRoot,
        "run-alpha",
        workflowRunRecord(sessionId, { runId: "run-alpha" }),
      );

      const started = yield* harness.waitFor((event) => event.type === "task.started");
      expect(started.type).toBe("task.started");
      if (started.type === "task.started") {
        expect(started.payload.taskId).toBe("run-alpha");
        expect(started.payload.taskType).toBe("local_workflow");
        expect(started.payload.workflowName).toBe("Adapter hardening");
        expect(started.payload.runHandles).toEqual({ runId: "run-alpha" });
      }

      const progress = yield* harness.waitFor(
        (event) => event.type === "task.progress" && event.payload.taskId === "run-alpha:wf:1",
      );
      expect(progress.type).toBe("task.progress");
      if (progress.type === "task.progress") {
        expect(progress.payload.status).toBe("running");
        expect(progress.payload.parentAgentId).toBe("run-alpha");
        expect(progress.payload.timelineBypass).toBe(true);
      }

      // A terminal write is one coordinator row and no member churn.
      yield* writeWorkflowRun(
        harness.workflowStoreRoot,
        "run-alpha",
        workflowRunRecord(sessionId, {
          runId: "run-alpha",
          status: "completed",
          currentPhase: "Fix",
          completedAt: "2026-09-17T09:00:00.000Z",
          durationMs: 1000,
          agents: [{ id: 1, label: "recon-store", phase: "Recon", status: "done", tokens: 1234 }],
        }),
      );

      const completed = yield* harness.waitFor(
        (event) => event.type === "task.completed" && event.payload.taskId === "run-alpha",
      );
      expect(completed.type).toBe("task.completed");
      if (completed.type === "task.completed") {
        expect(completed.payload.status).toBe("completed");
      }
    }),
  ));

test("stays silent for a workflow run from another Pi session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWorkflowHarness();
      const threadId = ThreadId.make("pi-thread-workflow-foreign");
      const session = yield* harness.adapter.startSession(startInput(threadId));
      const sessionId = sessionIdOf(session.resumeCursor);
      yield* Queue.takeAll(harness.events);

      // Same directory, two runs: one belongs to this thread's session and one
      // to another. The filter must drop exactly one of them — asserting silence
      // alone would also pass if it dropped both.
      yield* writeWorkflowRun(
        harness.workflowStoreRoot,
        "run-foreign",
        workflowRunRecord("another-pi-session", { runId: "run-foreign" }),
      );
      yield* writeWorkflowRun(
        harness.workflowStoreRoot,
        "run-own",
        workflowRunRecord(sessionId, { runId: "run-own" }),
      );

      yield* harness.waitFor(
        (event) => event.type === "task.started" && event.payload.taskId === "run-own",
      );
      yield* Effect.sleep("100 millis");

      const events = yield* harness.drain();
      const taskIds = events
        .filter((event) => event.type.startsWith("task."))
        .map((event) => (event.payload as { taskId?: string }).taskId);
      expect(taskIds).not.toContain("run-foreign");
      expect(taskIds.every((taskId) => taskId === undefined || taskId.startsWith("run-own"))).toBe(
        true,
      );
      // Silence, not a broken session: the thread still takes a turn.
      yield* harness.adapter.sendTurn({ threadId, input: "hello" });
    }),
  ));

test("survives a malformed workflow store file and a format change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWorkflowHarness();
      const threadId = ThreadId.make("pi-thread-workflow-malformed");
      yield* harness.adapter.startSession(startInput(threadId));
      yield* Queue.takeAll(harness.events);

      yield* writeWorkflowRunRaw(harness.workflowStoreRoot, "run-broken", "{ not json");
      // A future extension version renames the lifecycle field.
      yield* writeWorkflowRun(harness.workflowStoreRoot, "run-renamed", {
        runId: "run-renamed",
        workflowName: "Future",
        lifecycle: "running",
      });
      yield* Effect.sleep("200 millis");

      const events = yield* harness.drain();
      expect(events.filter((event) => event.type.startsWith("task."))).toEqual([]);
      yield* harness.adapter.sendTurn({ threadId, input: "hello" });
    }),
  ));

test("ignores an absent workflow store", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWorkflowHarness({ store: "missing" });
      const threadId = ThreadId.make("pi-thread-workflow-absent");
      yield* harness.adapter.startSession(startInput(threadId));
      yield* harness.drain();
      yield* Effect.sleep("200 millis");

      const events = yield* harness.drain();
      expect(events.filter((event) => event.type.startsWith("task."))).toEqual([]);
      yield* harness.adapter.sendTurn({ threadId, input: "hello" });
    }),
  ));

test("keeps a surfaced workflow when its run file stops decoding, then completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeWorkflowHarness();
      const threadId = ThreadId.make("pi-thread-workflow-corrupt");
      const session = yield* harness.adapter.startSession(startInput(threadId));
      const sessionId = sessionIdOf(session.resumeCursor);
      yield* Queue.takeAll(harness.events);

      yield* writeWorkflowRun(
        harness.workflowStoreRoot,
        "run-corrupt",
        workflowRunRecord(sessionId, { runId: "run-corrupt" }),
      );
      yield* harness.waitFor(
        (event) => event.type === "task.started" && event.payload.taskId === "run-corrupt",
      );

      // A writer-side field rename lands on a run the tracker already holds.
      // The file is still there and the run is still live, so the sweep must
      // neither emit a terminal state nor drop the run.
      yield* writeWorkflowRun(harness.workflowStoreRoot, "run-corrupt", {
        runId: "run-corrupt",
        workflowName: "Renamed",
        lifecycle: "running",
      });
      yield* Effect.sleep("200 millis");
      const during = yield* harness.drain();
      expect(during.filter((event) => event.type.startsWith("task."))).toEqual([]);

      // Readable again: the completion that landed while it was unreadable
      // still reaches the thread.
      yield* writeWorkflowRun(
        harness.workflowStoreRoot,
        "run-corrupt",
        workflowRunRecord(sessionId, {
          runId: "run-corrupt",
          status: "completed",
          completedAt: "2026-09-17T09:00:00.000Z",
          durationMs: 1000,
        }),
      );
      const completed = yield* harness.waitFor(
        (event) => event.type === "task.completed" && event.payload.taskId === "run-corrupt",
      );
      expect(completed.type).toBe("task.completed");
    }),
  ));

test("keeps a surfaced workflow alive when the store cannot be listed at all", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const harness = yield* makeWorkflowHarness();
      const threadId = ThreadId.make("pi-thread-workflow-unlistable");
      const session = yield* harness.adapter.startSession(startInput(threadId));
      const sessionId = sessionIdOf(session.resumeCursor);
      yield* Queue.takeAll(harness.events);

      yield* writeWorkflowRun(
        harness.workflowStoreRoot,
        "run-unlistable",
        workflowRunRecord(sessionId, { runId: "run-unlistable" }),
      );
      yield* harness.waitFor(
        (event) => event.type === "task.started" && event.payload.taskId === "run-unlistable",
      );

      // The run directory becomes unlistable. A failed sweep is not evidence
      // that the run ended, so liveness must survive it.
      const runsDir = path.join(
        harness.workflowStoreRoot,
        "projects",
        piWorkflowProjectKey(process.cwd()),
        "runs",
      );
      yield* fs.remove(runsDir, { recursive: true });
      yield* fs.writeFileString(runsDir, "not a directory");
      yield* Effect.sleep("150 millis");
      const during = yield* harness.drain();
      expect(during.filter((event) => event.type.startsWith("task."))).toEqual([]);

      // And the sweep recovers: the readable terminal record still lands.
      yield* fs.remove(runsDir);
      yield* writeWorkflowRun(
        harness.workflowStoreRoot,
        "run-unlistable",
        workflowRunRecord(sessionId, {
          runId: "run-unlistable",
          status: "completed",
          completedAt: "2026-09-17T09:00:00.000Z",
          durationMs: 1000,
        }),
      );
      const completed = yield* harness.waitFor(
        (event) => event.type === "task.completed" && event.payload.taskId === "run-unlistable",
      );
      expect(completed.type).toBe("task.completed");
    }),
  ));

test("clears a surfaced workflow when the store really drops the run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const harness = yield* makeWorkflowHarness();
      const threadId = ThreadId.make("pi-thread-workflow-pruned");
      const session = yield* harness.adapter.startSession(startInput(threadId));
      const sessionId = sessionIdOf(session.resumeCursor);
      yield* Queue.takeAll(harness.events);

      yield* writeWorkflowRun(
        harness.workflowStoreRoot,
        "run-pruned",
        workflowRunRecord(sessionId, { runId: "run-pruned" }),
      );
      yield* harness.waitFor(
        (event) => event.type === "task.started" && event.payload.taskId === "run-pruned",
      );

      // The run file is gone from the store entirely: the liveness must clear
      // rather than pulse forever. (Removed by the writer's retention, or by
      // `workflow_control`, not merely unreadable — that case stays silent.)
      const runsDir = path.join(
        harness.workflowStoreRoot,
        "projects",
        piWorkflowProjectKey(process.cwd()),
        "runs",
      );
      yield* fs.remove(path.join(runsDir, "run-pruned.json"));

      const interrupted = yield* harness.waitFor(
        (event) =>
          event.type === "task.updated" &&
          event.payload.taskId === "run-pruned" &&
          event.payload.status === "interrupted",
      );
      expect(interrupted.type).toBe("task.updated");
    }),
  ));

test("streams text, reasoning, and tool items for one turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-turn");
      yield* harness.adapter.startSession(startInput(threadId));

      const collected = yield* Effect.gen(function* () {
        yield* harness.adapter.sendTurn({ threadId, input: "hello" });
        return yield* Queue.takeAll(harness.events);
      });

      const byType = (type: string) => collected.filter((event) => event.type === type);
      expect(byType("turn.started")).toHaveLength(1);
      expect(byType("turn.completed")).toHaveLength(1);

      const deltas = byType("content.delta").flatMap((event) =>
        event.type === "content.delta" ? [event.payload] : [],
      );
      expect(deltas.filter((payload) => payload.streamKind === "assistant_text")).toEqual([
        { streamKind: "assistant_text", delta: "Hello ", contentIndex: 1 },
        { streamKind: "assistant_text", delta: "world", contentIndex: 1 },
      ]);
      expect(deltas.filter((payload) => payload.streamKind === "reasoning_text")).toEqual([
        { streamKind: "reasoning_text", delta: "thinking…", contentIndex: 0 },
      ]);
      // Pi resends the accumulated bash output; only the unseen tail may be sent.
      expect(deltas.filter((payload) => payload.streamKind === "command_output")).toEqual([
        { streamKind: "command_output", delta: "total 48\n" },
        { streamKind: "command_output", delta: "file.txt\n" },
      ]);

      const assistantItems = byType("item.completed").filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      expect(assistantItems).toHaveLength(1);

      const toolItems = collected.flatMap((event) =>
        event.type === "item.started" || event.type === "item.completed" ? [event] : [],
      );
      expect(
        toolItems.map((event) => [event.type, event.payload.itemType, event.payload.status]),
      ).toEqual([
        ["item.started", "assistant_message", "inProgress"],
        ["item.started", "command_execution", "inProgress"],
        ["item.completed", "command_execution", "completed"],
        ["item.started", "dynamic_tool_call", "inProgress"],
        ["item.completed", "dynamic_tool_call", "failed"],
        ["item.completed", "assistant_message", "completed"],
      ]);
      expect(
        toolItems.find(
          (event) =>
            event.type === "item.started" && event.payload.itemType === "command_execution",
        )?.payload.title,
      ).toBe("bash: ls -la");

      // A 9 000-character tool result must not reach the socket whole.
      const failedDetail = toolItems.find(
        (event) => event.type === "item.completed" && event.payload.status === "failed",
      );
      expect(
        failedDetail?.type === "item.completed" ? failedDetail.payload.detail?.length : 0,
      ).toBeLessThanOrEqual(4_001);

      // Custom (non-assistant) messages must not open assistant items.
      expect(assistantItems).toHaveLength(1);

      const completed = byType("turn.completed")[0];
      expect(completed?.type === "turn.completed" ? completed.payload.state : undefined).toBe(
        "completed",
      );
      // Pi's `input` excludes cache; T3's canonical input includes it. The
      // last streaming usage seen is the turn's cumulative total.
      expect(
        completed?.type === "turn.completed" ? completed.payload.tokenUsage : undefined,
      ).toEqual({
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens: 103 + 40 + 5,
        outputTokens: 4,
        cachedInputTokens: 40,
        cacheCreationTokens: 5,
        hasSubagents: false,
      });
    }),
  ));

test("reports retry exhaustion as a failed turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-fail");
      yield* harness.adapter.startSession(startInput(threadId));

      const collected = yield* Effect.gen(function* () {
        yield* harness.adapter.sendTurn({ threadId, input: "/fail now" });
        return yield* Queue.takeAll(harness.events);
      });

      const warning = collected.find((event) => event.type === "runtime.warning");
      expect(warning?.type === "runtime.warning" ? warning.payload.message : "").toContain(
        "retrying",
      );
      const completed = collected.find((event) => event.type === "turn.completed");
      expect(completed?.type === "turn.completed" ? completed.payload : undefined).toMatchObject({
        state: "failed",
        errorMessage: "529 overloaded_error",
      });
    }),
  ));

test("maps extension notifies and ignores TUI-only chatter", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-notify");
      yield* harness.adapter.startSession(startInput(threadId));

      const collected = yield* Effect.gen(function* () {
        yield* harness.adapter.sendTurn({ threadId, input: "/notify please" });
        return yield* Queue.takeAll(harness.events);
      });

      const warnings = collected.flatMap((event) =>
        event.type === "runtime.warning" ? [event.payload.message] : [],
      );
      expect(warnings).toEqual(["extension warning"]);
      // `setStatus` and `info` notifies have no T3 surface.
      expect(collected.some((event) => event.type === "runtime.error")).toBe(false);
    }),
  ));

test("answers a blocking extension dialog and lets the turn finish", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-dialog");
      yield* harness.adapter.startSession(startInput(threadId));

      const turnFiber = yield* harness.adapter
        .sendTurn({ threadId, input: "/dialog" })
        .pipe(Effect.forkScoped);

      const request = yield* harness.waitFor((event) => event.type === "user-input.requested");
      expect(request?.type === "user-input.requested" ? request.requestId : undefined).toBe(
        "dialog-1",
      );
      expect(
        request?.type === "user-input.requested" ? request.payload.questions[0] : undefined,
      ).toMatchObject({
        id: "dialog-1",
        header: "Allow dangerous command?",
        question: "Allow dangerous command?",
        allowCustomAnswer: false,
      });
      expect(
        request?.type === "user-input.requested"
          ? request.payload.questions[0]?.options.map((option) => [option.value, option.label])
          : [],
      ).toEqual([
        ["0", "Allow"],
        ["1", "Block"],
      ]);

      // Answering "Allow" unblocks Pi, which echoes the chosen option back.
      yield* harness.adapter.respondToUserInput(threadId, ApprovalRequestId.make("dialog-1"), {
        "dialog-1": "0",
      });
      yield* Fiber.join(turnFiber).pipe(
        Effect.timeout("5 seconds"),
        Effect.tap(() => Effect.logInfo("PROBE join done")),
      );

      const collected = yield* Queue.takeAll(harness.events);
      const resolved = collected.find((event) => event.type === "user-input.resolved");
      expect(
        resolved?.type === "user-input.resolved" ? resolved.payload.answers : undefined,
      ).toEqual({ "dialog-1": "0" });
      const text = collected.flatMap((event) =>
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? [event.payload.delta]
          : [],
      );
      expect(text.join("")).toBe("answer:Allow");
      expect(collected.some((event) => event.type === "turn.completed")).toBe(true);
    }),
  ));

test("refuses to answer a dialog that is no longer pending", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-stale-dialog");
      yield* harness.adapter.startSession(startInput(threadId));

      const exit = yield* harness.adapter
        .respondToUserInput(threadId, ApprovalRequestId.make("nope"), { nope: "0" })
        .pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  ));

test("cancels a running turn on interrupt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-abort");
      yield* harness.adapter.startSession(startInput(threadId));

      const turnFiber = yield* harness.adapter
        .sendTurn({ threadId, input: "/slow work" })
        .pipe(Effect.forkScoped);
      // Interrupt while the turn is genuinely running, without depending on a
      // clock: the fixture holds the turn open until it settles.
      yield* harness.waitFor((event) => event.type === "turn.started");
      yield* harness.adapter.interruptTurn(threadId);
      yield* Fiber.join(turnFiber);

      const collected = yield* Queue.takeAll(harness.events);
      const completed = collected.filter((event) => event.type === "turn.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]?.type === "turn.completed" ? completed[0].payload.state : undefined).toBe(
        "cancelled",
      );
    }),
  ));

test("switches models in-session and rejects unknown ones", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(undefined);
      const threadId = ThreadId.make("pi-thread-model");
      yield* harness.adapter.startSession(startInput(threadId));

      const switched = yield* Effect.gen(function* () {
        yield* harness.adapter.sendTurn({
          threadId,
          input: "/model",
          // A model the fixture does not hold by default, so the echo can only
          // match if the `set_model` RPC actually crossed the wire.
          modelSelection: { instanceId, model: "local-openai/opencode-go/kimi-k2" },
        });
        return yield* Queue.takeAll(harness.events);
      });
      expect(assistantText(switched)).toBe("model=local-openai/opencode-go/kimi-k2");

      // Pi rejects an unknown model, and the turn must fail with Pi's own
      // error rather than the adapter remembering a model Pi never took.
      const rejecting = yield* makeHarness(undefined, {
        ...process.env,
        FAKE_PI_REJECT_MODEL: "bogus-model",
      });
      const rejectThread = ThreadId.make("pi-thread-model-rejected");
      yield* rejecting.adapter.startSession(startInput(rejectThread));
      const error = yield* rejecting.adapter
        .sendTurn({
          threadId: rejectThread,
          input: "hello",
          modelSelection: { instanceId, model: "local-openai/bogus-model" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.message).toContain("unknown model: bogus-model");
    }),
  ));

test("compacts through Pi's native command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-compact");
      yield* harness.adapter.startSession(startInput(threadId));
      expect(harness.adapter.compaction?.type).toBe("native");

      const start = harness.adapter.compaction;
      if (start?.type === "native") {
        yield* start.start(threadId);
      }

      // The completion events trail the command response. Waiting for the
      // state change — emitted last — makes the drain below deterministic.
      const stateChange = yield* harness.waitFor((event) => event.type === "thread.state.changed");
      expect(
        stateChange?.type === "thread.state.changed" ? stateChange.payload : undefined,
      ).toMatchObject({ state: "compacted", beforeTokens: 150000, afterTokens: 32000 });
      const collected = yield* Queue.takeAll(harness.events);
      const compactionItem = collected.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "context_compaction",
      );
      expect(
        compactionItem?.type === "item.completed" ? compactionItem.payload.status : undefined,
      ).toBe("completed");
    }),
  ));

test("reports a settled turn's live context-window usage", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-usage");
      yield* harness.adapter.startSession(startInput(threadId));

      const collected = yield* Effect.gen(function* () {
        yield* harness.adapter.sendTurn({ threadId, input: "hello" });
        // The stats read is off the settlement path, so wait for the meter
        // update instead of assuming it landed before `sendTurn` returned.
        // `waitFor` returns the event it matched without re-queueing it.
        const usageEvent = yield* harness.waitFor(
          (event) => event.type === "thread.token-usage.updated",
        );
        return [...(yield* Queue.takeAll(harness.events)), usageEvent];
      });

      const usage = collected.flatMap((event) =>
        event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
      );
      // `usedTokens`/`maxTokens` are Pi's context estimate; `inputTokens` folds
      // in the session-cumulative cache reads and writes.
      expect(usage).toEqual([
        {
          usedTokens: 61_000,
          totalProcessedTokens: 67_400,
          maxTokens: 131_072,
          inputTokens: 64_000,
          cachedInputTokens: 50_000,
          outputTokens: 3_400,
        },
      ]);
    }),
  ));

test("does not fail a turn when Pi session stats are unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-usage-fail");
      yield* harness.adapter.startSession(startInput(threadId));

      const collected = yield* Effect.gen(function* () {
        yield* harness.adapter.sendTurn({ threadId, input: "/stats-fail" });
        return yield* Queue.takeAll(harness.events);
      });

      const completed = collected.find((event) => event.type === "turn.completed");
      expect(completed?.type === "turn.completed" ? completed.payload.state : undefined).toBe(
        "completed",
      );
      expect(collected.some((event) => event.type === "thread.token-usage.updated")).toBe(false);
    }),
  ));

test("settles a turn without waiting for a slow session-stats read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-usage-slow");
      yield* harness.adapter.startSession(startInput(threadId));

      // The fixture holds `get_session_stats` open until its next command, so a
      // settlement that awaited the read could not return before then.
      const turnFiber = yield* harness.adapter
        .sendTurn({ threadId, input: "/stats-hold hello" })
        .pipe(Effect.forkScoped);
      yield* harness.waitFor((event) => event.type === "turn.completed");
      // Asserted after the terminal event, not on the fiber's shape: the
      // command must not still be parked on the held stats read.
      yield* Fiber.join(turnFiber).pipe(Effect.timeout("2 seconds"));

      // The held read is genuinely outstanding, yet the turn already settled
      // and the command already returned.
      expect(
        (yield* Queue.takeAll(harness.events)).some(
          (event) => event.type === "thread.token-usage.updated",
        ),
      ).toBe(false);

      // The next command releases the held answer, so the meter update still
      // lands — off the settlement path, as it must.
      yield* harness.adapter.sendTurn({ threadId, input: "second" });
      const usage = yield* harness.waitFor((event) => event.type === "thread.token-usage.updated");
      expect(
        usage.type === "thread.token-usage.updated" ? usage.payload.usage.usedTokens : undefined,
      ).toBe(61_000);
    }),
  ));

test("skips the meter update Pi invalidated right after compaction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-usage-compacted");
      yield* harness.adapter.startSession(startInput(threadId));
      yield* harness.adapter.sendTurn({ threadId, input: "hello" });
      // Wait for the turn's meter update before compacting: the stats read is
      // now off the settlement path, so a plain drain could leave it in flight
      // and leak a stale estimate into the assertions below.
      yield* harness.waitFor((event) => event.type === "thread.token-usage.updated");
      yield* Queue.takeAll(harness.events);

      const compaction = harness.adapter.compaction;
      if (compaction?.type === "native") {
        yield* compaction.start(threadId);
      }

      // The follow-up turn cannot settle until the event fiber has drained the
      // compaction, so its usage event proves the compaction's stats were
      // already consumed. A bogus post-compaction value would appear first.
      yield* harness.adapter.sendTurn({ threadId, input: "after compaction" });
      const usageEvent = yield* harness.waitFor(
        (event) => event.type === "thread.token-usage.updated",
      );
      const usage = [usageEvent, ...(yield* Queue.takeAll(harness.events))].flatMap((event) =>
        event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
      );
      expect(usage).toEqual([
        {
          usedTokens: 61_000,
          totalProcessedTokens: 67_400,
          maxTokens: 131_072,
          inputTokens: 64_000,
          cachedInputTokens: 50_000,
          outputTokens: 3_400,
        },
      ]);
    }),
  ));

test("settles a turn without waiting for a slow session-tree read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-entries-slow");
      yield* harness.adapter.startSession(startInput(threadId));
      // Warm up so the next turn's start position is already known: the
      // pre-prompt anchor read must not be the one the fixture holds.
      yield* harness.adapter.sendTurn({ threadId, input: "hello" });
      yield* Queue.takeAll(harness.events);

      // The fixture holds `get_entries` open until its next command, so a
      // settlement that awaited the boundary read could not return before then.
      const turnFiber = yield* harness.adapter
        .sendTurn({ threadId, input: "/entries-hold two" })
        .pipe(Effect.forkScoped);
      yield* harness.waitFor((event) => event.type === "turn.completed");
      // Asserted after the terminal event, not on the fiber's shape: the
      // command must not be parked on the held tree read.
      const turn = yield* Fiber.join(turnFiber).pipe(Effect.timeout("3 seconds"));

      // The held read is outstanding, so the returned cursor reports that
      // turn's boundary as missing rather than naming one it never verified.
      expect(turnStartEntryIds(turn.resumeCursor)).toEqual([expect.any(String), null]);

      // The prompt lock was released before the held read: a rewind fails fast
      // with the clear "never recorded" message instead of blocking behind it.
      const error = yield* harness.adapter
        .rollbackThread(threadId, 1)
        .pipe(Effect.flip, Effect.timeout("3 seconds"));
      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.message).toContain("was never recorded");
    }),
  ));

test("never inherits a boundary from before a turn whose tree read timed out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-stale-anchor");
      yield* harness.adapter.startSession(startInput(threadId));
      // Turn 1 resolves its position normally.
      yield* harness.adapter.sendTurn({ threadId, input: "one" });
      yield* Queue.takeAll(harness.events);

      // Turn 2's tree read is held past the budget, so its own boundary is
      // unknown and the cursor says exactly that.
      const held = yield* harness.adapter.sendTurn({ threadId, input: "/entries-hold two" });
      expect(turnStartEntryIds(held.resumeCursor)).toEqual([expect.any(String), null]);
      yield* Queue.takeAll(harness.events);

      // Turn 3 has to resolve from ITS OWN position. Inheriting the anchor from
      // before turn 2 would make it name turn 2's message as its own boundary,
      // and the rewind below would then remove two turns instead of one.
      yield* harness.adapter.sendTurn({ threadId, input: "three" });
      yield* Queue.takeAll(harness.events);
      yield* harness.adapter.rollbackThread(threadId, 1);

      // Two of the three turns survive, and the live Pi session agrees.
      yield* harness.adapter.sendTurn({ threadId, input: "/state" });
      expect(assistantText(yield* Queue.takeAll(harness.events))).toBe(
        "session=fake-fork-1 users=2",
      );
    }),
  ));

test("stops a session and rejects later turns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-stop");
      yield* harness.adapter.startSession(startInput(threadId));
      yield* harness.adapter.stopSession(threadId);

      expect(yield* harness.adapter.hasSession(threadId)).toBe(false);
      const exit = yield* harness.adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      const collected = yield* Queue.takeAll(harness.events);
      expect(collected.some((event) => event.type === "session.exited")).toBe(true);
    }),
  ));

test("requires a message on every turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-empty");
      yield* harness.adapter.startSession(startInput(threadId));
      const exit = yield* harness.adapter.sendTurn({ threadId, input: "   " }).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  ));

/**
 * Collects the assistant text a turn streamed, which is how a test observes
 * what the live Pi session contained when the prompt was sent.
 */
const assistantText = (events: ReadonlyArray<ProviderRuntimeEvent>): string =>
  events
    .flatMap((event) =>
      event.type === "content.delta" && event.payload.streamKind === "assistant_text"
        ? [event.payload.delta]
        : [],
    )
    .join("");

test("sends image attachments as Pi's native image content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-image");
      yield* harness.adapter.startSession(startInput(threadId));
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      yield* fileSystem.writeFile(
        path.join(serverConfig.attachmentsDir, "pi-image-1.png"),
        imageBytes,
      );

      const collected = yield* Effect.gen(function* () {
        yield* harness.adapter.sendTurn({
          threadId,
          input: "look at this",
          attachments: [
            {
              type: "image",
              id: "pi-image-1",
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: imageBytes.length,
            },
          ],
        });
        return yield* Queue.takeAll(harness.events);
      });

      // The fixture echoes the images it received, so the summary proves the
      // base64 payload crossed the RPC wire rather than only the path text.
      expect(assistantText(collected)).toBe("images=1 image/png");
      expect(collected.some((event) => event.type === "runtime.warning")).toBe(false);
    }),
  ));

test("keeps non-image attachments on the text path only", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-file-attachment");
      yield* harness.adapter.startSession(startInput(threadId));

      const collected = yield* Effect.gen(function* () {
        yield* harness.adapter.sendTurn({
          threadId,
          input: "read the report",
          attachments: [
            {
              type: "file",
              id: "pi-file-1",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 4,
            },
          ],
        });
        return yield* Queue.takeAll(harness.events);
      });

      // No native image was sent, so the fixture runs its default script and
      // never reports an image count. The file itself stays path-only.
      expect(assistantText(collected)).toBe("Hello world");
      expect(collected.some((event) => event.type === "runtime.warning")).toBe(false);
    }),
  ));

test("skips an oversized image and keeps the turn on the text path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-image-oversized");
      yield* harness.adapter.startSession(startInput(threadId));
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.writeFile(
        path.join(serverConfig.attachmentsDir, "pi-image-large.png"),
        new Uint8Array(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1),
      );

      const collected = yield* Effect.gen(function* () {
        yield* harness.adapter.sendTurn({
          threadId,
          input: "look at this",
          attachments: [
            {
              type: "image",
              id: "pi-image-large",
              name: "large.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        });
        return yield* Queue.takeAll(harness.events);
      });

      const warning = collected.find((event) => event.type === "runtime.warning");
      expect(warning?.type === "runtime.warning" ? warning.payload.message : "").toContain(
        "large.png",
      );
      // The image was dropped rather than failing the turn, so the fixture's
      // default script runs and the turn still completes.
      expect(assistantText(collected)).toBe("Hello world");
      const completed = collected.find((event) => event.type === "turn.completed");
      expect(completed?.type === "turn.completed" ? completed.payload.state : undefined).toBe(
        "completed",
      );
    }),
  ));

test("rewinds a conversation and continues from the rewound session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-rollback");
      yield* harness.adapter.startSession(startInput(threadId));
      yield* harness.adapter.sendTurn({ threadId, input: "one" });
      yield* harness.adapter.sendTurn({ threadId, input: "two" });

      const snapshot = yield* harness.adapter.rollbackThread(threadId, 1);
      expect(snapshot.turns).toHaveLength(1);
      // The reported snapshot and what the adapter reads back must agree.
      const read = yield* harness.adapter.readThread(threadId);
      expect(read.turns.map((turn) => turn.id)).toEqual(snapshot.turns.map((turn) => turn.id));

      // Pi rewinds by rebuilding the session, so the thread has to resume from
      // the branch Pi left behind rather than the discarded one. The retained
      // turn keeps its boundary, which is what a later resume rewinds from.
      const sessions = yield* harness.adapter.listSessions();
      expect(sessions[0]?.resumeCursor).toEqual({
        schemaVersion: 1,
        sessionId: "fake-fork-1",
        turnStartEntryIds: [expect.any(String)],
      });
      const started = (yield* Queue.takeAll(harness.events)).filter(
        (event) => event.type === "thread.started",
      );
      expect(
        started.at(-1)?.type === "thread.started"
          ? started.at(-1)?.payload.providerThreadId
          : undefined,
      ).toBe("fake-fork-1");

      // The fixture answers with the session id and the user messages it holds,
      // so the next turn proves the live conversation really was rewound.
      yield* harness.adapter.sendTurn({ threadId, input: "/state" });
      expect(assistantText(yield* Queue.takeAll(harness.events))).toBe(
        "session=fake-fork-1 users=1",
      );
    }),
  ));

test("rewinds every observed turn to an empty Pi session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-rollback-all");
      yield* harness.adapter.startSession(startInput(threadId));
      yield* harness.adapter.sendTurn({ threadId, input: "one" });
      yield* harness.adapter.sendTurn({ threadId, input: "two" });
      yield* Queue.takeAll(harness.events);

      expect((yield* harness.adapter.rollbackThread(threadId, 2)).turns).toEqual([]);
      yield* harness.adapter.sendTurn({ threadId, input: "/state" });
      expect(assistantText(yield* Queue.takeAll(harness.events))).toBe(
        "session=fake-fork-1 users=0",
      );
    }),
  ));

test("refuses to rewind past the turns this session observed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-rollback-unknown");
      yield* harness.adapter.startSession(startInput(threadId));
      yield* harness.adapter.sendTurn({ threadId, input: "one" });

      const error = yield* harness.adapter.rollbackThread(threadId, 2).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.message).toContain("has observed 1 turn");
      // Nothing may move: the provider still holds the whole conversation.
      expect((yield* harness.adapter.readThread(threadId)).turns).toHaveLength(1);
      const sessions = yield* harness.adapter.listSessions();
      expect(sessions[0]?.resumeCursor).toEqual({
        schemaVersion: 1,
        sessionId: "01a0ae8e-fake-session-id",
        turnStartEntryIds: [expect.any(String)],
      });
    }),
  ));

test("leaves the conversation untouched when Pi cancels the fork", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-rollback-cancelled");
      yield* harness.adapter.startSession(startInput(threadId));
      yield* harness.adapter.sendTurn({ threadId, input: "one" });
      yield* harness.adapter.sendTurn({ threadId, input: "/fork-cancel two" });
      yield* Queue.takeAll(harness.events);

      const error = yield* harness.adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.message).toContain("cancelled");
      expect((yield* harness.adapter.readThread(threadId)).turns).toHaveLength(2);
      const sessions = yield* harness.adapter.listSessions();
      expect(sessions[0]?.resumeCursor).toEqual({
        schemaVersion: 1,
        sessionId: "01a0ae8e-fake-session-id",
        turnStartEntryIds: [expect.any(String), expect.any(String)],
      });

      yield* harness.adapter.sendTurn({ threadId, input: "/state" });
      expect(assistantText(yield* Queue.takeAll(harness.events))).toBe(
        "session=01a0ae8e-fake-session-id users=2",
      );
    }),
  ));

test("reports a fork that did not preserve the rewind boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-rollback-wrong");
      yield* harness.adapter.startSession(startInput(threadId));
      yield* harness.adapter.sendTurn({ threadId, input: "one" });
      yield* harness.adapter.sendTurn({ threadId, input: "two" });
      yield* harness.adapter.sendTurn({ threadId, input: "/fork-wrong three" });

      const error = yield* harness.adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.message).toContain("did not preserve the requested rewind boundary");
      // The session was replaced by the time the mismatch was seen, so resumes
      // must follow the live branch instead of reopening the old one.
      const sessions = yield* harness.adapter.listSessions();
      expect(sessions[0]?.resumeCursor).toEqual({
        schemaVersion: 1,
        sessionId: "fake-fork-1",
        // The stale boundaries stay put on purpose: the ones the wrong fork
        // dropped are no longer on the branch, so a later rewind that needs one
        // fails instead of quietly forking somewhere else.
        turnStartEntryIds: [expect.any(String), expect.any(String), expect.any(String)],
      });
    }),
  ));

test("rewinds a thread that a second adapter resumed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-thread-rollback-resume");

      // One process runs two turns and is then thrown away, as a restart would
      // leave it: the resume cursor is all that survives the process.
      const first = yield* makeHarness();
      yield* first.adapter.startSession(startInput(threadId));
      yield* first.adapter.sendTurn({ threadId, input: "one" });
      const lastTurn = yield* first.adapter.sendTurn({ threadId, input: "two" });
      expect(turnStartEntryIds(lastTurn.resumeCursor)).toHaveLength(2);
      yield* first.adapter.stopAll();

      // A fresh adapter resumes the same thread from the cursor, so it has no
      // turns of its own to rewind by.
      const second = yield* makeHarness();
      const resumed = yield* second.adapter.startSession(
        startInput(threadId, { resumeCursor: lastTurn.resumeCursor }),
      );
      expect(resumed.resumeCursor).toEqual(lastTurn.resumeCursor);
      // The resumed adapter never observed these turns, but the live session
      // still holds them, so the snapshot has to count them — with no items to
      // report. A dropped restored turn is what made the old ``turns: []``
      // disagree with the session a rewind could still address.
      const beforeRewind = yield* second.adapter.readThread(threadId);
      expect(beforeRewind.turns).toHaveLength(2);
      expect(beforeRewind.turns.map((turn) => turn.items)).toEqual([[], []]);

      // The boundary comes from the cursor, so the rewind is still exact, and
      // the retained turn remains visible in the snapshot afterwards.
      const rewound = yield* second.adapter.rollbackThread(threadId, 1);
      expect(rewound.turns).toHaveLength(1);
      expect(rewound.turns[0]?.items).toEqual([]);
      expect(rewound.turns.map((turn) => turn.id)).toEqual(
        beforeRewind.turns.slice(0, 1).map((turn) => turn.id),
      );
      const sessions = yield* second.adapter.listSessions();
      expect(sessions[0]?.resumeCursor).toEqual({
        schemaVersion: 1,
        sessionId: "fake-fork-1",
        turnStartEntryIds: [expect.any(String)],
      });

      // And the live Pi session is the branch from before the removed turn.
      yield* second.adapter.sendTurn({ threadId, input: "/state" });
      expect(assistantText(yield* Queue.takeAll(second.events))).toBe(
        "session=fake-fork-1 users=1",
      );
    }),
  ));

test("drops restore boundaries when Pi resumes a different session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-thread-resume-mismatch");

      const first = yield* makeHarness();
      yield* first.adapter.startSession(startInput(threadId));
      yield* first.adapter.sendTurn({ threadId, input: "one" });
      const lastTurn = yield* first.adapter.sendTurn({ threadId, input: "two" });
      expect(turnStartEntryIds(lastTurn.resumeCursor)).toHaveLength(2);
      yield* first.adapter.stopAll();

      // Pi no longer has the saved session, so it starts a fresh one with a
      // new id and an empty tree. The cursor's entry ids belong to the old
      // session, and entry ids are only unique within a session.
      const second = yield* makeHarness(undefined, {
        ...process.env,
        FAKE_PI_REASSIGN_SESSION_ID: "fake-new-session-id",
      });
      const resumed = yield* second.adapter.startSession(
        startInput(threadId, { resumeCursor: lastTurn.resumeCursor }),
      );
      // The stale boundaries are gone, not attached to a session they were
      // never read from.
      expect(resumed.resumeCursor).toEqual({
        schemaVersion: 1,
        sessionId: "fake-new-session-id",
      });
      expect((yield* second.adapter.readThread(threadId)).turns).toEqual([]);

      // A rewind cannot silently fork before an entry id that now means
      // something else; it fails with a clear message instead.
      const error = yield* second.adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.message).toContain("has observed 0 turn");
    }),
  ));

test("treats a steered turn as one rewind boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-rollback-steer");
      yield* harness.adapter.startSession(startInput(threadId));

      // The fixture holds the turn open, so the next prompt genuinely lands
      // mid-turn and is steered into it instead of opening a new one.
      const turnFiber = yield* harness.adapter
        .sendTurn({ threadId, input: "/slow work" })
        .pipe(Effect.forkScoped);
      yield* harness.waitFor((event) => event.type === "turn.started");
      const steerFiber = yield* harness.adapter
        .sendTurn({ threadId, input: "steer" })
        .pipe(Effect.forkScoped);
      yield* Fiber.join(turnFiber);
      yield* Fiber.join(steerFiber);
      yield* Queue.takeAll(harness.events);

      // Pi appended a second user message for the steer, but both belong to one
      // turn, so a one-turn rewind has to drop both of them.
      const sessions = yield* harness.adapter.listSessions();
      expect(turnStartEntryIds(sessions[0]?.resumeCursor)).toHaveLength(1);
      expect((yield* harness.adapter.rollbackThread(threadId, 1)).turns).toEqual([]);
      yield* harness.adapter.sendTurn({ threadId, input: "/state" });
      expect(assistantText(yield* Queue.takeAll(harness.events))).toBe(
        "session=fake-fork-1 users=0",
      );
    }),
  ));

test("refuses a rewind whose turn boundary was never recorded", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-rollback-no-boundary");
      yield* harness.adapter.startSession(startInput(threadId));
      // The session-tree read that would name this turn's boundary fails. That
      // must not fail the turn, and must never name a different entry instead.
      const firstTurn = yield* harness.adapter.sendTurn({
        threadId,
        input: "/entries-fail one",
      });
      expect(turnStartEntryIds(firstTurn.resumeCursor)).toEqual([null]);
      yield* harness.adapter.sendTurn({ threadId, input: "two" });

      const error = yield* harness.adapter.rollbackThread(threadId, 2).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.message).toContain("was never recorded");
      // Nothing may move: the provider still holds both turns.
      expect((yield* harness.adapter.readThread(threadId)).turns).toHaveLength(2);
      const sessions = yield* harness.adapter.listSessions();
      expect(turnStartEntryIds(sessions[0]?.resumeCursor)).toEqual([null, expect.any(String)]);

      // The gap is local to that one turn: the next turn's boundary is known,
      // so rewinding only it still lands exactly where it should.
      expect((yield* harness.adapter.rollbackThread(threadId, 1)).turns).toHaveLength(1);
      yield* Queue.takeAll(harness.events);
      yield* harness.adapter.sendTurn({ threadId, input: "/state" });
      expect(assistantText(yield* Queue.takeAll(harness.events))).toBe(
        "session=fake-fork-1 users=1",
      );
    }),
  ));

test("refuses to rewind while a turn is running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadId = ThreadId.make("pi-thread-rollback-busy");
      yield* harness.adapter.startSession(startInput(threadId));

      const turnFiber = yield* harness.adapter
        .sendTurn({ threadId, input: "/dialog" })
        .pipe(Effect.forkScoped);
      // Pi blocks on the dialog, which holds the turn open without a clock.
      yield* harness.waitFor((event) => event.type === "user-input.requested");

      const error = yield* harness.adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      expect(error._tag).toBe("ProviderAdapterValidationError");
      expect(error.message).toContain("while a turn is running");

      yield* harness.adapter.respondToUserInput(threadId, ApprovalRequestId.make("dialog-1"), {
        "dialog-1": "0",
      });
      yield* Fiber.join(turnFiber);
    }),
  ));

describe("buildPiLaunchArgs", () => {
  plainIt("splits the model slug so nested ids survive", () => {
    expect(splitPiModelSlug("local-openai/opencode-go/kimi-k3")).toEqual({
      provider: "local-openai",
      model: "opencode-go/kimi-k3",
    });
    expect(
      buildPiLaunchArgs({
        settings: enabledSettings,
        sessionDir: "/sessions",
        modelSlug: "local-openai/opencode-go/kimi-k3",
        thinkingLevel: "high",
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      "/sessions",
      "--provider",
      "local-openai",
      "--model",
      "opencode-go/kimi-k3",
      "--thinking",
      "high",
    ]);
  });
});
