// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only reader for the Pi dynamic-workflows run store.
 *
 * `@quintinshaw/pi-dynamic-workflows` writes each run as JSON under
 * `~/.pi/workflows/projects/<cwd-key>/runs/<runId>.json`, progressively and
 * atomically (tmp-write + rename with a `.bak` sibling). That store is the only
 * live source of workflow progress Pi exposes: its RPC event stream has no run
 * events, and its own task panel polls this same directory. A workflow run
 * started inside a T3 thread's `pi` process is attributed back to that thread by
 * the Pi session id the run carries.
 *
 * The store belongs to another product and is versioned independently of T3, so
 * this reader treats every file as untrusted: it validates the shape, bounds
 * every string it copies out, caps the size of a read (the primary *and* the
 * `.bak` it falls back to), caches by (mtime, size, ino), and skips anything
 * that does not match. A format change degrades to "nothing shown", never to a
 * failed read that could reach a turn.
 *
 * Skipping is not the same as the run being gone, and the caller has to be able
 * to tell the two apart. `listRunsForSession` therefore also reports the run
 * ids of files it knows exist but could not read this sweep
 * (`unresolvedRunIds`: over the size cap, undecodable, a failed stat, or past
 * the sweep's own read caps). A run whose id is unresolved stays tracked
 * silently — no terminal event, no progress churn — and recovers on the first
 * sweep that reads its file again. Only a run absent from both lists is really
 * no longer there. This works because the writer names the run file after the
 * run (`<runId>.json`), so even a file that will not decode still names the run
 * it holds.
 *
 * The same distinction applies to the directory itself: only "this project has
 * no run directory" is an empty listing. A directory that exists but cannot be
 * read (permissions, I/O error, a file where the directory should be) is not
 * evidence that anything ended, so the sweep dies instead and the caller's
 * guard logs it and leaves every tracked run alone for that round.
 *
 * @module provider/pi/PiWorkflowStore
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/** Run lifecycle, mirroring the extension's `RunStatus`. */
const PiWorkflowRunStatus = Schema.Literals([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "aborted",
]);
export type PiWorkflowRunStatus = typeof PiWorkflowRunStatus.Type;

/** Per-agent lifecycle, mirroring the extension's `PersistedAgentState.status`. */
const PiWorkflowAgentStatus = Schema.Literals(["queued", "running", "done", "error", "skipped"]);
export type PiWorkflowAgentStatus = typeof PiWorkflowAgentStatus.Type;

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const PiWorkflowUsage = Schema.Struct({
  total: Schema.optional(Schema.NullOr(Schema.Finite)),
  input: Schema.optional(Schema.NullOr(Schema.Finite)),
  output: Schema.optional(Schema.NullOr(Schema.Finite)),
});

/**
 * Only the fields this feature renders are required to decode; everything else
 * is optional so a record that predates a field still reads. `runId` and
 * `status` are the floor: without them nothing can be attributed or rendered,
 * so a writer-side rename of either makes the record unreadable — which the
 * sweep reports as unresolved, never as the run having ended. Null is tolerated
 * wherever a string or list is optional, because the writer is another product.
 */
const PiWorkflowAgentRecord = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.Finite, Schema.String]))),
  label: OptionalString,
  phase: OptionalString,
  status: Schema.optional(Schema.NullOr(PiWorkflowAgentStatus)),
  model: OptionalString,
  tokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  startedAt: OptionalString,
  endedAt: OptionalString,
});

const PiWorkflowRunRecord = Schema.Struct({
  runId: Schema.String,
  workflowName: OptionalString,
  status: PiWorkflowRunStatus,
  phases: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  currentPhase: OptionalString,
  agents: Schema.optional(Schema.NullOr(Schema.Array(PiWorkflowAgentRecord))),
  sessionId: OptionalString,
  parentSessionId: OptionalString,
  error: OptionalString,
  tokenUsage: Schema.optional(Schema.NullOr(PiWorkflowUsage)),
  startedAt: OptionalString,
  updatedAt: OptionalString,
  completedAt: OptionalString,
  durationMs: Schema.optional(Schema.NullOr(Schema.Finite)),
});
type PiWorkflowRunRecord = typeof PiWorkflowRunRecord.Type;

const decodeRunRecord = Schema.decodeUnknownOption(Schema.fromJsonString(PiWorkflowRunRecord));

export interface PiWorkflowAgentSnapshot {
  readonly id: string;
  readonly label: string;
  readonly phase: string | undefined;
  readonly status: PiWorkflowAgentStatus;
  readonly model: string | undefined;
  readonly tokens: number | undefined;
  readonly startedAt: string | undefined;
  readonly endedAt: string | undefined;
}

export interface PiWorkflowRunSnapshot {
  readonly runId: string;
  readonly workflowName: string;
  readonly status: PiWorkflowRunStatus;
  readonly phases: ReadonlyArray<string>;
  readonly currentPhase: string | undefined;
  readonly agents: ReadonlyArray<PiWorkflowAgentSnapshot>;
  /**
   * Delivery owner; re-homed across an in-process fork (adoptLiveRunsToSession),
   * which is the id the writer's own navigator matches on. The reader matches on
   * `sessionId` only: `parentSessionId` is immutable lineage, and honouring it
   * would attribute a run whose delivery owner is another session to this thread.
   */
  readonly sessionId: string | undefined;
  /** Immutable parent session identity; never re-homed, never matched on. */
  readonly parentSessionId: string | undefined;
  readonly error: string | undefined;
  /** Run-level total, present only once the run completes. */
  readonly totalTokens: number | undefined;
  readonly startedAt: string | undefined;
  readonly updatedAt: string | undefined;
  readonly completedAt: string | undefined;
  readonly durationMs: number | undefined;
}

export interface PiWorkflowStoreShape {
  /**
   * One sweep of the store for `cwd`'s project directory. `runs` are the runs
   * written for a session in `sessionIds`, newest first; `unresolvedRunIds` are
   * runs known to exist (their file was listed) whose state this sweep could not
   * determine. An unreadable directory, an unreadable file, or a record that
   * does not decode leaves the affected run out of `runs`, named in
   * `unresolvedRunIds` when the store listed it, and the sweep continues. An
   * absent project directory is an empty listing; any other failure to read the
   * directory dies, because it is not evidence that the runs are gone.
   */
  readonly listRunsForSession: (input: {
    readonly cwd: string;
    readonly sessionIds: ReadonlyArray<string>;
  }) => Effect.Effect<PiWorkflowRunListing>;
}

/** The result of one sweep; see `listRunsForSession`. */
export interface PiWorkflowRunListing {
  readonly runs: ReadonlyArray<PiWorkflowRunSnapshot>;
  /**
   * Runs this sweep knows exist but could not read this time. Not evidence that
   * the run ended: a caller tracking one must keep it and stay silent.
   */
  readonly unresolvedRunIds: ReadonlyArray<string>;
}

const EMPTY_LISTING: PiWorkflowRunListing = { runs: [], unresolvedRunIds: [] };

const MAX_RUN_FILES = 400;
const MAX_RUN_BYTES = 4 * 1024 * 1024;
const MAX_MATCHED_RUNS = 50;
const MAX_AGENTS_PER_RUN = 100;
const MAX_PHASES_PER_RUN = 100;
/**
 * Longest text copied out of a record. The file-size cap bounds a record's
 * total bytes, not one field: ingestion later truncates `detail`/`summary` but
 * persists `title`/`workflowName`/labels verbatim, so an absurd name would ride
 * every activity row and every broadcast.
 */
const MAX_TEXT_LENGTH = 200;
/** The writer's run ids are a slug (≤40), a base36 timestamp, and a random tail. */
const MAX_RUN_ID_LENGTH = 200;

/**
 * The operator's workflow store (`~/.pi/workflows`), where the extension writes.
 * `HOME` is preferred over `os.homedir()` so a provider instance that overrides
 * it (the extension resolves the store from the same environment) is followed.
 */
export function defaultPiWorkflowStoreRoot(environment?: NodeJS.ProcessEnv): string {
  const configuredHome = environment?.HOME?.trim();
  return join(
    configuredHome && configuredHome.length > 0 ? configuredHome : homedir(),
    ".pi",
    "workflows",
  );
}

/**
 * The extension's project key: a sanitized cwd basename plus 12 hex of
 * sha256(resolved cwd). Kept byte-identical to `workflowProjectKey` so this
 * reader lands on the same directory the writer used.
 */
export function piWorkflowProjectKey(cwd: string): string {
  const resolved = resolve(cwd);
  const slug =
    (basename(resolved) || "project")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "project";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

const finiteNonNegative = (value: number | null | undefined): number | undefined => {
  if (value === undefined || value === null || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
};

const boundText = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length === 0) return undefined;
  return trimmed.length > MAX_TEXT_LENGTH ? trimmed.slice(0, MAX_TEXT_LENGTH) : trimmed;
};

/** The run file is `<runId>.json`; the stem names the run even if it will not decode. */
const runIdFromFileName = (fileName: string): string =>
  fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName;

const toAgentSnapshots = (record: PiWorkflowRunRecord): ReadonlyArray<PiWorkflowAgentSnapshot> => {
  const agents = record.agents ?? [];
  return agents.slice(0, MAX_AGENTS_PER_RUN).map((agent, index) => ({
    id: String(agent.id ?? index).slice(0, MAX_TEXT_LENGTH),
    label: boundText(agent.label) ?? `agent ${index + 1}`,
    phase: boundText(agent.phase),
    status: agent.status ?? "queued",
    model: boundText(agent.model),
    tokens: finiteNonNegative(agent.tokens),
    startedAt: boundText(agent.startedAt),
    endedAt: boundText(agent.endedAt),
  }));
};

/**
 * `null` when the record carries no usable run id. The id is the tracker key
 * and a `RuntimeTaskId` (`TrimmedNonEmptyString`), and `RuntimeTaskId.make`
 * *throws* on an empty one — inside the pure diff, before the tracker advances,
 * which would make every later sweep throw the same way and silence the whole
 * thread. A whitespace or empty id is therefore unreadable, not renderable.
 */
const toRunSnapshot = (record: PiWorkflowRunRecord): PiWorkflowRunSnapshot | null => {
  const runId = record.runId.trim();
  if (runId.length === 0 || runId.length > MAX_RUN_ID_LENGTH) return null;
  const workflowName = boundText(record.workflowName);
  return {
    runId,
    workflowName: workflowName ?? runId,
    status: record.status,
    phases: (record.phases ?? [])
      .slice(0, MAX_PHASES_PER_RUN)
      .map((phase) => phase.trim().slice(0, MAX_TEXT_LENGTH)),
    currentPhase: boundText(record.currentPhase),
    agents: toAgentSnapshots(record),
    sessionId: boundText(record.sessionId),
    parentSessionId: boundText(record.parentSessionId),
    error: boundText(record.error),
    totalTokens: finiteNonNegative(record.tokenUsage?.total),
    startedAt: boundText(record.startedAt),
    updatedAt: boundText(record.updatedAt),
    completedAt: boundText(record.completedAt),
    durationMs: finiteNonNegative(record.durationMs),
  };
};

export interface PiWorkflowStoreOptions {
  /** Workflow home (`~/.pi/workflows`); tests point it at a fixture root. */
  readonly homeDir: string;
}

/** The `stat` fields the sweep and the read cache both need. */
interface PiWorkflowRunFileInfo {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

export const makePiWorkflowStore = Effect.fn("makePiWorkflowStore")(function* (
  options: PiWorkflowStoreOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const semaphore = yield* Semaphore.make(1);

  // Keyed by absolute path. `ino` is load-bearing: the writer replaces the file
  // by rename, and a same-mtime same-size pair from two consecutive throttled
  // saves would otherwise read as unchanged.
  const cache = new Map<
    string,
    {
      readonly mtimeMs: number;
      readonly size: number;
      readonly ino: number;
      readonly run: PiWorkflowRunSnapshot | null;
    }
  >();

  /** `null` for anything that is not a readable file (absent, a directory, an error). */
  const statRunFile = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.map((info): PiWorkflowRunFileInfo | null => {
        const size = Number(info.size);
        if (info.type !== "File" || !Number.isFinite(size)) return null;
        return {
          size,
          mtimeMs: Option.match(info.mtime, {
            onNone: () => 0,
            onSome: (date) => date.getTime(),
          }),
          ino: Option.getOrElse(info.ino, () => 0),
        };
      }),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.succeed(null),
      ),
      Effect.orElseSucceed(() => null),
    );

  const readCandidate = (candidate: string) =>
    fileSystem.readFileString(candidate).pipe(
      Effect.map((contents) => Option.getOrNull(decodeRunRecord(contents))),
      Effect.map((record) => (record === null ? null : toRunSnapshot(record))),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.succeed(null),
      ),
      Effect.orElseSucceed(() => null),
    );

  /** Primary first, then its `.bak`; null when neither reads as a run. */
  const readRunFile = (filePath: string) =>
    Effect.gen(function* () {
      const primary = yield* readCandidate(filePath);
      if (primary) return primary;
      // The `.bak` is the previous good save, so it can be exactly as large as
      // the primary was: cap it too, or a small undecodable primary would pull a
      // multi-megabyte backup into memory on every sweep that sees it change.
      const backupInfo = yield* statRunFile(`${filePath}.bak`);
      if (backupInfo !== null && backupInfo.size <= MAX_RUN_BYTES) {
        const backup = yield* readCandidate(`${filePath}.bak`);
        if (backup) {
          yield* Effect.logDebug(
            "Pi workflow run file did not decode; served its backup instead.",
            {
              filePath,
            },
          );
          return backup;
        }
      }
      yield* Effect.logDebug("Pi workflow run file did not decode; skipping it.", { filePath });
      return null;
    });

  const readCachedRun = (filePath: string, info: PiWorkflowRunFileInfo) =>
    Effect.gen(function* () {
      if (info.size > MAX_RUN_BYTES) {
        yield* Effect.logDebug("Pi workflow run file exceeds the size cap; skipping it.", {
          filePath,
          size: info.size,
        });
        cache.delete(filePath);
        return null;
      }
      const cached = cache.get(filePath);
      if (
        cached &&
        cached.mtimeMs === info.mtimeMs &&
        cached.size === info.size &&
        cached.ino === info.ino
      ) {
        return cached.run;
      }
      const run = yield* readRunFile(filePath);
      cache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, ino: info.ino, run });
      return run;
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.succeed(null),
      ),
      Effect.orElseSucceed(() => null),
    );

  const runsDirFor = (cwd: string): string =>
    path.join(options.homeDir, "projects", piWorkflowProjectKey(path.resolve(cwd)), "runs");

  const listRunsForSession: PiWorkflowStoreShape["listRunsForSession"] = (input) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        const runsDir = runsDirFor(input.cwd);
        // A genuinely absent project directory means no workflow ever ran for
        // this cwd. Anything else — permissions, I/O error, a file where the
        // directory should be — is not evidence of absence, so it dies and the
        // caller's sweep guard leaves every tracked run alone this round.
        const entries = yield* fileSystem.readDirectory(runsDir).pipe(
          Effect.map((names): Option.Option<ReadonlyArray<string>> => Option.some(names)),
          Effect.catchIf(
            (cause) => cause.reason._tag === "NotFound",
            () => Effect.succeed(Option.none<ReadonlyArray<string>>()),
          ),
          Effect.orDie,
        );
        if (Option.isNone(entries)) return EMPTY_LISTING;

        // Select by recency, never by name: run files are
        // `<workflow-slug>-<ts36>-<rand>.json`, so a name sort keeps an
        // arbitrary alphabetical slice and can drop the runs that are actually
        // live. `mtime` is the writer's last save and the only signal that
        // keeps a long-running run at the front (the name encodes its
        // *creation* time); the name breaks ties deterministically.
        const unresolvedRunIds = new Set<string>();
        const candidates: Array<{
          readonly fileName: string;
          readonly filePath: string;
          readonly info: PiWorkflowRunFileInfo;
        }> = [];
        for (const fileName of entries.value) {
          if (!fileName.endsWith(".json")) continue;
          const filePath = path.join(runsDir, fileName);
          const info = yield* statRunFile(filePath);
          if (info === null) {
            // Listed but unreadable: it exists, so it must not read as gone.
            unresolvedRunIds.add(runIdFromFileName(fileName));
            continue;
          }
          candidates.push({ fileName, filePath, info });
        }
        candidates.sort(
          (a, b) =>
            b.info.mtimeMs - a.info.mtimeMs ||
            (a.fileName < b.fileName ? 1 : a.fileName > b.fileName ? -1 : 0),
        );
        const selected = candidates.slice(0, MAX_RUN_FILES);
        // Past the read cap we did not look, so we cannot say the run ended.
        for (const skipped of candidates.slice(MAX_RUN_FILES)) {
          unresolvedRunIds.add(runIdFromFileName(skipped.fileName));
        }

        const wanted = new Set(input.sessionIds.filter((id) => id.length > 0));
        const seen = new Set<string>();
        const runs: Array<PiWorkflowRunSnapshot> = [];
        for (const candidate of selected) {
          seen.add(candidate.filePath);
          const run = yield* readCachedRun(candidate.filePath, candidate.info);
          if (run === null) {
            unresolvedRunIds.add(runIdFromFileName(candidate.fileName));
            continue;
          }
          // `sessionId` only: it is the run's delivery owner, which the writer
          // re-homes on a fork and which its own navigator matches on.
          if (run.sessionId !== undefined && wanted.has(run.sessionId)) runs.push(run);
        }

        // A file that vanished (pruned, deleted, renamed) must not pin a stale
        // parse in the cache for the process lifetime.
        for (const key of cache.keys()) {
          if (key.startsWith(runsDir) && !seen.has(key)) cache.delete(key);
        }

        const ordered = runs.sort((a, b) => {
          const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
          const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
          return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
        });
        // Matches past the return cap were read and matched, but the caller will
        // not see them: dropping them silently would look like the run ended, so
        // report them as unresolved instead.
        for (const dropped of ordered.slice(MAX_MATCHED_RUNS)) {
          unresolvedRunIds.add(dropped.runId);
        }
        return {
          runs: ordered.slice(0, MAX_MATCHED_RUNS),
          unresolvedRunIds: [...unresolvedRunIds],
        };
      }),
    );

  return { listRunsForSession } satisfies PiWorkflowStoreShape;
});
