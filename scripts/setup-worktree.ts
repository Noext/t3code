// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Worktree setup, run by the t3.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell T3 Code spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies, links the main checkout's gitignored env files into this
 * worktree, then warms the web dependency cache.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// `.env` is required: it carries the dev credentials every worktree's dev server
// needs, so a worktree without it is broken even though it looks ready. The
// relay's `infra/relay/.env` is optional on purpose: the relay is a separate
// deployment and most machines (including this one) never create that file, so
// its absence must not fail a worktree setup.
const REQUIRED_ENV_FILES = [".env"];
const OPTIONAL_ENV_FILES = [NodePath.join("infra", "relay", ".env")];
const ENV_FILES = [...REQUIRED_ENV_FILES, ...OPTIONAL_ENV_FILES];

// `statSync` follows symlinks, so a link whose source vanished is not readable.
const isReadableFile = (path: string): boolean =>
  NodeFS.statSync(path, { throwIfNoEntry: false })?.isFile() === true;

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
}
const worktree = NodePath.dirname(import.meta.dirname);

// `shell` resolves `vp` through PATH, including Windows command shims.
const install = NodeChildProcess.spawnSync("vp i", {
  cwd: worktree,
  shell: true,
  stdio: "inherit",
});
if (install.status !== 0) process.exit(install.status ?? 1);

// Env files live as real files in the main checkout; worktrees only get
// symlinks to them. Only a symlink is ever replaced, so a real env file is
// never deleted, including when this runs in the main checkout itself.
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  // Running this in the main checkout itself makes `source` and `target` the
  // same file: the `rmSync` + `symlinkSync` below would then replace the real
  // env file with a symlink to itself. That link resolves to nothing, and the
  // `isFile()` check above reports it as "not a regular file" for every later
  // worktree — so each one silently got no env file at all.
  if (NodePath.resolve(source) === NodePath.resolve(target)) continue;
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}

// The link loop above is best-effort, so a required env file that never arrived
// left a worktree indistinguishable from a ready one. Check readability from the
// worktree now: a missing source, a source that is not a regular file, and a
// broken symlink all land here as "not readable".
const missingEnvFiles = REQUIRED_ENV_FILES.filter(
  (file) => !isReadableFile(NodePath.join(worktree, file)),
);
if (missingEnvFiles.length > 0) {
  process.stderr.write(
    `Setup worktree failed: ${missingEnvFiles.join(", ")} is not readable from ${worktree}.\n` +
      `Worktree env files are symlinks into the main checkout ${projectRoot}, which does not expose ` +
      `${missingEnvFiles.join(", ")} as a regular file.\n` +
      `Recreate it in the main checkout (\`make poste\` in the infra repo, or restore the file by hand), ` +
      `then re-run the worktree setup (t3.json "Setup Worktree", or \`node scripts/setup-worktree.ts\` with T3CODE_PROJECT_ROOT set).\n`,
  );
  process.exit(1);
}

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
