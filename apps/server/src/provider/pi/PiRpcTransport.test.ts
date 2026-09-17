import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "@effect/platform-node/NodePath";
import { it as effectIt } from "@effect/vitest";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  PiRpcCommandError,
  PiRpcExitedError,
  PiRpcTimeoutError,
  make,
  splitPiJsonLines,
} from "./PiRpcTransport.ts";

const withNodeLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodePath.layer)));

/** Spawns the fake Pi through the real `node` binary, so no fixture wrapper is needed. */
const startTransport = () =>
  Effect.gen(function* () {
    const executable = yield* HostProcessExecutablePath;
    const path = yield* Path.Path;
    return yield* make({
      binaryPath: executable,
      args: [path.join(import.meta.dirname, "../testFixtures/fakePiRpc.mjs")],
    });
  });

/**
 * Runs `effect` and returns the failure it produced. `Effect.flip` is avoided
 * on purpose: it moves the `unknown` response payload into the error channel,
 * which says nothing about the failure being asserted.
 */
const captureFailure = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    if (!Exit.isFailure(exit)) {
      throw new Error("expected the effect to fail, but it succeeded");
    }
    return Option.getOrThrowWith(
      Cause.findErrorOption(exit.cause),
      () => new Error("expected a typed failure, but the effect was interrupted or died"),
    );
  });

interface EventSource {
  readonly events: Stream.Stream<{ readonly type: string }>;
}

const collectEvents = (transport: EventSource, count: number) =>
  transport.events.pipe(Stream.take(count), Stream.runCollect);

const splitChunks = (chunks: ReadonlyArray<string>) =>
  Stream.fromIterable(chunks).pipe(splitPiJsonLines, Stream.runCollect);

describe("splitPiJsonLines", () => {
  effectIt.effect("treats unicode separators as data and only splits on LF", () =>
    Effect.gen(function* () {
      expect(yield* splitChunks(["a\u2028", "b\u2029", 'c"\n{"type":"x"}\n'])).toEqual([
        'a\u2028b\u2029c"',
        '{"type":"x"}',
      ]);
    }),
  );

  effectIt.effect("reassembles records split across chunks and strips CRLF", () =>
    Effect.gen(function* () {
      expect(yield* splitChunks(['{"ty', 'pe":"a"}\r\n{"type"', ':"b"}'])).toEqual([
        '{"type":"a"}',
        '{"type":"b"}',
      ]);
    }),
  );

  effectIt.effect("flushes a trailing record that arrives without a newline", () =>
    Effect.gen(function* () {
      expect(yield* splitChunks(['{"type":"a"}\n', '{"type":"b"}'])).toEqual([
        '{"type":"a"}',
        '{"type":"b"}',
      ]);
    }),
  );

  effectIt.effect("drops empty records and whitespace-only framing", () =>
    Effect.gen(function* () {
      expect(yield* splitChunks(['\n{"type":"a"}\n\n\n'])).toEqual(['{"type":"a"}']);
    }),
  );
});

describe("PiRpcTransport", () => {
  effectIt.live(
    "correlates responses out of order",
    () =>
      Effect.gen(function* () {
        const transport = yield* startTransport();
        const [first, second] = yield* Effect.all(
          [
            transport.request({ type: "delay", value: "slow", ms: 60 }),
            transport.request({ type: "delay", value: "fast", ms: 0 }),
          ],
          { concurrency: "unbounded" },
        );

        expect(second).toEqual({ pong: "fast" });
        expect(first).toEqual({ pong: "slow" });
      }).pipe(withNodeLayer),
    10_000,
  );

  effectIt.live(
    "streams non-response records while a command is in flight",
    () =>
      Effect.gen(function* () {
        const transport = yield* startTransport();
        const collector = yield* Effect.forkScoped(collectEvents(transport, 2));

        const data = yield* transport.request({ type: "emit", count: 2 });
        const events = yield* Fiber.join(collector);

        expect(data).toEqual({ emitted: 2 });
        expect(events).toEqual([
          { type: "test_event", index: 0 },
          { type: "test_event", index: 1 },
        ]);
      }).pipe(withNodeLayer),
    10_000,
  );

  effectIt.live(
    "keeps unicode separators intact inside a JSON record",
    () =>
      Effect.gen(function* () {
        const transport = yield* startTransport();
        const collector = yield* Effect.forkScoped(collectEvents(transport, 1));

        const data = yield* transport.request({ type: "u2028" });
        const events = yield* Fiber.join(collector);

        expect(data).toEqual({ length: 5 });
        expect(events).toEqual([{ type: "test_event", text: "a\u2028b\u2029c", line: "1\u20282" }]);
      }).pipe(withNodeLayer),
    10_000,
  );

  effectIt.live(
    "survives a non-JSON line without losing later records",
    () =>
      Effect.gen(function* () {
        const transport = yield* startTransport();
        const collector = yield* Effect.forkScoped(collectEvents(transport, 1));

        const data = yield* transport.request({ type: "garbage" });
        const events = yield* Fiber.join(collector);

        expect(data).toEqual({ ok: true });
        expect(events).toEqual([{ type: "test_event", after: true }]);
      }).pipe(withNodeLayer),
    10_000,
  );

  effectIt.live(
    "fails a rejected command with the provider error detail",
    () =>
      Effect.gen(function* () {
        const transport = yield* startTransport();
        const error = yield* captureFailure(
          transport.request({ type: "fail", detail: "quota exhausted" }),
        );

        if (!Schema.is(PiRpcCommandError)(error)) {
          throw new Error(`expected a PiRpcCommandError, got ${String(error)}`);
        }
        expect(error.detail).toBe("quota exhausted");
      }).pipe(withNodeLayer),
    10_000,
  );

  effectIt.live(
    "fails an unknown command rather than hanging",
    () =>
      Effect.gen(function* () {
        const transport = yield* startTransport();
        const error = yield* captureFailure(transport.request({ type: "does_not_exist" }));

        if (!Schema.is(PiRpcCommandError)(error)) {
          throw new Error(`expected a PiRpcCommandError, got ${String(error)}`);
        }
        expect(error.detail).toContain("unknown command");
      }).pipe(withNodeLayer),
    10_000,
  );

  effectIt.live(
    "times out a command that never answers",
    () =>
      Effect.gen(function* () {
        const transport = yield* startTransport();
        const error = yield* captureFailure(
          transport.request({ type: "silent" }, { timeout: Duration.millis(150) }),
        );

        if (!Schema.is(PiRpcTimeoutError)(error)) {
          throw new Error(`expected a PiRpcTimeoutError, got ${String(error)}`);
        }
        expect(error.commandType).toBe("silent");
        expect(error.timeoutMs).toBe(150);
      }).pipe(withNodeLayer),
    10_000,
  );

  effectIt.live(
    "resolves a timed-out command if the response finally arrives",
    () =>
      Effect.gen(function* () {
        const transport = yield* startTransport();
        const pending = yield* Effect.forkScoped(
          transport.request({ type: "delay", value: "late", ms: 300 }),
        );
        const error = yield* captureFailure(
          transport.request({ type: "silent" }, { timeout: Duration.millis(50) }),
        );

        if (!Schema.is(PiRpcTimeoutError)(error)) {
          throw new Error(`expected a PiRpcTimeoutError, got ${String(error)}`);
        }
        expect(yield* Fiber.join(pending)).toEqual({ pong: "late" });
      }).pipe(withNodeLayer),
    10_000,
  );

  effectIt.live(
    "fails in-flight commands and ends the event stream when the process exits",
    () =>
      Effect.gen(function* () {
        const transport = yield* startTransport();
        const collector = yield* Effect.forkScoped(collectEvents(transport, 1));

        const error = yield* captureFailure(transport.request({ type: "exit", code: 7 }));
        const events = yield* Fiber.join(collector);

        if (!Schema.is(PiRpcExitedError)(error)) {
          throw new Error(`expected a PiRpcExitedError, got ${String(error)}`);
        }
        expect(error.exitCode).toBe(7);
        expect(events).toEqual([{ type: "test_event", exiting: true }]);
        expect(yield* transport.exited).toBe(7);
        expect(yield* transport.isRunning).toBe(false);
      }).pipe(withNodeLayer),
    10_000,
  );

  effectIt.live(
    "sends fire-and-forget commands without waiting for a response",
    () =>
      Effect.gen(function* () {
        const transport = yield* startTransport();
        yield* transport.notify({ type: "notify", value: 1 });
        expect(yield* transport.request({ type: "ping", value: "after" })).toEqual({
          pong: "after",
          pid: transport.pid,
        });
      }).pipe(withNodeLayer),
    10_000,
  );
});
