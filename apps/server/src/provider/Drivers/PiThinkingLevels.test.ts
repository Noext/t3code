import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, it as effectIt } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, it as plainIt } from "vite-plus/test";

import * as PiRpcTransport from "../pi/PiRpcTransport.ts";
import {
  decodePiThinkingLevels,
  probePiThinkingLevels,
  type PiThinkingLevelsProbeInput,
} from "./PiThinkingLevels.ts";

const enabledSettings = Schema.decodeSync(PiSettings)({ enabled: true });
/** A path that cannot be spawned, for the "the process never starts" case. */
const missingBinarySettings = Schema.decodeSync(PiSettings)({
  enabled: true,
  binaryPath: "/nonexistent/pi-binary",
});

const MODELS = [
  { provider: "local-openai", model: "kimi-k3" },
  { provider: "local-openai", model: "opencode-go/deepseek-v4.1-flash" },
  { provider: "local-openai", model: "opencode-go/glm-5.2" },
];

/**
 * Runs the probe against `fakePiRpc.mjs`, the only process started here. The
 * fixture answers `set_model` and `get_available_thinking_levels` according to
 * its `FAKE_*` environment variables.
 */
const runProbe = (environment: NodeJS.ProcessEnv, timeoutMs = 2_000) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const executable = yield* HostProcessExecutablePath;
    const scriptPath = path.join(import.meta.dirname, "../testFixtures/fakePiRpc.mjs");
    const launchedArgs: Array<ReadonlyArray<string>> = [];
    const levels = yield* probePiThinkingLevels(enabledSettings, {
      models: MODELS,
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
    return { levels, launchedArgs };
  });

/** The levels Pi reports for a model whose provider fronts a whole catalog. */
const DEEPSEEK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PORTABLE_LEVELS = ["off", "minimal", "low", "medium", "high"];
const DEEPSEEK_ONLY = JSON.stringify(DEEPSEEK_LEVELS);
const LEVELS_BY_MODEL = JSON.stringify({
  "opencode-go/deepseek-v4.1-flash": DEEPSEEK_LEVELS,
  "opencode-go/glm-5.2": PORTABLE_LEVELS,
});

it.layer(NodeServices.layer)("probePiThinkingLevels", (it) => {
  it.effect("keys each model's levels by the catalog slug", () =>
    Effect.gen(function* () {
      const { levels, launchedArgs } = yield* runProbe({
        ...process.env,
        FAKE_PI_THINKING_LEVELS: LEVELS_BY_MODEL,
      });

      expect(launchedArgs).toEqual([["--mode", "rpc", "--no-session"]]);
      // `kimi-k3` is absent from the map, which is how the caller learns it has
      // to keep the portable levels.
      expect([...levels.entries()]).toEqual([
        ["local-openai/opencode-go/deepseek-v4.1-flash", DEEPSEEK_LEVELS],
        ["local-openai/opencode-go/glm-5.2", PORTABLE_LEVELS],
      ]);
    }),
  );

  it.effect("drops a model Pi refuses to set and keeps the others", () =>
    Effect.gen(function* () {
      const { levels } = yield* runProbe({
        ...process.env,
        FAKE_PI_REJECT_MODEL: "opencode-go/glm-5.2",
        FAKE_PI_THINKING_LEVELS: DEEPSEEK_ONLY,
      });

      expect([...levels.keys()]).toEqual([
        "local-openai/kimi-k3",
        "local-openai/opencode-go/deepseek-v4.1-flash",
      ]);
      expect(levels.get("local-openai/opencode-go/deepseek-v4.1-flash")).toEqual(DEEPSEEK_LEVELS);
    }),
  );

  it.effect("treats a failed level query as no answer rather than a probe failure", () =>
    Effect.gen(function* () {
      const { levels } = yield* runProbe({ ...process.env, FAKE_PI_GET_LEVELS: "error" });

      expect(levels.size).toBe(0);
    }),
  );

  it.effect("does not start a process when there is no model to ask about", () =>
    Effect.gen(function* () {
      let spawned = false;
      const levels = yield* probePiThinkingLevels(enabledSettings, {
        models: [],
        makeTransport: () => {
          spawned = true;
          return Effect.die("the probe must not spawn for an empty catalog");
        },
      } satisfies PiThinkingLevelsProbeInput);

      expect(spawned).toBe(false);
      expect(levels.size).toBe(0);
    }),
  );

  it.effect("reports a process that never starts as a spawn failure", () =>
    Effect.gen(function* () {
      const error = yield* probePiThinkingLevels(missingBinarySettings, { models: MODELS }).pipe(
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "PiThinkingLevelsProbeError", stage: "spawn" });
    }),
  );
});

// `it.effect` runs on the TestClock, which never advances a probe timeout on
// its own, so the timeout case needs the live clock.
effectIt.live(
  "reports a probe that never answers as a timeout",
  () =>
    Effect.gen(function* () {
      const error = yield* runProbe({ ...process.env, FAKE_PI_GET_LEVELS: "silent" }, 250).pipe(
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "PiThinkingLevelsProbeError", stage: "timeout" });
    }).pipe(Effect.provide(NodeServices.layer)),
  10_000,
);

describe("decodePiThinkingLevels", () => {
  plainIt("keeps the documented levels, in order, without duplicates", () => {
    expect(decodePiThinkingLevels({ levels: ["low", "high", "low", "xhigh", "max"] })).toEqual([
      "low",
      "high",
      "xhigh",
      "max",
    ]);
  });

  plainIt("drops levels Pi does not document", () => {
    // `ultracode` is a T3-side alias for `xhigh`, not a level Pi accepts.
    expect(decodePiThinkingLevels({ levels: ["medium", "ultracode", "turbo"] })).toEqual([
      "medium",
    ]);
  });

  plainIt("rejects payloads that are not a usable level list", () => {
    for (const payload of [null, "high", {}, { levels: "high" }, { levels: [] }, { levels: [7] }]) {
      expect(decodePiThinkingLevels(payload)).toBeUndefined();
    }
  });
});
