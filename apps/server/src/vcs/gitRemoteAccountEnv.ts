import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { GitHubCredentials, isGitHubDotCom } from "../sourceControl/GitHubCredentials.ts";

/**
 * Subcommands that can send a request to a remote repository. Local reads (`status`, `rev-parse`,
 * `diff`, …) never consult a credential helper, so resolving an account for them would only add
 * work to the hottest commands in the server. Submodule commands are absent on purpose: each
 * submodule is a repository with its own owner.
 */
const REMOTE_SUBCOMMANDS: ReadonlySet<string> = new Set(["clone", "fetch", "pull", "push"]);

/**
 * Global options that take the argument after them. Skipping them keeps a value such as
 * `--git-dir /repo` from being read as the subcommand.
 */
const GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
  "--attr-source",
]);

export interface GitRemoteCommand {
  readonly subcommand: string;
  /**
   * Arguments after the subcommand that are not options. Option values stay in this list, which is
   * safe because a value is only read as a remote when it is a URL or a configured remote name:
   * `--depth 1` can be mistaken for neither.
   */
  readonly operands: ReadonlyArray<string>;
}

/** The subcommand and operands of a git command that can reach a remote, or null when it cannot. */
export function gitRemoteCommand(args: ReadonlyArray<string>): GitRemoteCommand | null {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    // Any other option is global and valueless here, including `--git-dir=/repo` and `-c key=value`.
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = args[index];
  if (subcommand === undefined || !REMOTE_SUBCOMMANDS.has(subcommand)) return null;
  return {
    subcommand,
    operands: args.slice(index + 1).filter((arg) => !arg.startsWith("-")),
  };
}

/** True for a token git reads as a repository location: a scheme URL or the `user@host:path` form. */
export function isRepositoryUrl(token: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(token) || /^[^\s/@]+@[^\s/:]+:/.test(token);
}

/**
 * Host and owner of a repository URL a token can authenticate to, or null for any other location.
 * Only `https` is answered: that is the scheme a credential helper is registered for, so ssh and
 * local paths authenticate some other way and a token would change nothing.
 */
export function httpsRepositoryOwner(
  url: string,
): { readonly host: string; readonly owner: string } | null {
  if (!/^https:\/\//i.test(url)) return null;
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return host.length === 0 || segments.length < 2 ? null : { host, owner: segments[0]! };
}

/** The remote the command names, or the one its repository only has one owner for. */
function remoteUrlFor(
  operands: ReadonlyArray<string>,
  remoteUrls: ReadonlyMap<string, string>,
): string | null {
  const named = operands.find((operand) => remoteUrls.has(operand));
  if (named !== undefined) return remoteUrls.get(named) ?? null;
  // No operand names a remote, so git picks one from the branch. That is only unambiguous when
  // every remote this repository has is an https repository owned by the same account on the same
  // host; anything else keeps the account git would have used anyway.
  const urls = [...new Set(remoteUrls.values())];
  const coordinates = urls.map(httpsRepositoryOwner);
  if (coordinates.length === 0 || coordinates.includes(null)) return null;
  const resolved = coordinates.map((value) => value!);
  const hosts = new Set(resolved.map((value) => value.host));
  const owners = new Set(resolved.map((value) => value.owner.toLowerCase()));
  return hosts.size === 1 && owners.size === 1 ? urls[0]! : null;
}

/**
 * The token variables a credential helper reads for `host`, following the same rule as
 * `environmentToken`: only a GitHub.com-like host is handed `GH_TOKEN`, and an enterprise token is
 * never given to a host the URL chose for itself. `GH_DEBUG` is cleared because `gh` prints request
 * headers, and with them the token, under debug output.
 */
export function credentialEnvironment(host: string, token: string): NodeJS.ProcessEnv {
  if (isGitHubDotCom(host)) return { GH_DEBUG: "", GH_TOKEN: token, GITHUB_TOKEN: token };
  return {
    GH_DEBUG: "",
    GH_HOST: host,
    GH_ENTERPRISE_TOKEN: token,
    GITHUB_ENTERPRISE_TOKEN: token,
  };
}

/**
 * The environment a git process needs to reach the repository it was asked for through the account
 * that owns it.
 *
 * Git authenticates through a credential helper, and the helper `gh auth setup-git` installs always
 * answers as the account active in `gh`. A repository owned by a second signed-in account therefore
 * looks missing. `GH_TOKEN` makes the helper use that account for this process only: it switches no
 * account — a global mutation that would corrupt a command running for the other owner — and writes
 * no credential into a git config file.
 *
 * Everything unresolved yields an empty environment: the command then runs with the account the
 * machine is already using, exactly as it did before.
 */
export const gitRemoteAccountEnv = Effect.fn("gitRemoteAccountEnv")(function* (input: {
  readonly args: ReadonlyArray<string>;
  /** Reads the repository's configured remotes; the caller owns spawning git, so it supplies this. */
  readonly readRemoteUrls: () => Effect.Effect<ReadonlyMap<string, string>>;
}) {
  const command = gitRemoteCommand(input.args);
  if (command === null) return {};
  let url = command.operands.find(isRepositoryUrl) ?? null;
  if (url === null) {
    url = remoteUrlFor(command.operands, yield* input.readRemoteUrls());
  }
  if (url === null) return {};
  const coordinates = httpsRepositoryOwner(url);
  if (coordinates === null) return {};
  const credentials = yield* GitHubCredentials;
  const token = yield* credentials
    // Owner only: the active login is what the helper answers as anyway, so naming it would replace
    // whatever else this machine configured rather than add an account.
    .get(coordinates.host, { account: coordinates.owner, ownerOnly: true })
    .pipe(
      Effect.map((credential) => Redacted.value(credential.token)),
      // Every failure is reported as no account: the command then authenticates as it did before
      // this resolution existed, and reports its own outcome, which is the error worth reading.
      Effect.orElseSucceed(() => null),
    );
  return token === null ? {} : credentialEnvironment(coordinates.host, token);
});
