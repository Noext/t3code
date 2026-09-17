/**
 * PiSkills — filesystem discovery of Pi skills for the `$` picker.
 *
 * Pi resolves skills from `~/.pi/agent/skills` and `~/.agents/skills` (user),
 * and from `<cwd>/.pi/skills` plus `.agents/skills` in `cwd` and its ancestor
 * directories up to the git repo root (project). The RPC `get_commands`
 * catalog reports skills too, but only when skill commands are enabled, so the
 * snapshot scans the same roots Pi's resolver reads instead.
 *
 * The per-root rules mirror that resolver: a directory holding `SKILL.md` is
 * one skill and is not descended into; a root `.md` file counts in a `.pi`
 * skills root, while in `.agents/skills` only nested `.md` files do and root
 * files are ignored. A file is only a skill when its frontmatter carries a
 * non-empty description, and its name is the frontmatter `name` (Pi allows it
 * to differ from the directory) or the containing directory's basename.
 *
 * Pi loads project skills only after the folder is trusted. Resolving that
 * decision means reading Pi's trust store, which is out of scope here, so the
 * scan lists what is on disk and Pi decides at launch.
 *
 * @module provider/Drivers/PiSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const PI_CONFIG_DIR_NAME = ".pi";
/**
 * Pi follows symlinked skill directories, so a cycle is possible. Depth and
 * entry budgets keep a hostile or accidental link graph from scanning the
 * whole filesystem.
 */
const MAX_SKILL_DEPTH = 6;
const MAX_SKILL_BYTES = 1_000_000;
const MAX_SKILL_SCAN_ENTRIES = 10_000;

/** The directories Pi reads skills from, and how each treats root `.md` files. */
export interface PiSkillRoot {
  readonly directory: string;
  readonly scope: "user" | "project";
  readonly rootFiles: boolean;
}

interface PiSkillScanBudget {
  remainingEntries: number;
  exhausted: boolean;
  incomplete: boolean;
}

interface PiSkillFrontmatter {
  readonly name?: string;
  readonly description: string;
  readonly userInvocationOnly?: boolean;
}

export class PiSkillsProbeError extends Schema.TaggedError<PiSkillsProbeError>()(
  "PiSkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    cwd: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Pi skill discovery${location} was incomplete (${this.reason}).`;
  }
}

/**
 * Parse the frontmatter Pi requires before it will load a skill. A file
 * without frontmatter, with unparseable YAML, or without a description is not
 * a skill: Pi warns and skips it, so surfacing it would offer a dead entry.
 */
function parsePiSkillFrontmatter(contents: string): PiSkillFrontmatter | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!description) return undefined;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  return {
    description,
    ...(name ? { name } : {}),
    ...(record["disable-model-invocation"] === true ? { userInvocationOnly: true } : {}),
  };
}

const readIfPresent = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  budget: PiSkillScanBudget,
): Effect.Effect<A | undefined, never, R> =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchTags({
      PlatformError: (error) => {
        if (error.reason._tag !== "NotFound") budget.incomplete = true;
        return Effect.succeed(undefined);
      },
    }),
  );

/**
 * The home directory Pi expands `~` against, matching `os.homedir()` in the
 * launch environment: `HOME` on POSIX, `USERPROFILE` on Windows.
 */
function resolvePiUserHome(environment: NodeJS.ProcessEnv): string {
  return environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
}

/** Pi's config directory, honoring the documented `PI_CODING_AGENT_DIR`. */
function resolvePiAgentDir(path: Path.Path, environment: NodeJS.ProcessEnv): string {
  const override = environment.PI_CODING_AGENT_DIR?.trim();
  return override
    ? path.resolve(override)
    : path.join(resolvePiUserHome(environment), PI_CONFIG_DIR_NAME, "agent");
}

function findGitRepoRoot(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  start: string,
): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    let directory = path.resolve(start);
    for (;;) {
      const hasGit = yield* fileSystem
        .exists(path.join(directory, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasGit) return directory;
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  });
}

const projectRoots = Effect.fn("projectPiSkillRoots")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<PiSkillRoot>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedCwd = path.resolve(cwd);
  const roots: PiSkillRoot[] = [
    {
      directory: path.join(resolvedCwd, PI_CONFIG_DIR_NAME, "skills"),
      scope: "project",
      rootFiles: true,
    },
  ];
  // `.pi/skills` is only read from `cwd`, but `.agents/skills` is read from
  // `cwd` up to the git repo root (or the filesystem root outside a repo).
  const userAgentsSkills = path.join(resolvePiUserHome(environment), ".agents", "skills");
  const gitRepoRoot = yield* findGitRepoRoot(fileSystem, path, resolvedCwd);
  let directory = resolvedCwd;
  for (;;) {
    const agentsSkills = path.join(directory, ".agents", "skills");
    if (path.resolve(agentsSkills) !== path.resolve(userAgentsSkills)) {
      roots.push({ directory: agentsSkills, scope: "project", rootFiles: false });
    }
    if (gitRepoRoot === directory) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return roots;
});

/** Every root Pi would read for `cwd`, in Pi's precedence order. */
export const piSkillRoots = Effect.fn("piSkillRoots")(function* (
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<PiSkillRoot>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const userHome = resolvePiUserHome(environment);
  const userRoots: ReadonlyArray<PiSkillRoot> = [
    {
      directory: path.join(resolvePiAgentDir(path, environment), "skills"),
      scope: "user",
      rootFiles: true,
    },
    { directory: path.join(userHome, ".agents", "skills"), scope: "user", rootFiles: false },
  ];
  if (!cwd) return userRoots;
  return [...(yield* projectRoots(cwd, environment)), ...userRoots];
});

const loadPiSkill = Effect.fn("loadPiSkill")(function* (input: {
  readonly filePath: string;
  readonly scope: "user" | "project";
  readonly budget: PiSkillScanBudget;
}): Effect.fn.Return<ServerProviderSkill | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* readIfPresent(fileSystem.stat(input.filePath), input.budget);
  if (info?.type !== "File" || info.size > MAX_SKILL_BYTES) return undefined;
  const contents = yield* readIfPresent(fileSystem.readFileString(input.filePath), input.budget);
  if (contents === undefined) return undefined;

  const frontmatter = parsePiSkillFrontmatter(contents);
  if (!frontmatter) return undefined;
  // Pi falls back to the containing directory's name, which is the skill
  // directory for `SKILL.md` and the skills root for a root-level `.md` file.
  const name = frontmatter.name ?? path.basename(path.dirname(input.filePath));
  if (!name) return undefined;
  return {
    name,
    path: input.filePath,
    scope: input.scope,
    enabled: true,
    description: frontmatter.description,
    ...(frontmatter.userInvocationOnly ? { userInvocationOnly: true } : {}),
  };
});

const discoverSkillsInRoot = Effect.fn("discoverPiSkillsInRoot")(function* (input: {
  readonly root: PiSkillRoot;
  readonly budget: PiSkillScanBudget;
  readonly visited: Set<string>;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: ServerProviderSkill[] = [];

  const visit = Effect.fn("visitPiSkillDirectory")(function* (
    directory: string,
    depth: number,
  ): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
    if (input.budget.exhausted) return;
    const resolved = yield* readIfPresent(fileSystem.realPath(directory), input.budget);
    if (!resolved || input.visited.has(resolved)) return;
    input.visited.add(resolved);

    const entries = yield* readIfPresent(fileSystem.readDirectory(directory), input.budget);
    if (!entries) return;

    // A directory holding a `SKILL.md` is exactly one skill; Pi does not walk
    // into it, so its reference markdown is never mistaken for more skills.
    if (entries.includes("SKILL.md")) {
      if (input.budget.remainingEntries === 0) {
        input.budget.exhausted = true;
        return;
      }
      input.budget.remainingEntries -= 1;
      const skill = yield* loadPiSkill({
        filePath: path.join(directory, "SKILL.md"),
        scope: input.root.scope,
        budget: input.budget,
      });
      if (skill) skills.push(skill);
      return;
    }

    for (const entry of [...entries].sort()) {
      if (input.budget.remainingEntries === 0) {
        input.budget.exhausted = true;
        return;
      }
      input.budget.remainingEntries -= 1;
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const child = path.join(directory, entry);
      const info = yield* readIfPresent(fileSystem.stat(child), input.budget);
      if (info?.type === "Directory") {
        if (depth >= MAX_SKILL_DEPTH) {
          input.budget.exhausted = true;
          return;
        }
        yield* visit(child, depth + 1);
        continue;
      }
      // Root files count in `.pi` skills roots; in `.agents/skills` only
      // nested markdown is a skill.
      const isSkillLevelFile = depth === 0 ? input.root.rootFiles : true;
      if (info?.type !== "File" || !isSkillLevelFile || !entry.endsWith(".md")) continue;
      const skill = yield* loadPiSkill({
        filePath: child,
        scope: input.root.scope,
        budget: input.budget,
      });
      if (skill) skills.push(skill);
    }
  });

  yield* visit(input.root.directory, 0);
  return skills;
});

export const discoverPiSkills = Effect.fn("discoverPiSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  PiSkillsProbeError,
  FileSystem.FileSystem | Path.Path
> {
  const roots = yield* piSkillRoots(cwd, environment);
  const budget: PiSkillScanBudget = {
    remainingEntries: MAX_SKILL_SCAN_ENTRIES,
    exhausted: false,
    incomplete: false,
  };
  // First name wins, matching Pi: project roots are read before user roots.
  const skillsByName = new Map<string, ServerProviderSkill>();
  const visited = new Set<string>();
  for (const root of roots) {
    if (budget.exhausted) break;
    const found = yield* discoverSkillsInRoot({ root, budget, visited });
    for (const skill of found) {
      if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
    }
  }
  if (budget.exhausted) {
    return yield* new PiSkillsProbeError({
      reason: "scan-budget-exhausted",
      ...(cwd ? { cwd } : {}),
    });
  }
  if (budget.incomplete) {
    return yield* new PiSkillsProbeError({ reason: "filesystem-error", ...(cwd ? { cwd } : {}) });
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
