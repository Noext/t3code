import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { ServerConfig } from "../config.ts";
import { GitHubAccountCredential } from "../sourceControl/GitHubAccountCredential.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { gitRemoteAccountEnv } from "./gitRemoteAccountEnv.ts";

const NOEXT_URL = "https://github.com/Noext/trackshop.git";
const MAXIME_URL = "https://github.com/maxime-pharmania/arpilabe.git";

/** A resolver standing in for `gh`, so the policy below can be read on its own. */
const signedInAccounts = (tokens: Readonly<Record<string, string>>) =>
  ({
    resolveForOwner: ({ host, owner }: { readonly host: string; readonly owner: string }) => {
      const token = tokens[owner.toLowerCase()];
      return Effect.succeed(
        token === undefined
          ? null
          : {
              host,
              token: Redacted.make(token),
              credentialFingerprint: `fingerprint:${token}`,
            },
      );
    },
  }) satisfies GitHubAccountCredential["Service"];

const resolveEnv = (input: {
  readonly args: ReadonlyArray<string>;
  readonly remoteUrls?: ReadonlyMap<string, string>;
  readonly tokens?: Readonly<Record<string, string>>;
}) => {
  const reads: Array<string> = [];
  return gitRemoteAccountEnv({
    args: input.args,
    readRemoteUrls: () =>
      Effect.sync(() => {
        reads.push("read");
        return input.remoteUrls ?? new Map<string, string>();
      }),
  }).pipe(
    Effect.provideService(
      GitHubAccountCredential,
      signedInAccounts(
        input.tokens ?? { noext: "token-noext", "maxime-pharmania": "token-maxime" },
      ),
    ),
    Effect.map((env) => ({ env, remoteReads: reads.length })),
  );
};

it.effect("resolves no account for a command that cannot reach a remote", () =>
  Effect.gen(function* () {
    for (const args of [
      ["status", "--porcelain"],
      ["rev-parse", "HEAD"],
      ["remote", "-v"],
      ["diff", "--cached", "--patch"],
    ]) {
      const { env, remoteReads } = yield* resolveEnv({
        args,
        remoteUrls: new Map([["origin", NOEXT_URL]]),
      });

      assert.deepStrictEqual(env, {});
      assert.strictEqual(remoteReads, 0);
    }
  }),
);

it.effect("reads the repository URL out of the command it is already running", () =>
  Effect.gen(function* () {
    const { env, remoteReads } = yield* resolveEnv({
      args: ["clone", "--progress", NOEXT_URL, "trackshop"],
    });

    assert.strictEqual(env.GH_TOKEN, "token-noext");
    assert.strictEqual(env.GITHUB_TOKEN, "token-noext");
    assert.strictEqual(env.GH_DEBUG, "");
    // The URL is in the arguments, so no configuration read is needed.
    assert.strictEqual(remoteReads, 0);
  }),
);

it.effect("finds the subcommand behind git's global options", () =>
  Effect.gen(function* () {
    const { env } = yield* resolveEnv({
      args: ["-C", "/repo", "--git-dir", "/repo/.git", "fetch", "--quiet", "origin"],
      remoteUrls: new Map([["origin", NOEXT_URL]]),
    });

    assert.strictEqual(env.GH_TOKEN, "token-noext");
  }),
);

it.effect("resolves the owner of the remote a command names", () =>
  Effect.gen(function* () {
    const { env, remoteReads } = yield* resolveEnv({
      args: [
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ],
      remoteUrls: new Map([
        ["origin", MAXIME_URL],
        ["fork", NOEXT_URL],
      ]),
    });

    assert.strictEqual(env.GH_TOKEN, "token-maxime");
    assert.strictEqual(remoteReads, 1);
  }),
);

it.effect("resolves the only owner a repository has when the command names no remote", () =>
  Effect.gen(function* () {
    const { env, remoteReads } = yield* resolveEnv({
      args: ["push"],
      remoteUrls: new Map([["origin", NOEXT_URL]]),
    });

    assert.strictEqual(env.GH_TOKEN, "token-noext");
    assert.strictEqual(remoteReads, 1);
  }),
);

it.effect("keeps the named remote's owner when a repository has two owners", () =>
  Effect.gen(function* () {
    const remotes = new Map([
      ["origin", MAXIME_URL],
      ["fork", NOEXT_URL],
    ]);
    const fork = yield* resolveEnv({
      args: ["push", "-u", "fork", "HEAD:refs/heads/main"],
      remoteUrls: remotes,
    });
    const bare = yield* resolveEnv({ args: ["push"], remoteUrls: remotes });

    // Pushing to `fork` is unambiguous; a bare push could go to either owner, so it keeps the
    // account git would have used on its own.
    assert.strictEqual(fork.env.GH_TOKEN, "token-noext");
    assert.deepStrictEqual(bare.env, {});
  }),
);

it.effect("injects nothing for a remote that authenticates some other way", () =>
  Effect.gen(function* () {
    const ssh = yield* resolveEnv({ args: ["clone", "git@github.com:Noext/trackshop.git"] });
    const local = yield* resolveEnv({
      args: ["fetch", "origin"],
      remoteUrls: new Map([["origin", "/srv/git/trackshop.git"]]),
    });

    assert.deepStrictEqual(ssh.env, {});
    assert.deepStrictEqual(local.env, {});
  }),
);

it.effect("injects nothing for an owner no signed-in account owns", () =>
  Effect.gen(function* () {
    const { env } = yield* resolveEnv({
      args: ["clone", "https://github.com/pharmania/arpilabe-pilotage.git", "pilotage"],
    });

    assert.deepStrictEqual(env, {});
  }),
);

const FAKE_GH_SCRIPT = `#!/usr/bin/env node
const args = process.argv.slice(2);
const accounts = JSON.parse(process.env.T3_FAKE_GH_ACCOUNTS ?? "{}");
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(
    JSON.stringify({
      hosts: {
        "github.com": Object.keys(accounts).map((login) => ({
          state: "success",
          active: login === process.env.T3_FAKE_GH_ACTIVE,
          host: "github.com",
          login,
        })),
      },
    }),
  );
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "token") {
  const token = accounts[args[args.indexOf("--user") + 1]];
  if (token === undefined) process.exit(1);
  process.stdout.write(token);
  process.exit(0);
}
process.exit(1);
`;

/** Records the token it was spawned with, so the test observes the real child environment. */
const FAKE_GIT_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.T3_FAKE_GIT_LOG) {
  fs.appendFileSync(process.env.T3_FAKE_GIT_LOG, args.join(" ") + "|" + (process.env.GH_TOKEN ?? "") + "\\n");
}
if (args[0] === "remote") {
  process.stdout.write((process.env.T3_FAKE_GIT_REMOTES ?? "") + "\\n");
  process.exit(0);
}
const failOn = process.env.T3_FAKE_GIT_FAIL_ON ?? "";
if (failOn.length > 0 && args.join(" ").includes(failOn)) {
  process.stderr.write("remote: Repository not found.\\n");
  process.exit(1);
}
process.exit(0);
`;

const GIT_LOG_ENV_KEYS = [
  "T3_FAKE_GH_ACCOUNTS",
  "T3_FAKE_GH_ACTIVE",
  "T3_FAKE_GIT_LOG",
  "T3_FAKE_GIT_REMOTES",
  "T3_FAKE_GIT_FAIL_ON",
] as const;

/** Puts a fake `gh` and a fake `git` ahead of the real ones for the duration of `use`. */
const withFakeGitHubBinaries = <A, E, R>(
  input: {
    readonly accounts: Readonly<Record<string, string>>;
    readonly activeAccount: string;
    readonly remotes?: ReadonlyArray<string>;
    readonly failOn?: string;
  },
  use: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-remote-account-" });
    const binDir = NodePath.join(tempDir, "bin");
    NodeFS.mkdirSync(binDir, { recursive: true });
    const logPath = NodePath.join(tempDir, "git.log");
    NodeFS.writeFileSync(NodePath.join(binDir, "gh"), FAKE_GH_SCRIPT, { mode: 0o755 });
    NodeFS.writeFileSync(NodePath.join(binDir, "git"), FAKE_GIT_SCRIPT, { mode: 0o755 });

    const previousPath = process.env.PATH;
    const previous = GIT_LOG_ENV_KEYS.map((key) => [key, process.env[key]] as const);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}${NodePath.delimiter}${previousPath ?? ""}`;
        process.env.T3_FAKE_GH_ACCOUNTS = JSON.stringify(input.accounts);
        process.env.T3_FAKE_GH_ACTIVE = input.activeAccount;
        process.env.T3_FAKE_GIT_LOG = logPath;
        process.env.T3_FAKE_GIT_REMOTES = (input.remotes ?? []).join("\n");
        if (input.failOn === undefined) delete process.env.T3_FAKE_GIT_FAIL_ON;
        else process.env.T3_FAKE_GIT_FAIL_ON = input.failOn;
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;
          for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );

    return yield* use;
  });

/** Every git process the driver spawned, with the token it inherited. The remotes read is noise. */
const gitLog = () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem
      .readFileString(process.env.T3_FAKE_GIT_LOG ?? "/dev/null")
      .pipe(Effect.orElseSucceed(() => ""));
    return text
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("remote "))
      .map((line) => {
        const [args, token] = line.split("|");
        return { args: args ?? "", token: token ?? "" };
      });
  });

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-remote-account-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const twoAccounts = { Noext: "token-noext", "maxime-pharmania": "token-maxime" } as const;
const noextRemote = [`origin\t${NOEXT_URL} (fetch)`, `origin\t${NOEXT_URL} (push)`] as const;

it.effect("gives the clone the token of the account that owns the repository", () =>
  withFakeGitHubBinaries(
    { accounts: twoAccounts, activeAccount: "maxime-pharmania" },
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.execute({
        operation: "test.clone",
        cwd: process.cwd(),
        args: ["clone", "--progress", NOEXT_URL, "trackshop"],
      });

      // The active account cannot see this repository; the owner's token is what makes it readable.
      expect(yield* gitLog()).toEqual([
        { args: `clone --progress ${NOEXT_URL} trackshop`, token: "token-noext" },
      ]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("follows the same path for a fetch and a push on that clone", () =>
  withFakeGitHubBinaries(
    { accounts: twoAccounts, activeAccount: "maxime-pharmania", remotes: noextRemote },
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.execute({
        operation: "test.fetch",
        cwd: process.cwd(),
        args: ["fetch", "--quiet", "--no-tags", "origin"],
      });
      yield* driver.execute({
        operation: "test.push",
        cwd: process.cwd(),
        args: ["push", "-u", "origin", "HEAD:refs/heads/main"],
      });

      expect(yield* gitLog()).toEqual([
        { args: "fetch --quiet --no-tags origin", token: "token-noext" },
        { args: "push -u origin HEAD:refs/heads/main", token: "token-noext" },
      ]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps two owners on their own tokens while their commands run at the same time", () =>
  withFakeGitHubBinaries(
    { accounts: twoAccounts, activeAccount: "maxime-pharmania" },
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* Effect.all(
        [
          driver.execute({
            operation: "test.clone",
            cwd: process.cwd(),
            args: ["clone", NOEXT_URL, "trackshop"],
          }),
          driver.execute({
            operation: "test.clone",
            cwd: process.cwd(),
            args: ["clone", MAXIME_URL, "arpilabe"],
          }),
        ],
        { concurrency: 2 },
      );

      expect((yield* gitLog()).map((line) => `${line.args} -> ${line.token}`).toSorted()).toEqual([
        `clone ${NOEXT_URL} trackshop -> token-noext`,
        `clone ${MAXIME_URL} arpilabe -> token-maxime`,
      ]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("leaves a repository no account owns on the ambient account", () =>
  withFakeGitHubBinaries(
    { accounts: twoAccounts, activeAccount: "maxime-pharmania" },
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.execute({
        operation: "test.clone",
        cwd: process.cwd(),
        args: ["clone", "https://github.com/pharmania/arpilabe-pilotage.git", "pilotage"],
      });

      expect(yield* gitLog()).toEqual([
        {
          args: "clone https://github.com/pharmania/arpilabe-pilotage.git pilotage",
          token: "",
        },
      ]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reports a failure without the token it was given", () =>
  withFakeGitHubBinaries(
    { accounts: twoAccounts, activeAccount: "maxime-pharmania", failOn: "trackshop" },
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const failure = yield* driver
        .execute({
          operation: "test.clone",
          cwd: process.cwd(),
          args: ["clone", NOEXT_URL, "trackshop"],
        })
        .pipe(Effect.flip);

      expect(failure.detail).toBe("Git command exited with a non-zero status.");
      expect(String(failure)).not.toContain("token-noext");
      expect(JSON.stringify({ message: failure.message, detail: failure.detail })).not.toContain(
        "token-noext",
      );
      // The command did run as that account: only its output is reported back.
      expect(yield* gitLog()).toEqual([
        { args: `clone ${NOEXT_URL} trackshop`, token: "token-noext" },
      ]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
