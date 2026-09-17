import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as PiRpcTransport from "../pi/PiRpcTransport.ts";
import { COMPACT_SLASH_COMMAND } from "../providerSnapshot.ts";
import { checkPiProviderStatus, piSlashCommands } from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const enabledSettings = decodePiSettings({ enabled: true });

const encoder = new TextEncoder();

const MODEL_CATALOG = [
  "provider      model     context  max-out  thinking  images",
  "local-openai  kimi-k3   128K     8.2K     yes       no",
  "",
].join("\n");

/**
 * Stands in for the `pi` binary for the `--version` and `--list-models`
 * probes. The `get_commands` probe is supplied a scripted transport, so no RPC
 * process is started here.
 */
function mockPiCliSpawner() {
  const handle = (result: { stdout: string; stderr: string; code: number }) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.make(encoder.encode(result.stdout)),
      stderr: Stream.make(encoder.encode(result.stderr)),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

  return ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const args = (command as unknown as { args: ReadonlyArray<string> }).args;
      if (args[0] === "--version") return handle({ stdout: "0.5.0\n", stderr: "", code: 0 });
      if (args[0] === "--list-models") {
        return handle({ stdout: MODEL_CATALOG, stderr: "", code: 0 });
      }
      throw new Error(`Unexpected Pi args: ${args.join(" ")}`);
    }),
  );
}

const scriptedCommandsTransport = (
  request: PiRpcTransport.PiRpcTransportShape["request"],
): PiRpcTransport.PiRpcTransportShape => ({
  pid: 1,
  request,
  notify: () => Effect.void,
  events: Stream.empty,
  exited: Effect.succeed(0),
  isRunning: Effect.succeed(false),
  kill: Effect.void,
});

const writeSkill = (filePath: string, description: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(
      filePath,
      [
        "---",
        `name: ${path.basename(path.dirname(filePath))}`,
        `description: ${description}`,
        "---",
        "",
      ].join("\n"),
    );
  });

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("reports discovered skills and slash commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-provider-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(path.join(home, ".pi", "agent", "skills", "deploy", "SKILL.md"), "Deploy.");
      yield* writeSkill(path.join(workspace, ".agents", "skills", "review", "SKILL.md"), "Review.");

      const snapshot = yield* checkPiProviderStatus(
        enabledSettings,
        { ...process.env, HOME: home },
        workspace,
        {
          makeCommandsTransport: () =>
            Effect.succeed(
              scriptedCommandsTransport(() =>
                Effect.succeed({
                  commands: [
                    {
                      name: "fix-tests",
                      description: "Fix failing tests",
                      source: "prompt",
                    },
                    // Pi reports its own compact command; T3's wording must win
                    // because T3 drives `/compact` itself.
                    { name: "compact", description: "Pi compact", source: "extension" },
                    { name: "skill:brave-search", description: "Web search", source: "skill" },
                  ],
                }),
              ),
            ),
        },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mockPiCliSpawner()));

      assert.strictEqual(snapshot.status, "ready");
      assert.strictEqual(snapshot.auth.status, "authenticated");
      assert.deepStrictEqual(snapshot.skills, [
        {
          name: "deploy",
          description: "Deploy.",
          path: path.join(home, ".pi", "agent", "skills", "deploy", "SKILL.md"),
          scope: "user",
          enabled: true,
        },
        {
          name: "review",
          description: "Review.",
          path: path.join(workspace, ".agents", "skills", "review", "SKILL.md"),
          scope: "project",
          enabled: true,
        },
      ]);
      assert.deepStrictEqual(snapshot.slashCommands, [
        COMPACT_SLASH_COMMAND,
        { name: "fix-tests", description: "Fix failing tests" },
        { name: "skill:brave-search", description: "Web search" },
      ]);
    }),
  );

  it.effect("degrades to /compact with a warning when the command probe fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-provider-" });
      const home = path.join(tempDir, "home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(path.join(home, ".pi", "agent", "skills", "deploy", "SKILL.md"), "Deploy.");

      const snapshot = yield* checkPiProviderStatus(
        enabledSettings,
        { ...process.env, HOME: home },
        workspace,
        {
          makeCommandsTransport: () =>
            Effect.succeed(
              scriptedCommandsTransport(() =>
                Effect.fail(
                  new PiRpcTransport.PiRpcTimeoutError({
                    commandType: "get_commands",
                    timeoutMs: 25_000,
                  }),
                ),
              ),
            ),
        },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mockPiCliSpawner()));

      assert.strictEqual(snapshot.status, "warning");
      assert.strictEqual(
        snapshot.message,
        "Pi CLI is installed but did not report its slash commands. Slash commands may be incomplete.",
      );
      assert.deepStrictEqual(snapshot.slashCommands, [COMPACT_SLASH_COMMAND]);
      // A command-probe failure must not hide skills that are readable on disk.
      assert.deepStrictEqual(
        snapshot.skills.map((skill) => skill.name),
        ["deploy"],
      );
    }),
  );

  it.effect("treats an empty command catalog as ready", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-provider-" });

      const snapshot = yield* checkPiProviderStatus(
        enabledSettings,
        { ...process.env, HOME: path.join(tempDir, "home") },
        path.join(tempDir, "workspace"),
        {
          makeCommandsTransport: () =>
            Effect.succeed(scriptedCommandsTransport(() => Effect.succeed({ commands: [] }))),
        },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mockPiCliSpawner()));

      assert.strictEqual(snapshot.status, "ready");
      assert.deepStrictEqual(snapshot.slashCommands, [COMPACT_SLASH_COMMAND]);
    }),
  );
});

it("piSlashCommands keeps the T3 compact command first", () => {
  assert.deepStrictEqual(piSlashCommands(undefined), [COMPACT_SLASH_COMMAND]);
  assert.deepStrictEqual(piSlashCommands([{ name: "compact", description: "Pi compact" }]), [
    COMPACT_SLASH_COMMAND,
  ]);
});
