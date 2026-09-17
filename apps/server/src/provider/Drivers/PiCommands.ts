/**
 * PiCommands — the `/` menu catalog from Pi's RPC `get_commands`.
 *
 * `get_commands` is the only authoritative source for what a workspace can
 * invoke: it resolves extension commands, prompt templates, and `skill:`
 * entries the same way a real turn would, honoring the cwd, project trust,
 * user settings, packages, and installed extensions. Scanning the same
 * locations by hand would miss everything extensions register.
 *
 * The probe is a short-lived `pi --mode rpc` process that answers one command
 * and exits; it never sends a prompt, so no model is called. Loading
 * extensions takes seconds and an extension may do network I/O at startup, so
 * the budget has to outlast that. A timeout or failed probe stays typed so the
 * caller can degrade the snapshot instead of reporting "no commands".
 *
 * @module provider/Drivers/PiCommands
 */
import type { PiSettings, ServerProviderSlashCommand } from "@t3tools/contracts";
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
const PI_COMMANDS_ARGV = ["--mode", "rpc", "--no-session"] as const;
/**
 * Extensions load during startup, and the operator's extension does network
 * I/O, so this budget mirrors the model probe's rather than the CLI probes'.
 */
export const PI_COMMANDS_PROBE_TIMEOUT_MS = 25_000;

export type PiCommandsTransportFactory = (input: {
  readonly cwd: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly args: ReadonlyArray<string>;
}) => Effect.Effect<
  PiRpcTransportShape,
  PiRpcTransport.PiRpcSpawnError | PlatformError.PlatformError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
>;

export interface PiCommandsProbeInput {
  readonly cwd?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /**
   * Supplied by tests to drive a fixture process or a scripted transport;
   * production spawns `pi --mode rpc`.
   */
  readonly makeTransport?: PiCommandsTransportFactory | undefined;
  /** Override for tests. Production uses {@link PI_COMMANDS_PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

export class PiCommandsProbeError extends Schema.TaggedError<PiCommandsProbeError>()(
  "PiCommandsProbeError",
  {
    stage: Schema.Literals(["spawn", "timeout", "transport", "decode"]),
    cwd: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `\`get_commands\` failed during ${this.stage}${location}.`;
  }
}

/**
 * Map a `get_commands` payload onto provider slash commands. Entries without a
 * name are skipped; names are deduped because Pi can report the same command
 * from more than one source.
 */
export function decodePiGetCommands(
  data: unknown,
): ReadonlyArray<ServerProviderSlashCommand> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const entries = (data as Record<string, unknown>).commands;
  if (!Array.isArray(entries)) return undefined;

  const commandsByName = new Map<string, ServerProviderSlashCommand>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name || commandsByName.has(name)) continue;
    const description = typeof record.description === "string" ? record.description.trim() : "";
    commandsByName.set(name, { name, ...(description ? { description } : {}) });
  }
  return [...commandsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

const stageForCause = (cause: unknown): "spawn" | "timeout" | "transport" => {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause
      ? String((cause as { readonly _tag: unknown })._tag)
      : "";
  if (tag === "PiRpcSpawnError" || tag === "PlatformError") return "spawn";
  if (tag === "PiRpcTimeoutError") return "timeout";
  return "transport";
};

export const probePiCommands = Effect.fn("probePiCommands")(function* (
  piSettings: Pick<PiSettings, "binaryPath">,
  input: PiCommandsProbeInput = {},
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSlashCommand>,
  PiCommandsProbeError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const environment = input.environment ?? process.env;
  const cwd = input.cwd;
  const timeoutMs = input.timeoutMs ?? PI_COMMANDS_PROBE_TIMEOUT_MS;

  const probe = yield* Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* input.makeTransport
        ? input.makeTransport({ cwd, environment, args: PI_COMMANDS_ARGV })
        : PiRpcTransport.make({
            binaryPath: piSettings.binaryPath || "pi",
            args: PI_COMMANDS_ARGV,
            ...(cwd === undefined ? {} : { cwd }),
            env: environment,
            requestTimeout: timeoutMs,
          });
      return yield* transport.request({ type: "get_commands" }, { timeout: timeoutMs });
    }),
  ).pipe(Effect.timeoutOption(timeoutMs), Effect.result);

  if (Result.isFailure(probe)) {
    return yield* new PiCommandsProbeError({
      stage: stageForCause(probe.failure),
      ...(cwd ? { cwd } : {}),
      cause: probe.failure,
    });
  }
  if (Option.isNone(probe.success)) {
    return yield* new PiCommandsProbeError({
      stage: "timeout",
      ...(cwd ? { cwd } : {}),
    });
  }

  const commands = decodePiGetCommands(probe.success.value);
  if (!commands) {
    return yield* new PiCommandsProbeError({ stage: "decode", ...(cwd ? { cwd } : {}) });
  }
  return commands;
});
