import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, it as effectIt } from "@effect/vitest";
import { PiSettings, type ServerProviderSlashCommand } from "@t3tools/contracts";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, it as plainIt } from "vite-plus/test";

import * as PiRpcTransport from "../pi/PiRpcTransport.ts";
import { decodePiGetCommands, probePiCommands } from "./PiCommands.ts";

const enabledSettings = Schema.decodeSync(PiSettings)({ enabled: true });

interface ProbeRun {
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly launchedArgs: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * Runs the probe against `fakePiRpc.mjs`, the only process started here; no
 * model is ever prompted. The fixture answers `get_commands` according to its
 * `FAKE_*` environment variables.
 */
const runProbe = (environment: NodeJS.ProcessEnv, timeoutMs = 2_000) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const executable = yield* HostProcessExecutablePath;
    const scriptPath = path.join(import.meta.dirname, "../testFixtures/fakePiRpc.mjs");
    const launchedArgs: Array<ReadonlyArray<string>> = [];
    const commands = yield* probePiCommands(enabledSettings, {
      environment,
      timeoutMs,
      makeTransport: ({ cwd, environment: env, args }) => {
        launchedArgs.push(args);
        return PiRpcTransport.make({
          binaryPath: executable,
          args: [scriptPath, ...args],
          cwd,
          env,
        });
      },
    });
    return { commands, launchedArgs } satisfies ProbeRun;
  });

const catalog = JSON.stringify({
  commands: [
    { name: "zip", description: "Zip a workspace", source: "prompt", location: "project" },
    { name: "session-name", description: "Set or clear session name", source: "extension" },
    { name: "skill:brave-search", description: "Web search", source: "skill", location: "user" },
    { name: "no-description", source: "extension" },
    { name: "  ", source: "extension" },
  ],
});

it.layer(NodeServices.layer)("probePiCommands", (it) => {
  it.effect("maps the get_commands payload onto sorted slash commands", () =>
    Effect.gen(function* () {
      const { commands, launchedArgs } = yield* runProbe({
        ...process.env,
        FAKE_PI_COMMANDS: catalog,
      });

      expect(launchedArgs).toEqual([["--mode", "rpc", "--no-session"]]);
      expect(commands).toEqual([
        { name: "no-description" },
        { name: "session-name", description: "Set or clear session name" },
        { name: "skill:brave-search", description: "Web search" },
        { name: "zip", description: "Zip a workspace" },
      ]);
    }),
  );

  it.effect("reports a failed response as a transport failure", () =>
    Effect.gen(function* () {
      const error = yield* runProbe({
        ...process.env,
        FAKE_PI_GET_COMMANDS: "error",
      }).pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "PiCommandsProbeError", stage: "transport" });
    }),
  );

  it.effect("rejects a payload without a commands array", () =>
    Effect.gen(function* () {
      for (const payload of ["null", "{}", '{"commands":"nope"}']) {
        const error = yield* runProbe({
          ...process.env,
          FAKE_PI_COMMANDS: payload,
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "PiCommandsProbeError", stage: "decode" });
      }
    }),
  );
});

// `it.effect` runs on the TestClock, which never advances a probe timeout on
// its own, so the timeout case needs the live clock.
effectIt.live(
  "reports a probe that never answers as a timeout",
  () =>
    Effect.gen(function* () {
      const error = yield* runProbe({ ...process.env, FAKE_PI_GET_COMMANDS: "silent" }, 250).pipe(
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "PiCommandsProbeError", stage: "timeout" });
    }).pipe(Effect.provide(NodeServices.layer)),
  10_000,
);

describe("decodePiGetCommands", () => {
  plainIt("keeps the first occurrence of a duplicated name", () => {
    expect(
      decodePiGetCommands({
        commands: [
          { name: "review", description: "Project review" },
          { name: "review", description: "User review" },
        ],
      }),
    ).toEqual([{ name: "review", description: "Project review" }]);
  });
});
