import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Cache from "effect/Cache";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessSpawnError, type VcsError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubAccountCredential from "./GitHubAccountCredential.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

const encodeGitHubCliError = Schema.encodeEffect(Schema.fromJsonString(GitHubCli.GitHubCliError));

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const quotaOutput = (remaining = 5000, resetAt = "2099-01-01T00:00:00Z") =>
  processOutput(
    JSON.stringify({ data: { rateLimit: { cost: 1, limit: 5000, remaining, resetAt } } }),
  );

const isAuthStatusProbe = (args: ReadonlyArray<string>): boolean =>
  args[0] === "auth" && args[1] === "status";
const isAuthTokenProbe = (args: ReadonlyArray<string>): boolean =>
  args[0] === "auth" && args[1] === "token";
const isQuotaProbe = (args: ReadonlyArray<string>): boolean =>
  args[0] === "api" && args[1] === "rate_limit";

/**
 * Answers the account probes `GitHubCli` runs for itself with a machine that has no account signed
 * in, so a test only observes the command under test. `undefined` means "this is a real command".
 */
const signedOutProbeOutput = (
  input: VcsProcess.VcsProcessInput,
): VcsProcess.VcsProcessOutput | undefined => {
  if (isAuthStatusProbe(input.args)) return processOutput(JSON.stringify({ hosts: {} }));
  return isAuthTokenProbe(input.args)
    ? { ...processOutput(""), exitCode: ChildProcessSpawner.ExitCode(1) }
    : undefined;
};

const mockRun = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>();

const layer = GitHubCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess.VcsProcess)({
      run: (input) => {
        const probe = signedOutProbeOutput(input);
        if (probe !== undefined) return Effect.succeed(probe);
        return isQuotaProbe(input.args) ? Effect.succeed(quotaOutput()) : mockRun(input);
      },
    }),
  ),
);

afterEach(() => {
  mockRun.mockReset();
});

it.effect("shares quota checks, preserves the reserve, and resumes after reset", () =>
  Effect.gen(function* () {
    let probes = 0;
    const commands: string[] = [];
    let remaining = 501;
    let resetAt = DateTime.formatIso(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 60_000),
    );
    const gh = yield* GitHubCli.make.pipe(
      Effect.provide(GitHubAccountCredential.layer),
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) =>
          Effect.sync(() => {
            if (input.args[1] === "rate_limit") {
              probes++;
              assert.strictEqual(input.args[3], "enterprise.test");
              return quotaOutput(remaining, resetAt);
            }
            const probe = signedOutProbeOutput(input);
            if (probe !== undefined) return probe;
            commands.push(input.args.slice(0, 2).join(" "));
            return processOutput("[]");
          }),
      }),
    );
    const read = (command: string) =>
      gh.execute({
        cwd: "/repo",
        args:
          command === "repo"
            ? ["repo", "view", "enterprise.test/acme/web", "--json", "name"]
            : ["pr", command, "--repo=enterprise.test/acme/web", "--json", "number"],
      });
    yield* read("list");
    const failure = yield* read("view").pipe(Effect.flip);
    assert.strictEqual(failure._tag, "GitHubCliRateLimitError");
    assert.strictEqual(probes, 1);
    assert.deepStrictEqual(commands, ["pr list"]);
    yield* read("view").pipe(Effect.provideService(GitHubCli.AllowGitHubReserve, true));
    yield* gh.execute({ cwd: "/repo", args: ["pr", "merge", "1"] });
    assert.deepStrictEqual(commands, ["pr list", "pr view", "pr merge"]);
    remaining = 0;
    yield* TestClock.adjust("30 seconds");
    yield* read("repo").pipe(Effect.flip);
    assert.strictEqual(probes, 2);
    yield* TestClock.adjust("30 seconds");
    remaining = 5000;
    resetAt = DateTime.formatIso(DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 60_000));
    yield* Effect.all([read("list"), read("repo")], { concurrency: 2 });
    assert.strictEqual(probes, 3);
    assert.deepStrictEqual(commands.slice(3).toSorted(), ["pr list", "repo view"]);
  }).pipe(Effect.provide(Layer.merge(GitHubGraphQlBudget.layer, SourceControlRateLimit.layer))),
);

describe("GitHubCli.layer", () => {
  it.effect("shares the registry budget with CLI reads through nested layer providers", () =>
    Effect.gen(function* () {
      const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
      const gh = yield* GitHubCli.GitHubCli;
      yield* budget.observe("github.com", quotaOutput(0).stdout);
      const error = yield* gh.execute({ cwd: "/repo", args: ["pr", "list"] }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubCliRateLimitError");
      expect(mockRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer.pipe(Layer.provide(GitHubGraphQlBudget.layer)))),
  );

  it.effect("keeps quota snapshots separate for verified credentials on the same host", () =>
    Effect.gen(function* () {
      let reads = 0;
      const gh = yield* GitHubCli.make.pipe(
        Effect.provide(GitHubAccountCredential.layer),
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            Effect.sync(() => {
              if (input.args[1] === "rate_limit")
                return quotaOutput(input.env?.GH_TOKEN === "empty" ? 0 : 5000);
              const probe = signedOutProbeOutput(input);
              if (probe !== undefined) return probe;
              reads++;
              return processOutput("[]");
            }),
        }),
      );
      const read = (token: string) =>
        gh.execute({ cwd: "/repo", args: ["pr", "list", "--repo", "github.com/acme/web"] }).pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.com",
            token: Redacted.make(token),
            credentialFingerprint: token,
          }),
        );
      yield* read("empty").pipe(Effect.flip);
      yield* read("healthy");
      yield* read("empty").pipe(Effect.flip);
      assert.strictEqual(reads, 1);
    }).pipe(Effect.provide(Layer.merge(GitHubGraphQlBudget.layer, SourceControlRateLimit.layer))),
  );

  it.effect("pins concurrent cached commands to their own verified credentials", () =>
    Effect.gen(function* () {
      mockRun.mockImplementation((input) =>
        Effect.succeed(processOutput(input.env?.GH_TOKEN ?? "ambient")),
      );
      const gh = yield* GitHubCli.GitHubCli;
      // Constructed outside either request, like the PR service's read caches.
      const cache = yield* Cache.make({
        lookup: (host: string) =>
          gh.execute({
            cwd: "/repo",
            args: ["api", "user", "--hostname", host],
            env: { GH_DEBUG: "api", GH_TOKEN: "changed-after-verification" },
          }),
        capacity: 2,
        timeToLive: "1 minute",
      });
      const results = yield* Effect.all(
        ["github.com", "github.example.test"].map((host, index) =>
          Cache.get(cache, host).pipe(
            Effect.provideService(GitHubCli.PinnedGitHubCredential, {
              host,
              token: Redacted.make(`credential-${index}`),
              credentialFingerprint: `fingerprint-${index}`,
            }),
          ),
        ),
        { concurrency: 2 },
      );
      expect(results.map((result) => result.stdout)).toEqual(["credential-0", "credential-1"]);
      for (const [input] of mockRun.mock.calls) {
        expect(input.env).toMatchObject({
          GH_HOST: input.args[3],
          GH_DEBUG: "",
          GH_TOKEN: input.env?.GITHUB_TOKEN,
          GH_ENTERPRISE_TOKEN: input.env?.GH_TOKEN,
          GITHUB_ENTERPRISE_TOKEN: input.env?.GH_TOKEN,
        });
      }
      expect((yield* gh.execute({ cwd: "/repo", args: ["api", "user"] })).stdout).toBe("ambient");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses other or implicit hosts before exposing a scoped credential to gh", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubCli.GitHubCli;
      for (const args of [
        ["api", "user", "--hostname", "other.example.test"],
        ["api", "user", "--hostname=other.example.test"],
        ["pr", "view", "1", "--repo", "other.example.test/owner/repo"],
        ["repo", "view", "other.example.test/owner/repo", "--json", "name"],
        ["api", "https://other.example.test/user", "--hostname", "github.com"],
        ["api", "user"],
      ]) {
        const failure = yield* gh.execute({ cwd: "/repo", args }).pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.com",
            token: Redacted.make("secret-credential"),
            credentialFingerprint: "fingerprint",
          }),
          Effect.flip,
        );
        expect(failure._tag).toBe("GitHubCliCommandError");
        expect(yield* encodeGitHubCliError(failure)).not.toContain("secret-credential");
      }
      expect(mockRun).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("pins repository-targeted writes on enterprise hosts", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValue(Effect.succeed(processOutput("")));
      const gh = yield* GitHubCli.GitHubCli;
      yield* gh
        .execute({
          cwd: "/repo",
          args: ["pr", "merge", "1", "--repo", "github.example.test/owner/repo"],
        })
        .pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.example.test",
            token: Redacted.make("enterprise-credential"),
            credentialFingerprint: "fingerprint",
          }),
        );
      yield* gh
        .execute({
          cwd: "/repo",
          args: ["repo", "view", "github.example.test/owner/repo", "--json", "name"],
        })
        .pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: "github.example.test",
            token: Redacted.make("enterprise-credential"),
            credentialFingerprint: "fingerprint",
          }),
        );
      expect(mockRun.mock.calls[0]?.[0].env).toMatchObject({
        GH_HOST: "github.example.test",
        GH_ENTERPRISE_TOKEN: "enterprise-credential",
        GH_DEBUG: "",
      });
    }).pipe(Effect.provide(layer)),
  );

  it("does not classify a missing cwd as an unavailable gh executable", () => {
    const context = { command: "gh", cwd: "/repo" } as const;
    const missingCwd = new VcsProcessSpawnError({
      operation: "GitHubCli.execute",
      command: "gh",
      cwd: context.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "access",
        pathOrDescriptor: context.cwd,
      }),
    });

    const commandFailure = GitHubCli.fromVcsError(context, missingCwd);

    assert.equal(commandFailure._tag, "GitHubCliCommandError");
    assert.strictEqual(commandFailure.cause, missingCwd);
    assert.notProperty(commandFailure, "operation");
  });

  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "Add PR thread creation",
              url: "https://github.com/pingdotgg/codething-mvp/pull/42",
              baseRefName: "main",
              headRefName: "feature/pr-threads",
              state: "OPEN",
              isDraft: true,
              mergedAt: null,
              updatedAt: "2026-08-24T12:34:56Z",
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: "octocat/codething-mvp",
              },
              headRepositoryOwner: {
                login: "octocat",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        closedAt: null,
        mergedAt: null,
        isDraft: true,
        updatedAt: "2026-08-24T12:34:56.000Z",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "GitHubCli.execute",
        command: "gh",
        args: [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("trims pull request fields decoded from gh json", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              number: 42,
              title: "  Add PR thread creation  \n",
              url: " https://github.com/pingdotgg/codething-mvp/pull/42 ",
              baseRefName: " main ",
              headRefName: "\tfeature/pr-threads\t",
              state: "OPEN",
              mergedAt: null,
              isCrossRepository: true,
              headRepository: {
                nameWithOwner: " octocat/codething-mvp ",
              },
              headRepositoryOwner: {
                login: " octocat ",
              },
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        closedAt: null,
        mergedAt: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("skips invalid entries when parsing pr lists", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 0,
                title: "invalid",
                url: "https://github.com/pingdotgg/codething-mvp/pull/0",
                baseRefName: "main",
                headRefName: "feature/invalid",
              },
              {
                number: 43,
                title: "  Valid PR  ",
                url: " https://github.com/pingdotgg/codething-mvp/pull/43 ",
                baseRefName: " main ",
                headRefName: " feature/pr-list ",
                headRepository: {
                  nameWithOwner: "   ",
                },
                headRepositoryOwner: {
                  login: "   ",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "feature/pr-list",
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/43",
          baseRefName: "main",
          headRefName: "feature/pr-list",
          state: "open",
          closedAt: null,
          mergedAt: null,
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps pull requests from gh versions without headRepository.nameWithOwner", () =>
    // gh < 2.47 (e.g. Ubuntu-packaged 2.46) exports headRepository as
    // {id, name} only. These entries must decode instead of being dropped,
    // with nameWithOwner rebuilt from the owner login.
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 2829,
                title: "Codex turn mapping",
                url: "https://github.com/pingdotgg/codething-mvp/pull/2829",
                baseRefName: "main",
                headRefName: "t3code/codex-turn-mapping",
                state: "OPEN",
                mergedAt: null,
                isCrossRepository: false,
                headRepository: {
                  id: "R_kgDORLtfbQ",
                  name: "codething-mvp",
                },
                headRepositoryOwner: {
                  id: "MDEyOk9yZ2FuaXphdGlvbjg5MTkxNzI3",
                  login: "pingdotgg",
                },
              },
            ]),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.listOpenPullRequests({
        cwd: "/repo",
        headSelector: "t3code/codex-turn-mapping",
      });

      assert.deepStrictEqual(result, [
        {
          number: 2829,
          title: "Codex turn mapping",
          url: "https://github.com/pingdotgg/codething-mvp/pull/2829",
          baseRefName: "main",
          headRefName: "t3code/codex-turn-mapping",
          state: "open",
          closedAt: null,
          mergedAt: null,
          isCrossRepository: false,
          headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
          headRepositoryOwnerLogin: "pingdotgg",
        },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              nameWithOwner: "octocat/codething-mvp",
              url: "https://github.com/octocat/codething-mvp",
              sshUrl: "git@github.com:octocat/codething-mvp.git",
            }),
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories and parses clone URLs from create output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            "✓ Created repository octocat/codething-mvp on github.com\nhttps://github.com/octocat/codething-mvp\n",
          ),
        ),
      );

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenNthCalledWith(1, {
        operation: "GitHubCli.execute",
        command: "gh",
        args: ["repo", "create", "octocat/codething-mvp", "--private"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("falls back to constructed URLs when create output omits a URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const gh = yield* GitHubCli.GitHubCli;
      const result = yield* gh.createRepository({
        cwd: "/repo",
        repository: "octocat/codething-mvp",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitHubCli.execute",
        command: "gh pr view",
        cwd: "/repo",
        exitCode: 1,
        failureKind: "not-found",
        detail:
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .getPullRequest({
          cwd: "/repo",
          reference: "4888",
        })
        .pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
      assert.strictEqual(error._tag, "GitHubPullRequestNotFoundError");
      assert.strictEqual(error.command, "gh");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes(cause.detail), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("surfaces an actionable rate-limit error without exposing provider stderr", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "GitHubCli.execute",
        command: "gh",
        cwd: "/repo",
        exitCode: 1,
        failureKind: "rate-limited",
        detail: "API rate limit exceeded.",
        stderrLength: 82,
        stderrTruncated: false,
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const gh = yield* GitHubCli.GitHubCli;
      const error = yield* gh
        .listOpenPullRequests({
          cwd: "/repo",
          headSelector: "feature/rate-limited",
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "GitHubCliRateLimitError");
      assert.include(error.detail, "GitHub API rate limit exceeded");
      assert.include(error.detail, "gh api rate_limit");
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, "user ID");
      const paused = yield* gh
        .execute({ cwd: "/other-repo", args: ["pr", "list"] })
        .pipe(Effect.flip);
      assert.strictEqual(paused._tag, "GitHubCliRateLimitError");
      expect(mockRun).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust("30 seconds");
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("[]")));
      yield* gh.execute({ cwd: "/other-repo", args: ["pr", "list"] });
      expect(mockRun).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer)),
  );
});

interface FakeGitHubAccount {
  readonly login: string;
  readonly token?: string;
  readonly active?: boolean;
}

/**
 * A `gh` with several accounts signed in on github.com. `onCommand` stands in for the command
 * under test and receives the environment the layer built for it.
 */
const fakeGitHub = (
  accounts: ReadonlyArray<FakeGitHubAccount>,
  onCommand: (
    input: VcsProcess.VcsProcessInput,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError> = () =>
    Effect.succeed(processOutput("{}")),
) => {
  const calls: Array<VcsProcess.VcsProcessInput> = [];
  const service: VcsProcess.VcsProcess["Service"] = {
    run: (input) => {
      calls.push(input);
      if (isAuthStatusProbe(input.args)) {
        return Effect.succeed(
          processOutput(
            JSON.stringify({
              hosts: {
                "github.com": accounts.map((account) => ({
                  state: "success",
                  active: account.active ?? false,
                  host: "github.com",
                  login: account.login,
                })),
              },
            }),
          ),
        );
      }
      if (isAuthTokenProbe(input.args)) {
        const login = input.args[input.args.indexOf("--user") + 1];
        const token = accounts.find((account) => account.login === login)?.token;
        return Effect.succeed(
          token === undefined
            ? { ...processOutput(""), exitCode: ChildProcessSpawner.ExitCode(1) }
            : processOutput(token),
        );
      }
      if (isQuotaProbe(input.args)) return Effect.succeed(quotaOutput());
      return onCommand(input);
    },
  };
  const isProbe = (call: VcsProcess.VcsProcessInput) =>
    isAuthStatusProbe(call.args) || isAuthTokenProbe(call.args) || isQuotaProbe(call.args);
  return {
    service,
    /** Real commands, without the layer's own auth and quota probes. */
    commands: () => calls.filter((call) => !isProbe(call)),
    tokenProbes: () => calls.filter((call) => isAuthTokenProbe(call.args)),
    authCommands: () => calls.filter((call) => call.args[0] === "auth"),
  };
};

const accountLayer = (service: VcsProcess.VcsProcess["Service"]) =>
  GitHubCli.layer.pipe(Layer.provide(Layer.mock(VcsProcess.VcsProcess)(service)));

const cloneUrlOutput = (input: VcsProcess.VcsProcessInput) =>
  Effect.succeed(
    processOutput(
      JSON.stringify({
        nameWithOwner: input.args[2] ?? "unknown/repository",
        url: `https://github.com/${input.args[2] ?? "unknown/repository"}`,
        sshUrl: `git@github.com:${input.args[2] ?? "unknown/repository"}.git`,
      }),
    ),
  );

const credentialsByRepository = (commands: ReadonlyArray<VcsProcess.VcsProcessInput>) =>
  commands.map((call) => [call.args[2], call.env?.GH_TOKEN ?? null]);

describe("GitHubCli account resolution", () => {
  it.effect("pins concurrent reads to the account that owns each repository", () => {
    const gh = fakeGitHub(
      [
        { login: "Noext", token: "token-noext" },
        { login: "maxime-pharmania", token: "token-maxime", active: true },
      ],
      cloneUrlOutput,
    );
    return Effect.gen(function* () {
      const cli = yield* GitHubCli.GitHubCli;
      yield* Effect.all(
        [
          cli.getRepositoryCloneUrls({ cwd: "/repo", repository: "Noext/trackshop" }),
          cli.getRepositoryCloneUrls({ cwd: "/repo", repository: "maxime-pharmania/arpilabe" }),
          // An organization the active account can read is not an account name: it must keep the
          // ambient account instead of borrowing another account's token.
          cli.getRepositoryCloneUrls({ cwd: "/repo", repository: "pharmania/arpilabe-pilotage" }),
        ],
        { concurrency: 3 },
      );

      expect(credentialsByRepository(gh.commands()).toSorted()).toEqual([
        ["Noext/trackshop", "token-noext"],
        ["maxime-pharmania/arpilabe", "token-maxime"],
        ["pharmania/arpilabe-pilotage", null],
      ]);
      // Switching the active account is a global mutation that would make the other call wrong.
      expect(gh.authCommands().every((call) => call.args[1] !== "switch")).toBe(true);
    }).pipe(Effect.provide(accountLayer(gh.service)));
  });

  it.effect("leaves an owner that is not signed in on the ambient account", () => {
    const gh = fakeGitHub(
      [{ login: "maxime-pharmania", token: "token-maxime", active: true }],
      cloneUrlOutput,
    );
    return Effect.gen(function* () {
      const cli = yield* GitHubCli.GitHubCli;
      yield* cli.getRepositoryCloneUrls({ cwd: "/repo", repository: "unknown/other" });

      expect(credentialsByRepository(gh.commands())).toEqual([["unknown/other", null]]);
    }).pipe(Effect.provide(accountLayer(gh.service)));
  });

  it.effect("matches owners without regard to case and caches their token", () => {
    const gh = fakeGitHub([{ login: "Noext", token: "token-noext" }], cloneUrlOutput);
    return Effect.gen(function* () {
      const cli = yield* GitHubCli.GitHubCli;
      yield* cli.getRepositoryCloneUrls({ cwd: "/repo", repository: "noext/trackshop" });
      yield* cli.getRepositoryCloneUrls({ cwd: "/repo", repository: "NOEXT/trackshop" });

      expect(credentialsByRepository(gh.commands())).toEqual([
        ["noext/trackshop", "token-noext"],
        ["NOEXT/trackshop", "token-noext"],
      ]);
      // One status read and one token read serve both calls.
      expect(gh.tokenProbes()).toHaveLength(1);
      expect(gh.tokenProbes()[0]?.args).toEqual([
        "auth",
        "token",
        "--hostname",
        "github.com",
        "--user",
        "Noext",
      ]);
    }).pipe(Effect.provide(accountLayer(gh.service)));
  });

  it.effect("reads the owner from every repository selector gh accepts", () => {
    const gh = fakeGitHub([{ login: "Noext", token: "token-noext" }]);
    return Effect.gen(function* () {
      const cli = yield* GitHubCli.GitHubCli;
      for (const args of [
        ["repo", "view", "Noext/trackshop"],
        ["pr", "view", "1", "--repo", "Noext/trackshop"],
        ["pr", "view", "1", "--repo=Noext/trackshop"],
        ["pr", "view", "1", "-RNoext/trackshop"],
        ["pr", "view", "https://github.com/Noext/trackshop/pull/1"],
        ["api", "repos/Noext/trackshop/issues/1"],
      ]) {
        yield* cli.execute({ cwd: "/repo", args });
      }

      expect(gh.commands().map((call) => call.env?.GH_TOKEN)).toEqual(
        Array.from({ length: 6 }, () => "token-noext"),
      );
    }).pipe(Effect.provide(accountLayer(gh.service)));
  });

  it.effect("pays for no account probe when a command names no repository", () => {
    const gh = fakeGitHub([{ login: "Noext", token: "token-noext" }], () =>
      Effect.succeed(processOutput("[]")),
    );
    return Effect.gen(function* () {
      const cli = yield* GitHubCli.GitHubCli;
      yield* cli.listOpenPullRequests({ cwd: "/repo", headSelector: "feature/account-resolution" });

      expect(gh.authCommands()).toHaveLength(0);
      expect(gh.commands()[0]?.env).toBeUndefined();
    }).pipe(Effect.provide(accountLayer(gh.service)));
  });

  it.effect("falls back to the ambient account when gh cannot produce a token", () => {
    const cause = new VcsProcessExitError({
      operation: "GitHubCli.execute",
      command: "gh",
      cwd: "/repo",
      exitCode: 1,
      failureKind: "not-found",
      detail: "GraphQL: Could not resolve to a Repository with the name 'Noext/trackshop'.",
    });
    const gh = fakeGitHub(
      [{ login: "Noext" }, { login: "maxime-pharmania", token: "token-maxime", active: true }],
      () => Effect.fail(cause),
    );
    return Effect.gen(function* () {
      const cli = yield* GitHubCli.GitHubCli;
      const failure = yield* cli
        .getRepositoryCloneUrls({ cwd: "/repo", repository: "Noext/trackshop" })
        .pipe(Effect.flip);

      expect(gh.commands()[0]?.env).toBeUndefined();
      // The command's own outcome reaches the caller instead of a resolution error.
      expect(failure._tag).toBe("GitHubPullRequestNotFoundError");
      const encoded = yield* encodeGitHubCliError(failure);
      expect(encoded).not.toContain("token-maxime");
      expect(encoded).not.toContain("token-noext");
    }).pipe(Effect.provide(accountLayer(gh.service)));
  });

  it.effect("keeps a pinned credential scoped to its host while owners override it", () => {
    const gh = fakeGitHub([{ login: "Noext", token: "token-noext" }]);
    return Effect.gen(function* () {
      const cli = yield* GitHubCli.GitHubCli;
      const pinned = {
        host: "github.com",
        token: Redacted.make("token-pinned"),
        credentialFingerprint: "pinned-fingerprint",
      };
      const view = (args: ReadonlyArray<string>) =>
        cli
          .execute({ cwd: "/repo", args })
          .pipe(Effect.provideService(GitHubCli.PinnedGitHubCredential, pinned));

      // The pinned account cannot read another owner's repository, so that owner's token wins.
      yield* view(["pr", "view", "1", "--repo", "github.com/Noext/trackshop"]);
      // A repository no signed-in account owns keeps the credential the caller verified.
      yield* view(["pr", "view", "1", "--repo", "github.com/other/repository"]);
      expect(gh.commands().map((call) => call.env?.GH_TOKEN)).toEqual([
        "token-noext",
        "token-pinned",
      ]);

      const callsBefore = gh.commands().length;
      const failure = yield* view([
        "pr",
        "view",
        "1",
        "--repo",
        "other.example.test/other/repo",
      ]).pipe(Effect.flip);
      expect(failure._tag).toBe("GitHubCliCommandError");
      expect(gh.commands()).toHaveLength(callsBefore);
    }).pipe(Effect.provide(accountLayer(gh.service)));
  });
});
