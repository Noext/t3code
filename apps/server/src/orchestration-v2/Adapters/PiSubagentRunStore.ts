// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only reader for `pi-subagents`' detached async run state.
 *
 * The extension writes one directory per run under a process-scoped temp root:
 *
 *   `<tempRoot>/async-subagent-runs/<runId>/status.json`   snapshot, rewritten as
 *                                                          the run progresses
 *   `<tempRoot>/async-subagent-runs/<runId>/workflow-children.jsonl`
 *                                                          append-only child journal
 *
 * `status.json` is the live source. It carries the run's `mode`, `state`, its
 * `steps` (one per workflow lane, each with its own agent, status, duration and
 * token usage) and the owning parent session, which is what lets a run be
 * attributed to the T3 thread whose Pi process launched it: every thread of a
 * provider instance shares one temp root, so the directory alone cannot separate
 * two sessions' runs.
 *
 * Only `mode: "workflow"` directories become cards. A workflow run also writes
 * one directory per child (`mode: "single"`), and those children are already
 * `steps` of the workflow: reading them as runs would put the same work on screen
 * twice, once as the card's members and once as unrelated cards. A standalone
 * `{ agent, task }` launch is a `single` run with no workflow around it, and it
 * stays invisible here because the thread's own tool result already shows it.
 *
 * The format belongs to another product and is versioned independently of T3, so
 * every record is untrusted: the file is schema-checked, every string and number
 * copied out is bounded, and any failure is reported as an *unresolved* run.
 * Unresolved is not the same as gone — a run the reader cannot read this sweep
 * stays tracked upstream and emits nothing — so a format change degrades to
 * "nothing shown", never to a false terminal state.
 *
 * @module orchestration-v2/Adapters/PiSubagentRunStore
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  finiteNonNegative,
  type PiWorkflowAgentSnapshot,
  type PiWorkflowAgentStatus,
  type PiWorkflowRunListing,
  type PiWorkflowRunSnapshot,
  type PiWorkflowRunStatus,
  type PiWorkflowStoreShape,
} from "./PiWorkflowStore.ts";

/** The extension's own override for its temp root; honoured so both land together. */
const TEMP_ROOT_ENV = "PI_SUBAGENTS_TEMP_ROOT";
/** Directory the extension creates inside its temp root. */
const ASYNC_RUNS_DIRNAME = "async-subagent-runs";

const EMPTY_LISTING: PiWorkflowRunListing = { runs: [], unresolvedRunIds: [] };

const MAX_RUN_DIRECTORIES = 400;
const MAX_RUN_BYTES = 4 * 1024 * 1024;
const MAX_MATCHED_RUNS = 50;
const MAX_LANES_PER_RUN = 100;
/** Longest text copied out of a record; see the note in `PiWorkflowStore`. */
const MAX_TEXT_LENGTH = 200;
const MAX_RUN_ID_LENGTH = 200;

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalFinite = Schema.optional(Schema.NullOr(Schema.Finite));

const SubagentRunUsage = Schema.Struct({
  total: OptionalFinite,
  input: OptionalFinite,
  output: OptionalFinite,
});

/**
 * One lane of a workflow run. Every field is optional because the writer's lane
 * record has grown over time; `status` is the only one a card needs, and a lane
 * that lost it reads as still running rather than as finished.
 */
const SubagentRunStep = Schema.Struct({
  label: OptionalString,
  workflowKey: OptionalString,
  agent: OptionalString,
  sessionName: OptionalString,
  status: OptionalString,
  startedAt: OptionalFinite,
  durationMs: OptionalFinite,
  tokens: Schema.optional(Schema.NullOr(SubagentRunUsage)),
  runId: OptionalString,
  error: OptionalString,
});
type SubagentRunStep = typeof SubagentRunStep.Type;

const SubagentRunRecord = Schema.Struct({
  runId: Schema.String,
  /** `workflow` for a fan-out run, `single` for a child or a direct launch. */
  mode: OptionalString,
  state: OptionalString,
  /** Path of the session that launched the run, not a bare id; see below. */
  sessionId: OptionalString,
  startedAt: OptionalFinite,
  lastUpdate: OptionalFinite,
  steps: Schema.optional(Schema.NullOr(Schema.Array(SubagentRunStep))),
  /** Presence only: the trace itself belongs to the extension's own renderer. */
  workflow: Schema.optional(Schema.NullOr(Schema.Unknown)),
  error: OptionalString,
});
type SubagentRunRecord = typeof SubagentRunRecord.Type;

const decodeRunRecord = Schema.decodeUnknownOption(Schema.fromJsonString(SubagentRunRecord));

/**
 * A run directory is a card only when the writer says it is a workflow. The same
 * root also holds one directory per child (`mode: "single"`) and per direct
 * `{ agent, task }` launch, which the thread's own tool result already shows.
 * `workflow` presence is the fallback for a record written before `mode` existed.
 */
const isWorkflowRun = (record: SubagentRunRecord): boolean =>
  record.mode?.trim().toLowerCase() === "workflow" ||
  (record.workflow !== undefined && record.workflow !== null);

/**
 * The writer's run states, one per lifecycle point. Unknown states read as
 * `running`: a card that shows a run as still working is recoverable, one that
 * announces a finish the writer never announced is not.
 */
const RUN_STATUS_BY_STATE: Readonly<Record<string, PiWorkflowRunStatus>> = {
  queued: "pending",
  pending: "pending",
  running: "running",
  complete: "completed",
  completed: "completed",
  failed: "failed",
  error: "failed",
  stopped: "aborted",
  aborted: "aborted",
};

const LANE_STATUS_BY_STEP: Readonly<Record<string, PiWorkflowAgentStatus>> = {
  queued: "queued",
  pending: "queued",
  running: "running",
  complete: "done",
  completed: "done",
  done: "done",
  failed: "error",
  error: "error",
  stopped: "error",
  aborted: "error",
  cancelled: "error",
  skipped: "skipped",
};

const boundText = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return trimmed.slice(0, MAX_TEXT_LENGTH);
};

/**
 * The writer stamps epoch milliseconds. `DateTime.make` is the safe constructor:
 * a value outside the representable range yields nothing instead of throwing, so
 * a corrupt stamp costs one missing field rather than the whole sweep.
 */
const isoFromEpochMs = (value: number | undefined): string | undefined => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Option.match(DateTime.make(value), {
    onNone: () => undefined,
    onSome: (dateTime) => DateTime.formatIso(dateTime),
  });
};

/**
 * The writer records the *file path* of the session that launched the run, and a
 * Pi session file is `<sessionDir>/<timestamp>_<sessionId>.jsonl`. T3 matches on
 * the id Pi hands out over RPC (`get_state.sessionId`), so the path is reduced to
 * that id. A value that is already a bare id passes through unchanged, which keeps
 * this reader working if the writer ever starts storing the id.
 */
export function piSessionIdFromRunSession(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const lastSeparator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = lastSeparator >= 0 ? trimmed.slice(lastSeparator + 1) : trimmed;
  const withoutExtension = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  const underscore = withoutExtension.lastIndexOf("_");
  const candidate = underscore >= 0 ? withoutExtension.slice(underscore + 1) : withoutExtension;
  const cleaned = candidate.trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** The writer's temp scope: uid first, then the login name, then the home path. */
const sanitizeScopeSegment = (value: string): string => {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "unknown";
};

const tempScopeId = (environment: NodeJS.ProcessEnv): string => {
  const getuid = process.getuid?.bind(process);
  if (typeof getuid === "function") return `uid-${getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"]) {
    const value = environment[key]?.trim();
    if (value !== undefined && value.length > 0) return `user-${sanitizeScopeSegment(value)}`;
  }
  const home = NodeOS.homedir();
  return home.length > 0 ? `home-${sanitizeScopeSegment(home)}` : "shared";
};

/**
 * Root of the extension's detached async runs, byte-identical to the directory
 * the writer picks: the same env override, the same temp directory, the same
 * uid-scoped folder name. `TMPDIR` is read through `node:os`'s `tmpdir()` on
 * purpose, since that is what the extension's own call resolves.
 */
export function defaultPiSubagentRunsRoot(environment?: NodeJS.ProcessEnv): string {
  const configured = environment?.[TEMP_ROOT_ENV]?.trim();
  const tempRoot =
    configured !== undefined && configured.length > 0
      ? NodePath.resolve(configured)
      : NodePath.join(NodeOS.tmpdir(), `pi-subagents-${tempScopeId(environment ?? process.env)}`);
  return NodePath.join(tempRoot, ASYNC_RUNS_DIRNAME);
}

const toLanes = (record: SubagentRunRecord): ReadonlyArray<PiWorkflowAgentSnapshot> => {
  const steps = record.steps ?? [];
  const lanes: Array<PiWorkflowAgentSnapshot> = [];
  for (const [index, step] of steps.slice(0, MAX_LANES_PER_RUN).entries()) {
    const label = boundText(step.label ?? step.workflowKey ?? step.agent ?? step.sessionName);
    const startedAt = finiteNonNegative(step.startedAt);
    const durationMs = finiteNonNegative(step.durationMs);
    lanes.push({
      id: boundText(step.runId ?? step.workflowKey) ?? String(index + 1),
      label: label ?? `lane ${index + 1}`,
      // Each lane is its own phase: the rail then reads as the run's parallelism
      // instead of implying an order the writer never promised.
      phase: label,
      status: LANE_STATUS_BY_STEP[step.status?.trim().toLowerCase() ?? ""] ?? "running",
      model: undefined,
      tokens: finiteNonNegative(step.tokens?.total),
      startedAt: isoFromEpochMs(startedAt),
      endedAt:
        startedAt !== undefined && durationMs !== undefined
          ? isoFromEpochMs(startedAt + durationMs)
          : undefined,
    });
  }
  return lanes;
};

const toRunSnapshot = (record: SubagentRunRecord): PiWorkflowRunSnapshot | null => {
  const runId = record.runId.trim();
  if (runId.length === 0 || runId.length > MAX_RUN_ID_LENGTH) return null;
  const lanes = toLanes(record);
  const status = RUN_STATUS_BY_STATE[record.state?.trim().toLowerCase() ?? ""] ?? "running";
  const startedAt = finiteNonNegative(record.startedAt);
  const updatedAt = finiteNonNegative(record.lastUpdate);
  const settled = status === "completed" || status === "failed" || status === "aborted";
  const laneTokens = lanes
    .map((lane) => lane.tokens)
    .filter((tokens): tokens is number => tokens !== undefined);
  return {
    runId,
    // The writer names neither its workflow nor its run, so the card is titled by
    // the id the operator already sees in the launch receipt.
    workflowName: `subagents ${runId.slice(0, 8)}`,
    status,
    // Positional phases, one per lane, in the order the writer started them.
    phases: lanes.flatMap((lane) => (lane.phase === undefined ? [] : [lane.phase])),
    currentPhase: lanes.find((lane) => lane.status === "running")?.phase,
    agents: lanes,
    sessionId: piSessionIdFromRunSession(record.sessionId),
    parentSessionId: undefined,
    error: boundText(record.error),
    totalTokens:
      settled && laneTokens.length > 0 ? laneTokens.reduce((a, b) => a + b, 0) : undefined,
    startedAt: isoFromEpochMs(startedAt),
    updatedAt: isoFromEpochMs(updatedAt),
    completedAt: settled ? isoFromEpochMs(updatedAt) : undefined,
    durationMs:
      settled && startedAt !== undefined && updatedAt !== undefined && updatedAt >= startedAt
        ? updatedAt - startedAt
        : undefined,
  };
};

export interface PiSubagentRunStoreOptions {
  /** Runs root (`<tempRoot>/async-subagent-runs`); tests point it at a fixture. */
  readonly runsRoot: string;
}

/** The `stat` fields the sweep and the read cache both need. */
/** What one read of a run directory means; the three cases must not be conflated. */
type StatusRead =
  | { readonly kind: "run"; readonly run: PiWorkflowRunSnapshot }
  /** A readable record for a child or direct launch: not a card, not a problem. */
  | { readonly kind: "not-a-workflow-run" }
  /** Listed but unreadable or undecodable this sweep: never evidence of an end. */
  | { readonly kind: "unreadable" };

const UNREADABLE: StatusRead = { kind: "unreadable" };
const NOT_A_WORKFLOW_RUN: StatusRead = { kind: "not-a-workflow-run" };

interface RunStatusFileInfo {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

export const makePiSubagentRunStore = Effect.fn("makePiSubagentRunStore")(function* (
  options: PiSubagentRunStoreOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const semaphore = yield* Semaphore.make(1);

  // Keyed by absolute path. `ino` is load-bearing: the writer replaces
  // `status.json` by rename, so a same-mtime same-size pair would otherwise read
  // as unchanged and freeze a card on a state the run has left.
  const cache = new Map<
    string,
    {
      readonly mtimeMs: number;
      readonly size: number;
      readonly ino: number;
      readonly read: StatusRead;
    }
  >();

  /** `null` for anything that is not a readable file (absent, a directory, an error). */
  const statStatusFile = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.map((info): RunStatusFileInfo | null => {
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

  const readStatusFile = (filePath: string): Effect.Effect<StatusRead> =>
    fileSystem.readFileString(filePath).pipe(
      Effect.map((contents) => Option.getOrNull(decodeRunRecord(contents))),
      Effect.map((record): StatusRead => {
        if (record === null) return UNREADABLE;
        if (!isWorkflowRun(record)) return NOT_A_WORKFLOW_RUN;
        const run = toRunSnapshot(record);
        return run === null ? UNREADABLE : { kind: "run", run };
      }),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.succeed(UNREADABLE),
      ),
      Effect.orElseSucceed(() => UNREADABLE),
    );

  const readCachedRun = (filePath: string, info: RunStatusFileInfo): Effect.Effect<StatusRead> =>
    Effect.gen(function* () {
      if (info.size > MAX_RUN_BYTES) {
        yield* Effect.logDebug("Pi subagent run file exceeds the size cap; skipping it.", {
          filePath,
          size: info.size,
        });
        cache.delete(filePath);
        return UNREADABLE;
      }
      const cached = cache.get(filePath);
      if (
        cached &&
        cached.mtimeMs === info.mtimeMs &&
        cached.size === info.size &&
        cached.ino === info.ino
      ) {
        return cached.read;
      }
      const read = yield* readStatusFile(filePath);
      cache.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, ino: info.ino, read });
      return read;
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.succeed(UNREADABLE),
      ),
      Effect.orElseSucceed(() => UNREADABLE),
    );

  const listRunsForSession: PiWorkflowStoreShape["listRunsForSession"] = (input) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        // `cwd` is deliberately unused: unlike the operator's workflow store, the
        // extension's temp root is scoped to the *process*, not to a project, and
        // attribution happens on the launching session id.
        const runDirectories = yield* fileSystem.readDirectory(options.runsRoot).pipe(
          Effect.asSome,
          Effect.catchIf(
            (cause) => cause.reason._tag === "NotFound",
            () => Effect.succeed(Option.none<ReadonlyArray<string>>()),
          ),
          Effect.orDie,
        );
        if (Option.isNone(runDirectories)) return EMPTY_LISTING;

        // Select by recency, never by name: directory names are random run ids,
        // so a name sort keeps an arbitrary alphabetical slice and can drop the
        // runs that are actually live. `mtime` is the writer's last save and the
        // only signal that keeps a long-running run at the front.
        const unresolvedRunIds = new Set<string>();
        const candidates: Array<{
          readonly runId: string;
          readonly filePath: string;
          readonly info: RunStatusFileInfo;
        }> = [];
        for (const entry of runDirectories.value) {
          const filePath = NodePath.join(options.runsRoot, entry, "status.json");
          const info = yield* statStatusFile(filePath);
          if (info === null) {
            // A run directory with no readable status file is only unresolved
            // when something is there: a missing one is a run that never started.
            const listed = yield* statStatusFile(NodePath.join(options.runsRoot, entry));
            if (listed !== null) unresolvedRunIds.add(entry.slice(0, MAX_RUN_ID_LENGTH));
            continue;
          }
          candidates.push({ runId: entry, filePath, info });
        }
        candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || (a.runId < b.runId ? 1 : -1));
        const selected = candidates.slice(0, MAX_RUN_DIRECTORIES);
        // Past the read cap we did not look, so we cannot say the run ended.
        for (const skipped of candidates.slice(MAX_RUN_DIRECTORIES)) {
          unresolvedRunIds.add(skipped.runId);
        }

        const wanted = new Set(input.sessionIds.filter((id) => id.length > 0));
        const seen = new Set<string>();
        const runs: Array<PiWorkflowRunSnapshot> = [];
        for (const candidate of selected) {
          seen.add(candidate.filePath);
          const read = yield* readCachedRun(candidate.filePath, candidate.info);
          if (read.kind === "unreadable") {
            unresolvedRunIds.add(candidate.runId);
            continue;
          }
          if (read.kind === "not-a-workflow-run") continue;
          // `sessionId` only: it is the delivery owner T3 matches on.
          if (read.run.sessionId !== undefined && wanted.has(read.run.sessionId)) {
            runs.push(read.run);
          }
        }

        // A directory that vanished (pruned, deleted) must not pin a stale parse
        // in the cache for the process lifetime.
        for (const key of cache.keys()) {
          if (key.startsWith(options.runsRoot) && !seen.has(key)) cache.delete(key);
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
