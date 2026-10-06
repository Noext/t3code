import * as NodeCrypto from "node:crypto";

import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { parseGitHubAuthStatus, type GitHubAuthStatusAccount } from "./gitHubAuthStatus.ts";

/** Server-local credential for one signed-in account; never put its value in RPC payloads or cache keys. */
export interface GitHubCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly credentialFingerprint: string;
}

/** `owner/name`, `host/owner/name`, or a repository URL all name the same owner. */
export function repositoryOwner(reference: string | undefined): string | null {
  if (reference === undefined) return null;
  const trimmed = reference.trim().replace(/\.git$/i, "");
  if (trimmed.length === 0 || trimmed.startsWith("-")) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).pathname.split("/").find((segment) => segment.length > 0) ?? null;
    } catch {
      return null;
    }
  }
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 2) return segments[0]!;
  if (segments.length === 3) return segments[1]!;
  return null;
}

/**
 * Host and owner of a repository URL a token can authenticate to, or null for any other location.
 * Only `https` is answered: that is the scheme a credential helper is registered for, so ssh and
 * local paths authenticate some other way and a token would change nothing.
 */
export function httpsRepositoryCoordinates(
  url: string,
): { readonly host: string; readonly owner: string } | null {
  if (!/^https:\/\//i.test(url)) return null;
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
  const owner = repositoryOwner(url);
  return owner === null || host.length === 0 ? null : { host, owner };
}

/**
 * Environment for a child process that must act as this account. `GH_DEBUG` is cleared because
 * `gh` prints request headers, and with them the token, under debug output.
 */
export function gitHubCredentialEnvironment(credential: GitHubCredential): NodeJS.ProcessEnv {
  const token = Redacted.value(credential.token);
  return {
    GH_HOST: credential.host,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GH_ENTERPRISE_TOKEN: token,
    GITHUB_ENTERPRISE_TOKEN: token,
    GH_DEBUG: "",
  };
}

export class GitHubAccountCredential extends Context.Service<
  GitHubAccountCredential,
  {
    /**
     * The credential of the account signed in to `host` that owns `owner`, or null when no signed-in
     * account matches. Null is how every failure is reported, including a broken `gh`: the caller
     * then authenticates as it did before this resolution existed, and the command it was about to
     * run reports its own outcome.
     */
    readonly resolveForOwner: (input: {
      readonly host: string;
      readonly owner: string;
    }) => Effect.Effect<GitHubCredential | null>;
  }
>()("t3/sourceControl/GitHubAccountCredential") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;

  const accountTtl = Duration.minutes(5);

  /** `gh` reports every signed-in host at once, so one cached answer covers the machine. */
  const ghAccounts = yield* Cache.makeWith(
    () =>
      process
        .run({
          operation: "GitHubAccountCredential.authAccounts",
          command: "gh",
          args: ["auth", "status", "--json", "hosts"],
          cwd: globalThis.process.cwd(),
          env: { GH_PROMPT_DISABLED: "1", GH_DEBUG: "" },
          allowNonZeroExit: true,
          timeoutMs: 10_000,
          maxOutputBytes: 32_000,
        })
        .pipe(
          Effect.map((output) =>
            parseGitHubAuthStatus(output.stdout).accounts.filter(
              (account) => account.authenticated,
            ),
          ),
          // A missing or too-old `gh` is not this layer's error to report: the command that
          // follows reports it with the message callers already handle.
          Effect.orElseSucceed((): ReadonlyArray<GitHubAuthStatusAccount> => []),
        ),
    {
      capacity: 1,
      // An empty answer is usually a transient or unsupported `gh`, so retry it soon.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.length > 0 ? accountTtl : Duration.seconds(30),
    },
  );

  const ghAccountTokens = yield* Cache.makeWith(
    (key: string) => {
      const [host, login] = key.split("\0") as [string, string];
      return process
        .run({
          operation: "GitHubAccountCredential.authToken",
          command: "gh",
          args: ["auth", "token", "--hostname", host, "--user", login],
          cwd: globalThis.process.cwd(),
          env: { GH_PROMPT_DISABLED: "1", GH_DEBUG: "" },
          allowNonZeroExit: true,
          timeoutMs: 10_000,
          maxOutputBytes: 4_096,
        })
        .pipe(
          Effect.map(authTokenFromOutput),
          Effect.orElseSucceed((): Redacted.Redacted<string> | null => null),
        );
    },
    {
      capacity: 32,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? accountTtl : Duration.zero,
    },
  );

  const resolveForOwner: GitHubAccountCredential["Service"]["resolveForOwner"] = Effect.fn(
    "GitHubAccountCredential.resolveForOwner",
  )(function* (input) {
    const host = input.host.toLowerCase();
    const owner = input.owner.toLowerCase();
    const accounts = yield* Cache.get(ghAccounts, "hosts");
    const login = accounts.find(
      (account) => account.host === host && account.account.toLowerCase() === owner,
    )?.account;
    if (login === undefined) return null;
    const token = yield* Cache.get(ghAccountTokens, `${host}\0${login}`);
    if (token === null) return null;
    return {
      host,
      token,
      // The fingerprint format is shared with `GitHubPullRequestCli` so that rate limits and viewer
      // identity agree on what "the same credential" means.
      credentialFingerprint: `${host}:${NodeCrypto.createHash("sha256").update(Redacted.value(token)).digest("hex")}`,
    } satisfies GitHubCredential;
  });

  return GitHubAccountCredential.of({ resolveForOwner });
});

/** `gh auth token` writes the bare token; an error line or an empty answer is not a credential. */
function authTokenFromOutput(
  output: VcsProcess.VcsProcessOutput,
): Redacted.Redacted<string> | null {
  if (output.exitCode !== 0) return null;
  const token = output.stdout.trim();
  return token.length > 0 ? Redacted.make(token) : null;
}

export const layer = Layer.effect(GitHubAccountCredential, make);
