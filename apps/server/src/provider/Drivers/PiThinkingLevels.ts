/**
 * PiThinkingLevels — the per-model reasoning levels from
 * `get_available_thinking_levels`.
 *
 * `pi --list-models` reports only *whether* a model reasons, never which levels
 * it accepts. `xhigh` and `max` are model-specific: on this machine's catalog,
 * the `deepseek-v4.*` models answer with seven levels while every `glm-*`,
 * `kimi-*`, and `gpt-*` model answers with the five portable ones. Guessing
 * would put an effort level in front of the user that Pi rejects, so the levels
 * have to be asked for.
 *
 * Only Pi can answer: `get_available_thinking_levels` describes the model the
 * session currently holds, which is why the probe sets each catalog model in
 * turn and reads the reply. One short-lived `pi --mode rpc --no-session`
 * process covers the whole catalog. Loading extensions dominates the cost
 * (seconds — the same startup the `--list-models` probe already pays), while
 * the round trips themselves measured ~10 ms for 40 models. The budget
 * therefore outlasts startup, exactly like the model probe's.
 *
 * A model whose `set_model` or query fails is simply absent from the result,
 * and the caller keeps the portable levels for it. That is deliberately not an
 * error: an unusable reasoning list is a worse reason to lose the provider
 * snapshot than to lose two menu entries.
 *
 * @module provider/Drivers/PiThinkingLevels
 */
import type { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as PiRpcTransport from "../pi/PiRpcTransport.ts";
import type { PiRpcTransportShape } from "../pi/PiRpcTransport.ts";

/** `--no-session` keeps the probe out of the user's Pi session list. */
const PI_THINKING_LEVELS_ARGV = ["--mode", "rpc", "--no-session"] as const;

/**
 * The levels Pi can report. Owned here rather than in the model catalog so an
 * unknown id can never reach the composer: anything else in the reply is a
 * protocol surprise, not a level we can send back.
 */
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const PI_THINKING_LEVEL_IDS = new Set<string>(PI_THINKING_LEVELS);

/** Mirrors the model probe's budget: extensions load before the first answer. */
export const PI_THINKING_LEVELS_PROBE_TIMEOUT_MS = 20_000;

export type PiThinkingLevelsTransportFactory = (input: {
  readonly cwd: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly args: ReadonlyArray<string>;
}) => Effect.Effect<
  PiRpcTransportShape,
  PiRpcTransport.PiRpcSpawnError | PlatformError.PlatformError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
>;

/** A catalog row the probe can set: `provider` is Pi's, `model` may contain slashes. */
export interface PiThinkingLevelsModel {
  readonly provider: string;
  readonly model: string;
}

export interface PiThinkingLevelsProbeInput {
  readonly models: ReadonlyArray<PiThinkingLevelsModel>;
  readonly cwd?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /**
   * Supplied by tests to drive a fixture process or a scripted transport;
   * production spawns `pi --mode rpc`.
   */
  readonly makeTransport?: PiThinkingLevelsTransportFactory | undefined;
  /** Override for tests. Production uses {@link PI_THINKING_LEVELS_PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

export class PiThinkingLevelsProbeError extends Schema.TaggedError<PiThinkingLevelsProbeError>()(
  "PiThinkingLevelsProbeError",
  {
    /** Only two things can go wrong here: the process never starts, or the probe runs out of time. */
    stage: Schema.Literals(["spawn", "timeout"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `\`get_available_thinking_levels\` failed during ${this.stage}.`;
  }
}

/**
 * Map a `get_available_thinking_levels` payload onto level ids, dropping
 * anything Pi did not document and tolerating duplicates. `undefined` means the
 * payload was not a level list at all, which is how a caller tells "no answer"
 * from "answered with nothing usable".
 */
export function decodePiThinkingLevels(data: unknown): ReadonlyArray<string> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const levels = (data as Record<string, unknown>).levels;
  if (!Array.isArray(levels)) return undefined;
  const known = new Set<string>();
  for (const level of levels) {
    if (typeof level === "string" && PI_THINKING_LEVEL_IDS.has(level)) {
      known.add(level);
    }
  }
  return known.size > 0 ? [...known] : undefined;
}

const levelsForModel = (
  transport: PiRpcTransportShape,
  model: PiThinkingLevelsModel,
): Effect.Effect<ReadonlyArray<string> | undefined> =>
  transport.request({ type: "set_model", provider: model.provider, modelId: model.model }).pipe(
    Effect.flatMap(() => transport.request({ type: "get_available_thinking_levels" })),
    Effect.map(decodePiThinkingLevels),
    // A model Pi refuses to set, or one whose query fails, keeps the portable
    // levels upstream instead of failing the whole probe.
    Effect.orElseSucceed((): ReadonlyArray<string> | undefined => undefined),
  );

/**
 * Ask Pi for the reasoning levels of every model given, keyed by the
 * `provider/model` slug the catalog builds. Models Pi has no answer for are
 * omitted.
 */
export const probePiThinkingLevels = Effect.fn("probePiThinkingLevels")(function* (
  piSettings: Pick<PiSettings, "binaryPath">,
  input: PiThinkingLevelsProbeInput,
): Effect.fn.Return<
  ReadonlyMap<string, ReadonlyArray<string>>,
  PiThinkingLevelsProbeError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const environment = input.environment ?? process.env;
  const cwd = input.cwd;
  const timeoutMs = input.timeoutMs ?? PI_THINKING_LEVELS_PROBE_TIMEOUT_MS;

  if (input.models.length === 0) {
    return new Map<string, ReadonlyArray<string>>();
  }

  const probe = yield* Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* input.makeTransport
        ? input.makeTransport({ cwd, environment, args: PI_THINKING_LEVELS_ARGV })
        : PiRpcTransport.make({
            binaryPath: piSettings.binaryPath || "pi",
            args: PI_THINKING_LEVELS_ARGV,
            ...(cwd === undefined ? {} : { cwd }),
            env: environment,
            requestTimeout: timeoutMs,
          });

      const levels = new Map<string, ReadonlyArray<string>>();
      for (const model of input.models) {
        const available = yield* levelsForModel(transport, model);
        if (available !== undefined) {
          levels.set(`${model.provider}/${model.model}`, available);
        }
      }
      return levels;
    }),
  ).pipe(Effect.timeoutOption(timeoutMs), Effect.result);

  if (Result.isFailure(probe)) {
    // Per-model failures are swallowed above, so a typed failure here is the
    // transport never being created — the process did not start.
    return yield* new PiThinkingLevelsProbeError({ stage: "spawn", cause: probe.failure });
  }
  if (Option.isNone(probe.success)) {
    return yield* new PiThinkingLevelsProbeError({ stage: "timeout" });
  }
  return probe.success.value;
});
