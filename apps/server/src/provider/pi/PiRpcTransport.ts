import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

/**
 * Pi RPC mode speaks strict JSONL: LF is the only record delimiter, and a
 * trailing `\r` is tolerated on input. Generic line readers (notably Node's
 * `readline`) are not protocol-compliant because they also split on `U+2028`
 * and `U+2029`, which are legal inside JSON strings.
 */
export const splitPiJsonLines = <E, R>(
  self: Stream.Stream<string, E, R>,
): Stream.Stream<string, E, R> =>
  self.pipe(
    Stream.mapAccum(
      () => "",
      (buffer, chunk) => {
        const parts = `${buffer}${chunk}`.split("\n");
        const remainder = parts.pop() ?? "";
        return [remainder, parts] as const;
      },
      {
        onHalt: (buffer) => (buffer.length > 0 ? [buffer] : []),
      },
    ),
    Stream.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)),
    Stream.filter((line) => line.length > 0),
  );

export class PiRpcSpawnError extends Schema.TaggedError<PiRpcSpawnError>()("PiRpcSpawnError", {
  command: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to spawn the Pi RPC process: ${this.command}`;
  }
}

export class PiRpcExitedError extends Schema.TaggedError<PiRpcExitedError>()("PiRpcExitedError", {
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
}) {
  override get message(): string {
    return this.exitCode === undefined
      ? "Pi RPC process exited before the request completed"
      : `Pi RPC process exited with code ${this.exitCode} before the request completed`;
  }
}

export class PiRpcTimeoutError extends Schema.TaggedError<PiRpcTimeoutError>()(
  "PiRpcTimeoutError",
  {
    commandType: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Pi RPC command "${this.commandType}" timed out after ${this.timeoutMs}ms`;
  }
}

export class PiRpcCommandError extends Schema.TaggedError<PiRpcCommandError>()(
  "PiRpcCommandError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC command "${this.commandType}" failed: ${this.detail}`;
  }
}

export type PiRpcError = PiRpcSpawnError | PiRpcExitedError | PiRpcTimeoutError | PiRpcCommandError;

/** A command sent to Pi's stdin. `id` is added by the transport for correlation. */
export interface PiRpcCommand {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A `type: "response"` record from Pi. */
export interface PiRpcResponse {
  readonly type: "response";
  readonly id?: string;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

/** A streamed agent event from Pi. Only `type` is guaranteed by the protocol. */
export type PiRpcEvent = { readonly type: string } & Record<string, unknown>;

export interface PiRpcTransportOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly extendEnv?: boolean | undefined;
  /** How long to wait for the `response` record of a single command. */
  readonly requestTimeout?: Duration.Input | undefined;
  readonly onStderr?: ((chunk: string) => Effect.Effect<void>) | undefined;
}

export interface PiRpcRequestOptions {
  readonly timeout?: Duration.Input | undefined;
}

export interface PiRpcTransportShape {
  readonly pid: number;
  /** Sends a command and resolves with its `data` payload. */
  readonly request: (
    command: PiRpcCommand,
    options?: PiRpcRequestOptions,
  ) => Effect.Effect<unknown, PiRpcError>;
  /** Sends a command without expecting a response (e.g. extension UI replies). */
  readonly notify: (command: PiRpcCommand) => Effect.Effect<void, PiRpcError>;
  readonly events: Stream.Stream<PiRpcEvent>;
  /** Resolves with the process exit code. */
  readonly exited: Effect.Effect<number, PiRpcError>;
  readonly isRunning: Effect.Effect<boolean>;
  readonly kill: Effect.Effect<void, PiRpcError>;
}

const textEncoder = new TextEncoder();
const defaultRequestTimeout = Duration.seconds(60);

/**
 * Pi frames every record as one JSON line. `UnknownFromJsonString` keeps the
 * decode schema-aware instead of reaching for `JSON.parse`, and a malformed
 * line stays a dropped record rather than a failed stream.
 */
const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const make = (
  options: PiRpcTransportOptions,
): Effect.Effect<
  PiRpcTransportShape,
  PiRpcSpawnError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.Scope;
    const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, options.args, {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.extendEnv === undefined ? {} : { extendEnv: options.extendEnv }),
    }).pipe(
      Effect.mapError((cause) => new PiRpcSpawnError({ command: options.binaryPath, cause })),
    );

    const handle = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.env === undefined ? {} : { env: options.env }),
          extendEnv: options.extendEnv ?? true,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError((cause) => new PiRpcSpawnError({ command: options.binaryPath, cause })),
      );

    const requestTimeout = options.requestTimeout ?? defaultRequestTimeout;
    const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const events = yield* Queue.unbounded<PiRpcEvent, Cause.Done>();
    const pending = yield* Ref.make(new Map<string, Deferred.Deferred<unknown, PiRpcError>>());
    const nextRequestId = yield* Ref.make(0);
    const exited = yield* Deferred.make<number, PiRpcError>();

    yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(handle.stdin),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("pi stdin writer stopped", cause),
      ),
      Effect.forkIn(scope),
    );

    const writeLine = (value: PiRpcCommand): Effect.Effect<void, PiRpcError> =>
      Queue.offer(outgoing, textEncoder.encode(`${JSON.stringify(value)}\n`)).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new PiRpcCommandError({
              commandType: String(value.type),
              detail: "stdin closed",
              cause,
            }),
        ),
      );

    const failPending = (error: PiRpcError): Effect.Effect<void> =>
      Effect.gen(function* () {
        const inFlight = yield* Ref.getAndSet(pending, new Map());
        yield* Effect.forEach(inFlight.values(), (deferred) => Deferred.fail(deferred, error), {
          discard: true,
        });
      });

    if (options.onStderr !== undefined) {
      const onStderr = options.onStderr;
      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => onStderr(chunk)),
        Effect.catchCause(() => Effect.void),
        Effect.forkIn(scope),
      );
    }

    yield* handle.stdout.pipe(
      Stream.decodeText(),
      splitPiJsonLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const decoded = decodeJsonLine(line);
          if (Option.isNone(decoded)) {
            yield* Effect.logWarning("pi rpc produced a non-JSON line", line);
            return;
          }
          const decodedValue = decoded.value;
          if (typeof decodedValue !== "object" || decodedValue === null) {
            yield* Effect.logWarning("pi rpc produced a non-object record", decodedValue);
            return;
          }
          const record = decodedValue as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : undefined;
          if (record.type === "response" && id !== undefined) {
            const waiter = (yield* Ref.get(pending)).get(id);
            if (waiter !== undefined) {
              yield* Ref.update(pending, (current) => {
                const next = new Map(current);
                next.delete(id);
                return next;
              });
              yield* Deferred.succeed(waiter, record);
              return;
            }
            yield* Effect.logDebug("pi rpc response without a pending request", id);
            return;
          }
          yield* Queue.offer(events, record as PiRpcEvent);
        }),
      ),
      Effect.forkIn(scope),
    );

    yield* handle.exitCode.pipe(
      Effect.map(Number),
      Effect.catchCause(() => Effect.succeed(-1)),
      Effect.flatMap((code) =>
        Effect.gen(function* () {
          yield* failPending(new PiRpcExitedError({ command: options.binaryPath, exitCode: code }));
          yield* Deferred.succeed(exited, code).pipe(Effect.ignore);
          yield* Queue.end(events);
        }),
      ),
      Effect.forkIn(scope),
    );

    const request: PiRpcTransportShape["request"] = (command, requestOptions) =>
      Effect.gen(function* () {
        const sequence = yield* Ref.updateAndGet(nextRequestId, (value) => value + 1);
        const id = `t3-${sequence}`;
        const waiter = yield* Deferred.make<unknown, PiRpcError>();
        yield* Ref.update(pending, (current) => new Map(current).set(id, waiter));
        yield* writeLine({ ...command, id });
        return yield* Deferred.await(waiter).pipe(
          Effect.timeoutOrElse({
            duration: requestOptions?.timeout ?? requestTimeout,
            orElse: () =>
              Effect.fail(
                new PiRpcTimeoutError({
                  commandType: command.type,
                  timeoutMs: Duration.toMillis(requestOptions?.timeout ?? requestTimeout),
                }),
              ),
          }),
          Effect.ensuring(
            Ref.update(pending, (current) => {
              if (!current.has(id)) {
                return current;
              }
              const next = new Map(current);
              next.delete(id);
              return next;
            }),
          ),
        );
      }).pipe(
        Effect.flatMap((response) => {
          const record = response as PiRpcResponse;
          if (record.success === false) {
            return Effect.fail(
              new PiRpcCommandError({
                commandType: record.command ?? command.type,
                detail: record.error ?? "unknown error",
              }),
            );
          }
          return Effect.succeed(record.data ?? record);
        }),
      );

    return {
      pid: Number(handle.pid),
      request,
      notify: (command) => writeLine(command),
      events: Stream.fromQueue(events),
      exited: Deferred.await(exited),
      isRunning: handle.isRunning.pipe(Effect.orElseSucceed(() => false)),
      kill: handle.kill().pipe(
        Effect.mapError(
          (cause) => new PiRpcCommandError({ commandType: "kill", detail: "kill failed", cause }),
        ),
        Effect.tap(() => Queue.end(events).pipe(Effect.ignore)),
        Effect.tap(() => Queue.end(outgoing).pipe(Effect.ignore)),
      ),
    };
  });

export const layer = (
  options: PiRpcTransportOptions,
): Effect.Effect<
  PiRpcTransportShape,
  PiRpcSpawnError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> => make(options);
