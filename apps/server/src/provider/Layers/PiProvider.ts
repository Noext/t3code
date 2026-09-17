/**
 * Snapshot probing for the Pi provider (`pi --mode rpc`).
 *
 * The probe answers three questions: is the `pi` binary runnable, which version
 * is it, and does it currently have any usable model? The last one is the
 * interesting case.
 *
 * Pi exposes no provider-agnostic auth command. `pi auth check` only reads Pi's
 * own credential store (`~/.pi/agent/auth.json`), which is empty whenever
 * providers are registered by extensions that resolve their own credentials —
 * the common setup, where an extension reads an API key from the environment
 * and fetches its model list at startup. Such a setup reports `not_ready` for
 * every provider while working perfectly.
 *
 * So the catalog *is* the readiness signal: `pi --list-models` loads
 * extensions, and an extension whose credentials are missing registers a
 * provider with no models. A non-empty catalog therefore means "Pi reached at
 * least one provider", and an empty one means it did not.
 *
 * @module provider/Layers/PiProvider
 */
import {
  type CustomModelSetting,
  type PiSettings,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  parsePiModelCatalog,
  piCatalogToServerProviderModels,
  type PiCatalogModel,
} from "../pi/piModelCatalog.ts";
import { probePiCommands, type PiCommandsTransportFactory } from "../Drivers/PiCommands.ts";
import { discoverPiSkills } from "../Drivers/PiSkills.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  // Withheld for now, and this has to agree with the adapter's own capability:
  // a rewind that can remove more turns than the user asked for is worse than no
  // rewind, and the boundary machinery is not trustworthy enough yet.
  supportsConversationRollback: false,
  reportsContextWindow: true,
  badgeLabel: "Early Access",
} as const;

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 4_000;
/**
 * `pi --list-models` loads every installed extension, and an extension may
 * fetch its catalog over the network with its own timeout. This budget has to
 * outlast that, or a slow hub reads as "no models".
 */
const MODEL_PROBE_TIMEOUT_MS = 20_000;

/**
 * Always keep `/compact`: T3 drives it itself, while `get_commands` only
 * reports Pi's own command surface. Discovered entries that collide with a
 * built-in keep the built-in wording.
 */
export const piSlashCommands = (
  discovered: ReadonlyArray<ServerProviderSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> => [
  COMPACT_SLASH_COMMAND,
  ...(discovered ?? []).filter((command) => command.name !== COMPACT_SLASH_COMMAND.name),
];

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);

    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi CLI availability...",
      },
    });
  });
}

function piModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

const runPiCliCommand = (
  piSettings: PiSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      // Extensions define providers, so they are never disabled here. `PI_OFFLINE`
      // is deliberately not set: it would stop an extension from fetching its
      // model list, which is exactly what this probe needs to observe.
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const distinctProviders = (models: ReadonlyArray<PiCatalogModel>): ReadonlyArray<string> => [
  ...new Set(models.map((model) => model.provider)),
];

const summarizeProviders = (providers: ReadonlyArray<string>): string => {
  if (providers.length <= 3) {
    return providers.join(", ");
  }
  return `${providers.slice(0, 3).join(", ")} +${providers.length - 3} more`;
};

const UNAUTHENTICATED_MESSAGE =
  "Pi is installed but reports no available models. Authenticate a provider inside Pi (for example `/login`), or set the provider's API key environment variable. For extension-provided providers, add that variable to this instance's environment.";

export interface PiProviderProbeOptions {
  /**
   * Tests supply a fixture process or a scripted transport for the
   * `get_commands` probe; production spawns `pi --mode rpc`.
   */
  readonly makeCommandsTransport?: PiCommandsTransportFactory | undefined;
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  options: PiProviderProbeOptions = {},
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiCliCommand(piSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Pi CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute the Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Pi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run.",
      },
    });
  }

  const catalogResult = yield* runPiCliCommand(piSettings, ["--list-models"], environment).pipe(
    Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  // Only a clean exit is parsed. A failed invocation prints help or error text
  // that must not be mistaken for a provider list.
  const catalogOutput =
    Result.isSuccess(catalogResult) &&
    Option.isSome(catalogResult.success) &&
    catalogResult.success.value.code === 0
      ? catalogResult.success.value
      : undefined;
  const catalogModels = catalogOutput
    ? parsePiModelCatalog(`${catalogOutput.stdout}\n${catalogOutput.stderr}`)
    : [];
  const catalogProbeFailed = catalogOutput === undefined;
  if (catalogProbeFailed) {
    yield* Effect.logWarning("Pi model listing failed or timed out.", {
      errorTag: Result.isFailure(catalogResult)
        ? catalogResult.failure._tag
        : Option.isNone(catalogResult.success)
          ? "Timeout"
          : `ExitCode${catalogResult.success.value.code}`,
    });
  }

  const providers = distinctProviders(catalogModels);
  const discoveredModels = piCatalogToServerProviderModels(catalogModels);
  const models =
    discoveredModels.length > 0
      ? piModelsFromSettings(piSettings.customModels, discoveredModels)
      : fallbackModels;

  // Skill discovery is best-effort: an unreadable skills root must not turn a
  // working provider into an error card.
  const skills = yield* discoverPiSkills(cwd, environment).pipe(
    Effect.tapError((cause) => Effect.logDebug("Pi skill discovery failed.", { cause })),
    Effect.orElseSucceed(() => []),
  );
  const commandsProbe = yield* probePiCommands(piSettings, {
    ...(cwd === undefined ? {} : { cwd }),
    environment,
    ...(options.makeCommandsTransport ? { makeTransport: options.makeCommandsTransport } : {}),
  }).pipe(Effect.result);
  const discoveredCommands = Result.isSuccess(commandsProbe) ? commandsProbe.success : undefined;
  if (discoveredCommands === undefined) {
    // A timeout or transport failure says nothing about what commands exist,
    // so the snapshot degrades to `/compact` with a warning instead of
    // claiming the workspace has none.
    yield* Effect.logWarning("Pi command listing failed or timed out.", {
      stage: Result.isFailure(commandsProbe) ? commandsProbe.failure.stage : "unknown",
    });
  }
  const slashCommands = piSlashCommands(discoveredCommands);

  if (catalogProbeFailed) {
    // A probe failure says nothing about credentials, so the auth verdict stays
    // unknown rather than claiming the user is logged out.
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models,
      skills,
      slashCommands,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but did not report its model catalog.",
      },
    });
  }

  const auth: ServerProviderAuth =
    catalogModels.length > 0
      ? { status: "authenticated", label: summarizeProviders(providers) }
      : { status: "unauthenticated" };

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models,
      skills,
      slashCommands,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: UNAUTHENTICATED_MESSAGE,
      },
    });
  }

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    skills,
    slashCommands,
    probe: {
      installed: true,
      version,
      // A failed command probe only narrows the `/` menu; it does not make
      // chats fail.
      status: discoveredCommands === undefined ? "warning" : "ready",
      auth,
      ...(discoveredCommands === undefined
        ? {
            message:
              "Pi CLI is installed but did not report its slash commands. Slash commands may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
