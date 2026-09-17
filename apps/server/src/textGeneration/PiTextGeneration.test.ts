import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { expect, it as effectIt } from "@effect/vitest";
import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { makePiTextGeneration } from "./PiTextGeneration.ts";
import type { CommitMessageGenerationInput } from "./TextGeneration.ts";
import * as PiRpcTransport from "../provider/pi/PiRpcTransport.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const settings = decodePiSettings({ enabled: true });

const piModel = (model: string) => createModelSelection(ProviderInstanceId.make("pi"), model);

/**
 * `Layer.mergeAll` runs its members in parallel and never satisfies a
 * dependency between them, so the spawner gets FileSystem/Path through
 * `Layer.provide`. That keeps the success side of the layer honest, which is
 * what lets the test bodies stay free of casts.
 */
const fileSystemAndPath = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const spawnerLayer = NodeChildProcessSpawner.layer.pipe(Layer.provide(fileSystemAndPath));
const layer = Layer.mergeAll(fileSystemAndPath, spawnerLayer);
type TestEnv = Layer.Success<typeof layer>;

/**
 * `it.layer` would force the TestClock; `runPiJson` arms a real 180s timeout
 * and races it against process exit, so these tests run on the live clock.
 */
const test = <E>(name: string, body: () => Effect.Effect<void, E, TestEnv | Scope.Scope>) =>
  effectIt.live(name, () => Effect.provide(body(), layer));

/** A canned single-turn reply, exactly as Pi frames one over RPC. */
const replyEvents = (text: string): ReadonlyArray<PiRpcTransport.PiRpcEvent> => [
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } },
  { type: "agent_settled" },
];

interface Harness {
  readonly textGeneration: Effect.Success<ReturnType<typeof makePiTextGeneration>>;
  readonly launches: Array<ReadonlyArray<string>>;
  readonly requests: Array<PiRpcTransport.PiRpcCommand>;
}

/**
 * Replaces the spawned `pi` process with an in-process transport that replays
 * `script` for every `prompt`. The seam still receives the computed argv, so
 * the launch flags are asserted rather than bypassed.
 */
const makeHarness = (
  script: ReadonlyArray<PiRpcTransport.PiRpcEvent>,
): Effect.Effect<Harness, never, TestEnv> =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<PiRpcTransport.PiRpcEvent>();
    const exited = yield* Deferred.make<number, PiRpcTransport.PiRpcError>();
    const requests: Array<PiRpcTransport.PiRpcCommand> = [];
    const launches: Array<ReadonlyArray<string>> = [];
    const transport: PiRpcTransport.PiRpcTransportShape = {
      pid: 4242,
      request: (command) =>
        Effect.gen(function* () {
          requests.push(command);
          yield* Effect.forEach(script, (event) => Queue.offer(events, event), { discard: true });
          return undefined;
        }),
      notify: () => Effect.void,
      events: Stream.fromQueue(events),
      // Real Pi stays alive until its scope closes, so the turn is resolved by
      // `agent_settled`, never by process exit.
      exited: Deferred.await(exited),
      isRunning: Effect.succeed(true),
      kill: Effect.void,
    };
    const textGeneration = yield* makePiTextGeneration(settings, process.env, {
      makeTransport: ({ args }) => {
        launches.push(args);
        return Effect.succeed(transport);
      },
    });
    return { textGeneration, launches, requests };
  });

const commitMessageInput = (): CommitMessageGenerationInput => ({
  cwd: process.cwd(),
  branch: "feat/pi-text",
  stagedSummary: "M apps/server/src/textGeneration/PiTextGeneration.ts",
  stagedPatch: "diff --git a/.../PiTextGeneration.ts b/.../PiTextGeneration.ts",
  modelSelection: piModel("anthropic/claude-sonnet-4-5"),
});

test("launches pi rpc with --no-session/--no-tools, the model flags, and the built prompt", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      replyEvents('{"subject":"Add Pi text generation","body":"Wire it up"}'),
    );

    const generated = yield* harness.textGeneration.generateCommitMessage(commitMessageInput());

    expect(generated.subject).toBe("Add Pi text generation");
    expect(generated.body).toBe("Wire it up");
    expect(harness.launches).toHaveLength(1);
    expect(harness.launches[0]).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-tools",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet-4-5",
    ]);
    expect(harness.requests[0]?.type).toBe("prompt");
    expect(harness.requests[0]?.message).toContain(
      "M apps/server/src/textGeneration/PiTextGeneration.ts",
    );
  }));

test("passes a slashless model id as a single --model flag", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      replyEvents('{"subject":"Add Pi text generation","body":""}'),
    );

    yield* harness.textGeneration.generateCommitMessage({
      ...commitMessageInput(),
      modelSelection: piModel("gpt-5.4-mini"),
    });

    expect(harness.launches[0]).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-tools",
      "--model",
      "gpt-5.4-mini",
    ]);
  }));

test("sanitizes a commit subject, body, and branch from the JSON reply", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      replyEvents(
        '{"subject":"add pi text generation.\\nextra line","body":"  Line one.  ","branch":"Feature/Pi Text Gen!!"}',
      ),
    );

    const generated = yield* harness.textGeneration.generateCommitMessage({
      ...commitMessageInput(),
      includeBranch: true,
    });

    expect(generated.subject).toBe("add pi text generation");
    expect(generated.body).toBe("Line one.");
    expect(generated.branch).toBe("feature/pi-text-gen");
  }));

test("fails with TextGenerationError when the reply is empty", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness([{ type: "agent_settled" }]);

    const error = yield* Effect.flip(
      harness.textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "anything",
        modelSelection: piModel("anthropic/claude-sonnet-4-5"),
      }),
    );

    expect(error._tag).toBe("TextGenerationError");
    expect(error.detail).toMatch(/empty/i);
  }));

test("fails with TextGenerationError when the reply is not JSON", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(replyEvents("totally not json from a confused model"));

    const error = yield* Effect.flip(
      harness.textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "anything",
        modelSelection: piModel("anthropic/claude-sonnet-4-5"),
      }),
    );

    expect(error._tag).toBe("TextGenerationError");
    expect(error.detail).toMatch(/invalid structured output/i);
  }));

test("fails with TextGenerationError when required fields are missing", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(replyEvents('{"subject":"Only a subject"}'));

    const error = yield* Effect.flip(
      harness.textGeneration.generateCommitMessage(commitMessageInput()),
    );

    expect(error._tag).toBe("TextGenerationError");
    expect(error.detail).toMatch(/invalid structured output/i);
  }));

test("decodes and sanitizes PR content", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      replyEvents(
        '{"title":"feat(pi): text generation\\nsecond line","body":"\\n## Summary\\n- one\\n"}',
      ),
    );

    const generated = yield* harness.textGeneration.generatePrContent({
      cwd: process.cwd(),
      baseBranch: "main",
      headBranch: "feat/pi-text",
      commitSummary: "feat: pi text generation",
      diffSummary: "M apps/server/src/textGeneration/PiTextGeneration.ts",
      diffPatch: "diff --git a/.../PiTextGeneration.ts b/.../PiTextGeneration.ts",
      modelSelection: piModel("anthropic/claude-sonnet-4-5"),
    });

    expect(generated.title).toBe("feat(pi): text generation");
    expect(generated.body).toBe("## Summary\n- one");
  }));

test("extracts a JSON title wrapped in conversational text and sanitizes it", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      replyEvents(
        `Here is the title:\n{"title":"  'Fix   flaky tests'  ","needsRefinement":true}\nAnything else?`,
      ),
    );

    const generated = yield* harness.textGeneration.generateThreadTitle({
      cwd: process.cwd(),
      message: "the lint job is red",
      modelSelection: piModel("anthropic/claude-sonnet-4-5"),
    });

    expect(generated.title).toBe("Fix flaky tests");
    expect(generated.needsRefinement).toBe(true);
  }));

test("sanitizes a generated branch name", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(replyEvents('{"branch":"feature/Pi Text Gen!!"}'));

    const generated = yield* harness.textGeneration.generateBranchName({
      cwd: process.cwd(),
      message: "wire up pi text generation",
      modelSelection: piModel("anthropic/claude-sonnet-4-5"),
    });

    expect(generated.branch).toBe("feature/pi-text-gen");
  }));
