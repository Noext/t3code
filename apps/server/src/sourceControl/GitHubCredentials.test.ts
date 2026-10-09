import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";

const TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

function harness(
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }> = {},
  signedOut: ReadonlyArray<string> = [],
  tokens: Record<string, string> = {},
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const process = Layer.mock(VcsProcess.VcsProcess)({
    run: (input) =>
      Effect.sync(() => {
        calls.push(input.args);
        const user = input.args[input.args.indexOf("--user") + 1];
        if (input.args.includes("--user") && user !== undefined && signedOut.includes(user)) {
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: input.args.includes("--user") ? `token-for-${user}\n` : "active-token\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  const layer = GitHubCredentials.layer.pipe(
    Layer.provideMerge(
      ServerSettings.ServerSettingsService.layerTest({ github: { hosts, tokens } }),
    ),
    Layer.provide(process),
    Layer.provide(NodeServices.layer),
  );
  return { layer, calls };
}

describe("GitHubCredentials", () => {
  beforeEach(() => {
    for (const name of TOKEN_VARIABLES) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect("asks gh for the active login when Settings pin nothing", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("GitHub.com");
      expect(Redacted.value(credential.token)).toBe("active-token");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes --user for an account pinned in Settings", () => {
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("token-for-work");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "work"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a host turned off in Settings without asking gh", () => {
    const { layer, calls } = harness({ "github.com": { enabled: false } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("github.com"));
      expect(error._tag).toBe("GitHubHostDisabledError");
      expect(error.message).toBe(
        "GitHub host github.com is turned off in Settings → Source Control.",
      );
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an environment token win over a pinned account, as gh does", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("from-env");
      expect(credential.source).toBe("env");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks up a changed account on the next request without a restart", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const settings = yield* ServerSettings.ServerSettingsService;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");

      yield* settings.updateSettings({
        github: { hosts: { "github.com": { account: "work", enabled: true } } },
      });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("token-for-work");

      yield* settings.updateSettings({ github: { hosts: { "github.com": { enabled: false } } } });
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );

      yield* settings.updateSettings({ github: { hosts: {} } });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      // The unpinned token stayed cached; only the newly pinned account cost a gh call.
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the active login when the pinned one is no longer signed in", () => {
    const { layer, calls } = harness({ "github.com": { account: "gone" } }, ["gone"]);
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "gone"],
        ["auth", "token", "--hostname", "github.com"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads a repository owner through its own login, not gh's active one", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com", { account: "noext" });
      expect(Redacted.value(credential.token)).toBe("token-for-noext");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "noext"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the active login for an owner that is not a login", () => {
    // An organization owns its repositories but `gh` holds no login for it.
    const { layer, calls } = harness({}, ["pharmania"]);
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com", { account: "pharmania" });
      expect(Redacted.value(credential.token)).toBe("active-token");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "pharmania"],
        ["auth", "token", "--hostname", "github.com"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("ranks the owner before the login Settings pins", () => {
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com", { account: "noext" });
      expect(Redacted.value(credential.token)).toBe("token-for-noext");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "noext"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the pinned login behind an owner gh holds no login for", () => {
    const { layer, calls } = harness({ "github.com": { account: "work" } }, ["pharmania"]);
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com", { account: "pharmania" });
      expect(Redacted.value(credential.token)).toBe("token-for-work");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "pharmania"],
        ["auth", "token", "--hostname", "github.com", "--user", "work"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps two owners of one host apart, and drops one on demand", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com", { account: "one" })).token)).toBe(
        "token-for-one",
      );
      expect(Redacted.value((yield* credentials.get("github.com", { account: "two" })).token)).toBe(
        "token-for-two",
      );
      // Both are cached, so neither is asked twice until it is invalidated.
      yield* credentials.get("github.com", { account: "one" });
      expect(calls).toHaveLength(2);

      yield* credentials.invalidate("github.com", { account: "one" });
      yield* credentials.get("github.com", { account: "one" });
      expect(calls).toHaveLength(3);
      expect(calls[2]).toEqual([
        "auth",
        "token",
        "--hostname",
        "github.com",
        "--user",
        "one",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets Settings and the environment speak before an owner, as they do for a host", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const { layer, calls } = harness({}, [], { "github.com": "saved-token" });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(
        Redacted.value((yield* credentials.get("github.com", { account: "noext" })).token),
      ).toBe("saved-token");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to fall back when the caller asks for the owner's own login", () => {
    // Git asks this way: its helper already answers as the active account, so a fallback would
    // replace the machine's own configuration instead of adding an account to it.
    const { layer, calls } = harness({ "github.com": { account: "work" } }, ["pharmania"]);
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(
        credentials.get("github.com", { account: "pharmania", ownerOnly: true }),
      );
      expect(error._tag).toBe("GitHubNotSignedInError");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "pharmania"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("still answers an owner-only request from Settings and the environment", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const { layer, calls } = harness({}, [], { "github.com": "saved-token" });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const request = { account: "pharmania", ownerOnly: true } as const;
      expect(Redacted.value((yield* credentials.get("github.com", request)).token)).toBe(
        "saved-token",
      );
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps an owner-only answer apart from a loose one on the same host", () => {
    const { layer, calls } = harness({}, ["pharmania"]);
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      // The loose request accepts the active login; the strict one must not read that answer back.
      expect(Redacted.value((yield* credentials.get("github.com", { account: "pharmania" })).token)).toBe(
        "active-token",
      );
      expect(
        (yield* Effect.flip(
          credentials.get("github.com", { account: "pharmania", ownerOnly: true }),
        ))._tag,
      ).toBe("GitHubNotSignedInError");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "pharmania"],
        ["auth", "token", "--hostname", "github.com"],
        ["auth", "token", "--hostname", "github.com", "--user", "pharmania"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses a token saved in Settings before GH_TOKEN and gh", () => {
    vi.stubEnv("GH_TOKEN", "env-token");
    const { layer, calls } = harness({}, [], { "github.com": "saved-token" });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("saved-token");
      expect(credential.source).toBe("settings");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a host turned off even with a token saved in Settings", () => {
    const { layer } = harness({ "github.com": { enabled: false } }, [], {
      "github.com": "saved-token",
    });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );
    }).pipe(Effect.provide(layer));
  });
});
