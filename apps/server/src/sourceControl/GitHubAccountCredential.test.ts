import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubAccountCredential from "./GitHubAccountCredential.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const isAuthStatusProbe = (args: ReadonlyArray<string>): boolean =>
  args[0] === "auth" && args[1] === "status";
const isAuthTokenProbe = (args: ReadonlyArray<string>): boolean =>
  args[0] === "auth" && args[1] === "token";

interface FakeGitHubAccount {
  readonly login: string;
  readonly token?: string;
  readonly active?: boolean;
}

/** A `gh` with the given accounts signed in on github.com. */
const fakeGitHub = (accounts: ReadonlyArray<FakeGitHubAccount>) => {
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
      return Effect.die(`unexpected gh command: ${input.args.join(" ")}`);
    },
  };
  return {
    service,
    tokenProbes: () => calls.filter((call) => isAuthTokenProbe(call.args)),
  };
};

const layer = (service: VcsProcess.VcsProcess["Service"]) =>
  GitHubAccountCredential.layer.pipe(Layer.provide(Layer.mock(VcsProcess.VcsProcess)(service)));

it.effect("resolves the account that owns a repository and caches its token", () => {
  const gh = fakeGitHub([
    { login: "Noext", token: "token-noext" },
    { login: "maxime-pharmania", token: "token-maxime", active: true },
  ]);
  return Effect.gen(function* () {
    const accounts = yield* GitHubAccountCredential.GitHubAccountCredential;
    const first = yield* accounts.resolveForOwner({ host: "github.com", owner: "noext" });
    const second = yield* accounts.resolveForOwner({ host: "github.com", owner: "NOEXT" });

    assert.strictEqual(Redacted.value(first!.token), "token-noext");
    assert.strictEqual(Redacted.value(second!.token), "token-noext");
    // The active account is irrelevant: the owner decides, and the answer is asked for once.
    expect(gh.tokenProbes().map((call) => call.args)).toEqual([
      ["auth", "token", "--hostname", "github.com", "--user", "Noext"],
    ]);
  }).pipe(Effect.provide(layer(gh.service)));
});

it.effect("answers null for an owner no signed-in account owns", () => {
  const gh = fakeGitHub([{ login: "maxime-pharmania", token: "token-maxime", active: true }]);
  return Effect.gen(function* () {
    const accounts = yield* GitHubAccountCredential.GitHubAccountCredential;
    // An organization the active account can read is not an account name.
    const credential = yield* accounts.resolveForOwner({
      host: "github.com",
      owner: "pharmania",
    });

    assert.strictEqual(credential, null);
    expect(gh.tokenProbes()).toEqual([]);
  }).pipe(Effect.provide(layer(gh.service)));
});

it.effect("answers null instead of failing when gh cannot produce a token", () => {
  const cause = new VcsProcessExitError({
    operation: "GitHubAccountCredential.authToken",
    command: "gh",
    cwd: "/repo",
    exitCode: 1,
    failureKind: "authentication",
    detail: "gh auth token failed.",
  });
  const failing: VcsProcess.VcsProcess["Service"] = {
    run: (input) =>
      isAuthTokenProbe(input.args)
        ? Effect.fail(cause)
        : Effect.succeed(
            processOutput(
              JSON.stringify({
                hosts: {
                  "github.com": [
                    { state: "success", active: true, host: "github.com", login: "Noext" },
                  ],
                },
              }),
            ),
          ),
  };
  return Effect.gen(function* () {
    const accounts = yield* GitHubAccountCredential.GitHubAccountCredential;
    const credential = yield* accounts.resolveForOwner({ host: "github.com", owner: "Noext" });

    assert.strictEqual(credential, null);
  }).pipe(Effect.provide(layer(failing)));
});

it.effect("answers null when gh is not installed at all", () => {
  const missing: VcsProcess.VcsProcess["Service"] = {
    run: () =>
      Effect.fail(
        new VcsProcessSpawnError({
          operation: "probe",
          command: "gh",
          cwd: "/repo",
          argumentCount: 0,
          cause: new Error("not found"),
        }),
      ),
  };
  return Effect.gen(function* () {
    const accounts = yield* GitHubAccountCredential.GitHubAccountCredential;
    const credential = yield* accounts.resolveForOwner({ host: "github.com", owner: "Noext" });

    assert.strictEqual(credential, null);
  }).pipe(Effect.provide(layer(missing)));
});

it.effect("keeps the token out of anything that prints the credential", () => {
  const gh = fakeGitHub([{ login: "Noext", token: "token-noext" }]);
  return Effect.gen(function* () {
    const accounts = yield* GitHubAccountCredential.GitHubAccountCredential;
    const credential = (yield* accounts.resolveForOwner({ host: "github.com", owner: "Noext" }))!;

    // The value only ever leaves through `Redacted.value`, so the ways a token usually escapes
    // (interpolation, JSON in a log line) carry a placeholder instead.
    assert.strictEqual(String(credential.token), "<redacted>");
    expect(JSON.stringify(credential)).not.toContain("token-noext");
    expect(credential.credentialFingerprint).not.toContain("token-noext");
  }).pipe(Effect.provide(layer(gh.service)));
});
