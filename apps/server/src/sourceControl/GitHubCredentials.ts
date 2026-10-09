import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

/** How long a token is reused before `gh` is asked again, so a `gh auth switch` applies soon. */
const TOKEN_TTL = Duration.minutes(5);
/** No credential is retried sooner, so a fresh `gh auth login` takes effect on the next read. */
const MISSING_TTL = Duration.seconds(10);

export const GitHubCredentialSource = Schema.Literals(["settings", "env", "gh"]);
export type GitHubCredentialSource = typeof GitHubCredentialSource.Type;

export interface GitHubCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: GitHubCredentialSource;
  /** A digest of host and token: safe for cache keys and rate-limit scopes, never the token. */
  readonly fingerprint: string;
}

/** Nothing in the environment, and no `gh` on PATH to ask. */
export class GitHubCliMissingError extends Schema.TaggedError<GitHubCliMissingError>()(
  "GitHubCliMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No GitHub credential for ${this.host}: set GH_TOKEN, or install the GitHub CLI and run \`gh auth login\`.`;
  }
}

/** `gh` is installed but holds no login for the host, or not the account chosen in Settings. */
export class GitHubNotSignedInError extends Schema.TaggedError<GitHubNotSignedInError>()(
  "GitHubNotSignedInError",
  { host: Schema.String, account: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.account === undefined
      ? `No GitHub credential for ${this.host}: run \`gh auth login --hostname ${this.host}\`.`
      : `No GitHub credential for ${this.account} on ${this.host}: run \`gh auth login --hostname ${this.host}\` for that account or pick another in Settings → Source Control.`;
  }
}

/** The user turned the host off in Settings. */
export class GitHubHostDisabledError extends Schema.TaggedError<GitHubHostDisabledError>()(
  "GitHubHostDisabledError",
  { host: Schema.String },
) {
  override get message(): string {
    return `GitHub host ${this.host} is turned off in Settings → Source Control.`;
  }
}

/** `gh auth token` timed out or failed for a reason other than having no login. */
export class GitHubCliFailedError extends Schema.TaggedError<GitHubCliFailedError>()(
  "GitHubCliFailedError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The GitHub CLI could not hand over a credential for ${this.host}. Check \`gh auth status\` on the server.`;
  }
}

/** There is no token for the host. */
export type GitHubCredentialUnavailableError =
  | GitHubCliMissingError
  | GitHubNotSignedInError
  | GitHubHostDisabledError
  | GitHubCliFailedError;

export const isGitHubCredentialUnavailableError = Schema.is(
  Schema.Union([GitHubCliMissingError, GitHubNotSignedInError, GitHubHostDisabledError]),
);

/**
 * What a caller knows about the repository its work concerns. Nothing here changes where a token
 * may come from: Settings and the environment still speak first, because both are choices the user
 * made about the host itself.
 */
export interface GitHubCredentialRequest {
  /**
   * The owner of the repository the credential is for. `gh` is asked for that login before the
   * Settings choice, which is how a repository owned by a second signed-in account stays readable
   * while another account is active. An owner that is not a login — an organization — and one `gh`
   * no longer holds both fall back to the Settings choice and then to `gh`'s active login, so
   * naming an owner can only ever add a source, never remove one.
   */
  readonly account?: string | undefined;
  /**
   * Whether only that owner's own login may answer. Git asks for this: its credential helper already
   * answers as the active account, so naming that account explicitly would replace whatever else the
   * machine is configured with, and a repository owned by an organization is better left to the
   * helper. The default also accepts the Settings choice and the active login, which is what an API
   * request needs to authenticate at all.
   */
  readonly ownerOnly?: boolean;
}

/**
 * Where GitHub tokens come from. Callers ask per host, and may name the owner of the repository they
 * are about; they never see how the token was found, so another source (an in-app OAuth login)
 * slots in here without touching any of them.
 */
export class GitHubCredentials extends Context.Service<
  GitHubCredentials,
  {
    readonly get: (
      host: string,
      request?: GitHubCredentialRequest,
    ) => Effect.Effect<GitHubCredential, GitHubCredentialUnavailableError>;
    /** Drops the held token after GitHub refused it, so the next read asks its source again. */
    readonly invalidate: (host: string, request?: GitHubCredentialRequest) => Effect.Effect<void>;
  }
>()("t3/sourceControl/GitHubCredentials") {}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/** Hosts gh treats as GitHub.com-like for `GH_TOKEN`: github.com and GHE.com data residency. */
export function isGitHubDotCom(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

/**
 * The environment token for a host, in gh's precedence order. gh hands `GH_ENTERPRISE_TOKEN` to
 * any non-github.com host; here it only goes to the host `GH_HOST` names, because a remote URL
 * picks the host and a hostile one must not receive an enterprise token.
 */
export function environmentToken(
  host: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const names = isGitHubDotCom(host)
    ? ["GH_TOKEN", "GITHUB_TOKEN"]
    : env.GH_HOST?.trim().toLowerCase() === host
      ? ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
      : [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* HostProcessEnvironment;
  const workingDirectory = yield* HostProcessWorkingDirectory;

  /** `host:sha256(token)`, safe for cache keys and rate-limit scopes. */
  const fingerprintOf = (host: string, token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(
      Effect.map((digest) => `${host}:${Hex.encode(digest)}`),
      // Hashing a string in memory has no platform failure worth a typed error.
      Effect.orDie,
    );

  const fromGh = (host: string, account: string | undefined) =>
    process
      .run({
        operation: "GitHubCredentials.get",
        command: "gh",
        args: [
          "auth",
          "token",
          "--hostname",
          host,
          ...(account === undefined ? [] : ["--user", account]),
        ],
        cwd: workingDirectory,
        // Never let gh print the token into a debug log.
        env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
        timeoutMs: 10_000,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "VcsProcessSpawnError" &&
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? new GitHubCliMissingError({ host })
            : // gh exits non-zero with "no oauth token" when it has no login for the host.
              error._tag === "VcsProcessExitError"
              ? new GitHubNotSignedInError({ host, ...(account === undefined ? {} : { account }) })
              : new GitHubCliFailedError({ host, cause: error }),
        ),
        Effect.map((output) => output.stdout.trim()),
        Effect.filterOrFail(
          (token) => token !== "",
          () => new GitHubNotSignedInError({ host, ...(account === undefined ? {} : { account }) }),
        ),
      );

  /** The Settings choice for a host; unreadable settings fall back to gh's own choice. */
  const hostChoice = (host: string) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.github.hosts[host]),
      Effect.orElseSucceed(() => undefined),
    );

  /** A token saved in Settings for the host, read fresh so a saved or removed one applies at once. */
  const savedToken = (host: string) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.github.tokens[host]?.trim() || null),
      Effect.orElseSucceed(() => null),
    );

  /**
   * Cache key: the host, the login asked for and whether only that login may answer, so two logins of
   * one host — and the same login asked for strictly and loosely — never share an entry.
   */
  const cacheKey = (host: string, account: string | undefined, ownerOnly: boolean) =>
    `${host}\u0000${account ?? ""}\u0000${ownerOnly ? "owner" : "any"}`;

  /** A blank account is no account: it may not reach the cache key or `gh --user`. */
  const normalizeAccount = (account: string | undefined): string | undefined => {
    const trimmed = account?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
  };

  /**
   * A token from the first login `gh` holds one for, in the order the caller ranked them. A login `gh`
   * no longer holds is a reason to try the next one, not to fail: an owner is often an organization
   * rather than a login. A trailing `undefined` asks for `gh`'s active login, and the caller that put
   * it there is the one that decided a guess is better than no answer.
   */
  const tokenFor = (host: string, attempts: ReadonlyArray<string | undefined>) =>
    Effect.gen(function* () {
      const candidates = [
        ...new Set(attempts.filter((account) => account === undefined || account.length > 0)),
      ];
      let refusal: GitHubCredentialUnavailableError | null = null;
      for (const account of candidates) {
        const attempt = yield* fromGh(host, account).pipe(Effect.result);
        if (Result.isSuccess(attempt)) return attempt.success;
        refusal ??= attempt.failure;
      }
      // Every login was refused, so the first refusal is reported: it names the account asked for.
      return yield* Effect.fail(refusal!);
    });

  const lookup = Effect.fn("GitHubCredentials.lookup")(function* (key: string) {
    const [host = key, account, mode] = key.split("\u0000");
    // An environment token wins over a login, exactly as it does in gh.
    const fromEnv = environmentToken(host, environment);
    // The owner the caller named comes first, then the login Settings pins. `gh`'s active login is
    // the fallback for both, because an owner is often an organization rather than a login — unless
    // the caller asked for the owner's own login, which is a caller that must not replace whatever
    // authentication the machine already had.
    const token =
      fromEnv ??
      (yield* tokenFor(
        host,
        mode === "owner" ? [account] : [account, (yield* hostChoice(host))?.account, undefined],
      ));
    return {
      host,
      token: Redacted.make(token),
      source: fromEnv !== null ? "env" : "gh",
      fingerprint: yield* fingerprintOf(host, token),
    } satisfies GitHubCredential;
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 32,
    // A transient gh failure (a timeout, a locked keyring) is asked again on the next read.
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? TOKEN_TTL
        : Exit.findErrorOption(exit).pipe(
              Option.exists((error) => error._tag === "GitHubCliFailedError"),
            )
          ? Duration.zero
          : MISSING_TTL,
  });

  return GitHubCredentials.of({
    get: Effect.fn("GitHubCredentials.get")(function* (rawHost, request) {
      const host = normalizeHost(rawHost);
      const choice = yield* hostChoice(host);
      if (choice?.enabled === false) {
        return yield* new GitHubHostDisabledError({ host });
      }
      // A token saved in Settings is the most deliberate choice, so it comes before the
      // environment and gh. It is read from the secret store each time, so it needs no cache.
      const saved = yield* savedToken(host);
      if (saved !== null) {
        return {
          host,
          token: Redacted.make(saved),
          source: "settings",
          fingerprint: yield* fingerprintOf(host, saved),
        } satisfies GitHubCredential;
      }
      // The owner the caller named is more specific than the host's pin, so it is the cache key and
      // `lookup` ranks the pin behind it.
      return yield* Cache.get(
        cache,
        cacheKey(host, normalizeAccount(request?.account) ?? choice?.account, request?.ownerOnly === true),
      );
    }),
    invalidate: (rawHost, request) =>
      Effect.gen(function* () {
        const host = normalizeHost(rawHost);
        const choice = yield* hostChoice(host);
        yield* Cache.invalidate(
          cache,
          cacheKey(
            host,
            normalizeAccount(request?.account) ?? choice?.account,
            request?.ownerOnly === true,
          ),
        );
      }),
  });
});

export const layer = Layer.effect(GitHubCredentials, make);
