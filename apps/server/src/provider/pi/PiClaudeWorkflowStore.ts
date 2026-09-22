/**
 * Read-only reader for the `pi-workflows-claude` extension's run feed.
 *
 * That extension keeps its durable run state in two files per run, both under the
 * Pi session directory it was launched with:
 *
 *   `<sessionDir>/workflows/<runId>.events.jsonl`   append-only live feed
 *   `<sessionDir>/workflows/<runId>.json`           snapshot, written once at settle
 *
 * The feed is the only live source: the snapshot lands when the run ends, so a
 * card driven by it could only ever report finished runs. The feed is written from
 * launch (`run`, then one record per progress entry, then a final `status`), and
 * its `run` record carries the owning `sessionId`, which is what lets a run be
 * attributed to the T3 thread whose Pi process launched it — every thread of a
 * provider instance shares one `--session-dir`, so the directory alone cannot
 * separate two sessions' runs. A feed written before that field existed is
 * readable but unattributable, and stays invisible rather than being guessed onto
 * a thread.
 *
 * The feed is append-only and grows with the run, so it is read incrementally: a
 * sweep folds at most {@link MAX_FEED_BYTES_PER_SWEEP} bytes per run, always
 * ending on a line boundary (a half-written record waits for the next sweep
 * instead of being parsed), and keeps the folded view per file. A file that shrank
 * or was replaced restarts from zero, because a writer that reuses a run file is
 * not the writer this reader was built for.
 *
 * The format belongs to another product and is versioned independently of T3, so
 * every record is untrusted: it is schema-checked, every string and number copied
 * out is bounded, and any failure is swallowed and reported as an *unresolved*
 * run. Unresolved is not the same as gone — a run the reader cannot read this
 * sweep stays tracked upstream and emits nothing — so a format change degrades to
 * "nothing shown", never to a false terminal state.
 *
 * @module provider/pi/PiClaudeWorkflowStore
 */
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  boundText,
  finiteNonNegative,
  type PiWorkflowAgentSnapshot,
  type PiWorkflowAgentStatus,
  type PiWorkflowRunListing,
  type PiWorkflowRunSnapshot,
  type PiWorkflowRunStatus,
} from "./PiWorkflowStore.ts";

/** The extension's feed file for a run: `<runId>.events.jsonl`. */
const FEED_SUFFIX = ".events.jsonl";

const MAX_RUN_FILES = 400;
const MAX_MATCHED_RUNS = 50;
const MAX_AGENTS_PER_RUN = 100;
const MAX_PHASES_PER_RUN = 100;
const MAX_RUN_ID_LENGTH = 200;
/**
 * Bytes folded from one run's feed per sweep. A long workflow writes a record per
 * agent transition, so the file can outgrow one sweep; the rest is folded by the
 * next one, which costs nothing but latency on a view that is already cumulative.
 */
const MAX_FEED_BYTES_PER_SWEEP = 4 * 1024 * 1024;

const EMPTY_LISTING: PiWorkflowRunListing = { runs: [], unresolvedRunIds: [] };

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalFinite = Schema.optional(Schema.NullOr(Schema.Finite));
const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));

/**
 * One line of the feed. The record types share a single loose shape on purpose:
 * this reader copies a handful of fields out of a foreign, unversioned format, and
 * a struct per record type would have to be re-checked against that format for
 * fields nothing here reads. Fields the writer adds are ignored; fields this
 * reader needs and the writer renames make the affected record unreadable, which
 * the sweep reports as unresolved rather than as the run having ended.
 */
const PiClaudeFeedRecord = Schema.Struct({
  /** Writer's timestamp for the record; the newest one is the run's last update. */
  t: OptionalFinite,
  type: Schema.String,
  // `run`
  runId: OptionalString,
  sessionId: OptionalString,
  workflowName: OptionalString,
  startTime: OptionalFinite,
  phases: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          index: OptionalFinite,
          title: OptionalString,
          kind: OptionalString,
        }),
      ),
    ),
  ),
  // `workflow_phase`
  index: OptionalFinite,
  title: OptionalString,
  // `workflow_agent`
  label: OptionalString,
  phaseTitle: OptionalString,
  model: OptionalString,
  tokens: OptionalFinite,
  startedAt: OptionalFinite,
  lastProgressAt: OptionalFinite,
  state: OptionalString,
  skipped: OptionalBoolean,
  cached: OptionalBoolean,
  // `status`
  status: OptionalString,
  endTime: OptionalFinite,
  totalTokens: OptionalFinite,
  error: OptionalString,
});
type PiClaudeFeedRecord = typeof PiClaudeFeedRecord.Type;

const decodeFeedRecord = Schema.decodeUnknownOption(Schema.fromJsonString(PiClaudeFeedRecord));

/** The feed's run statuses, mapped onto the vocabulary the shared snapshot uses. */
const feedRunStatus = (status: string | null | undefined): PiWorkflowRunStatus | undefined => {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
    case "completed":
    case "failed":
      return status;
    // This engine calls an aborted run `killed`; T3's vocabulary calls it aborted.
    case "killed":
      return "aborted";
    default:
      return undefined;
  }
};

/**
 * The feed's per-agent `state`, mapped onto the shared snapshot's agent statuses.
 * `start` is this engine's only "an agent exists" record — it stamps `queuedAt`
 * and `startedAt` on the same record — so it reads as running, not as queued. A
 * user-skipped agent is an `error` record flagged `skipped`, which is a finished
 * row rather than a failure.
 */
const feedAgentStatus = (record: PiClaudeFeedRecord): PiWorkflowAgentStatus | undefined => {
  switch (record.state) {
    case "start":
    case "progress":
      return "running";
    case "done":
      return "done";
    case "error":
      return record.skipped === true ? "skipped" : "error";
    default:
      return undefined;
  }
};

const isTerminalRun = (status: PiWorkflowRunStatus | undefined): boolean =>
  status === "completed" || status === "failed" || status === "aborted";

const isTerminalAgent = (status: PiWorkflowAgentStatus): boolean =>
  status === "done" || status === "error" || status === "skipped";

interface FoldedAgent {
  readonly label: string | undefined;
  readonly phase: string | undefined;
  readonly status: PiWorkflowAgentStatus | undefined;
  readonly model: string | undefined;
  readonly tokens: number | undefined;
  readonly startedAtMs: number | undefined;
  readonly endedAtMs: number | undefined;
}

/**
 * A feed folded up to a byte offset. Phases and agents are keyed by the writer's
 * own 1-based index, which is what its updatable records (`workflow_phase`,
 * `workflow_agent`) address, so a later record replaces the earlier one instead of
 * appending a second row.
 */
interface FoldedFeed {
  runId: string | undefined;
  sessionId: string | undefined;
  workflowName: string | undefined;
  status: PiWorkflowRunStatus | undefined;
  startTimeMs: number | undefined;
  endTimeMs: number | undefined;
  error: string | undefined;
  totalTokens: number | undefined;
  readonly phases: Map<number, string>;
  readonly agents: Map<number, FoldedAgent>;
  updatedAtMs: number;
}

const emptyFold = (): FoldedFeed => ({
  runId: undefined,
  sessionId: undefined,
  workflowName: undefined,
  status: undefined,
  startTimeMs: undefined,
  endTimeMs: undefined,
  error: undefined,
  totalTokens: undefined,
  phases: new Map(),
  agents: new Map(),
  updatedAtMs: 0,
});

/**
 * Folds one record into the view. Absent fields mean "this record does not say",
 * never "this field is now empty": a progress record carries no token count, and
 * reading its absence as a reset would erase what the agent already reported.
 */
const foldRecord = (view: FoldedFeed, record: PiClaudeFeedRecord): void => {
  const at = finiteNonNegative(record.t);
  if (at !== undefined) view.updatedAtMs = Math.max(view.updatedAtMs, at);

  switch (record.type) {
    case "run": {
      view.runId = boundText(record.runId) ?? view.runId;
      // The newest `run` record wins: a resume re-writes it, and the resuming
      // session is the run's delivery owner from then on.
      view.sessionId = boundText(record.sessionId) ?? view.sessionId;
      view.workflowName = boundText(record.workflowName) ?? view.workflowName;
      view.startTimeMs = finiteNonNegative(record.startTime) ?? view.startTimeMs;
      for (const [position, phase] of (record.phases ?? []).entries()) {
        const index = finiteNonNegative(phase.index) ?? position + 1;
        const title = boundText(phase.title);
        if (title !== undefined) view.phases.set(index, title);
      }
      // A run record with no status record yet is a run in flight.
      view.status ??= "running";
      return;
    }
    case "status": {
      view.status = feedRunStatus(record.status) ?? view.status;
      view.endTimeMs = finiteNonNegative(record.endTime) ?? view.endTimeMs;
      view.error = boundText(record.error) ?? view.error;
      view.totalTokens = finiteNonNegative(record.totalTokens) ?? view.totalTokens;
      // A terminal run can abort agents that never wrote a terminal record. Left
      // alone they would read as in progress forever, so they are settled with
      // the run that settled them.
      if (isTerminalRun(view.status)) {
        for (const [index, agent] of view.agents) {
          if (agent.status !== undefined && isTerminalAgent(agent.status)) continue;
          view.agents.set(index, {
            ...agent,
            status: "error",
            endedAtMs: agent.endedAtMs ?? finiteNonNegative(record.endTime) ?? view.updatedAtMs,
          });
        }
      }
      return;
    }
    case "workflow_phase": {
      const index = finiteNonNegative(record.index);
      const title = boundText(record.title);
      if (index === undefined || title === undefined) return;
      view.phases.set(index, title);
      return;
    }
    case "workflow_agent": {
      const index = finiteNonNegative(record.index);
      if (index === undefined) return;
      // Bounded like the snapshot's agent list: the panel renders the first
      // hundred rows of a run, and a run can spawn a thousand agents.
      const previous = view.agents.get(index);
      if (previous === undefined && view.agents.size >= MAX_AGENTS_PER_RUN) return;
      const status = feedAgentStatus(record) ?? previous?.status;
      view.agents.set(index, {
        label: boundText(record.label) ?? previous?.label,
        phase: boundText(record.phaseTitle) ?? previous?.phase,
        status,
        model: boundText(record.model) ?? previous?.model,
        tokens: finiteNonNegative(record.tokens) ?? previous?.tokens,
        startedAtMs: finiteNonNegative(record.startedAt) ?? previous?.startedAtMs,
        // Only a finished agent has an end; the writer stamps `lastProgressAt` on
        // every record, so reading it as an end while the agent runs would claim
        // it stopped.
        endedAtMs:
          status !== undefined && isTerminalAgent(status)
            ? (finiteNonNegative(record.lastProgressAt) ?? previous?.endedAtMs)
            : undefined,
      });
      return;
    }
    default:
      // `workflow_log` and anything a later writer adds: read by nobody here.
      return;
  }
};

/** Folds the complete lines of one chunk. A trailing partial line is not passed in. */
const foldLines = (view: FoldedFeed, text: string): FoldedFeed => {
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const record = Option.getOrNull(decodeFeedRecord(line));
    if (record === null) continue;
    foldRecord(view, record);
  }
  return view;
};

const isoOrUndefined = (at: number | undefined): string | undefined =>
  at === undefined || at <= 0 ? undefined : DateTime.formatIso(DateTime.makeUnsafe(at));

const toAgentSnapshots = (view: FoldedFeed): ReadonlyArray<PiWorkflowAgentSnapshot> =>
  [...view.agents.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, MAX_AGENTS_PER_RUN)
    .map(([index, agent]) => ({
      // The writer's index, never its `agentId`: that id only appears on the
      // agent's terminal record, and a member row that changed its task id
      // mid-flight would show up twice.
      id: String(index),
      label: agent.label ?? `agent ${index}`,
      phase: agent.phase,
      status: agent.status ?? "queued",
      model: agent.model,
      tokens: agent.tokens,
      startedAt: isoOrUndefined(agent.startedAtMs),
      endedAt: isoOrUndefined(agent.endedAtMs),
    }));

/**
 * The phase the card reports as current: the one the newest agent ran in. The feed
 * carries no other honest signal — every declared phase is written up front, so
 * the newest `workflow_phase` record is always the last one declared — and it only
 * moves forward as agents start.
 */
const currentPhaseOf = (view: FoldedFeed): string | undefined => {
  const newest = [...view.agents.entries()].sort(([a], [b]) => b - a)[0];
  return newest?.[1].phase;
};

/** `null` when the fold holds no run this reader could attribute and render. */
const toRunSnapshot = (view: FoldedFeed): PiWorkflowRunSnapshot | null => {
  const runId = view.runId?.trim();
  if (runId === undefined || runId.length === 0 || runId.length > MAX_RUN_ID_LENGTH) return null;
  const status = view.status ?? "running";
  return {
    runId,
    workflowName: boundText(view.workflowName) ?? runId,
    status,
    phases: [...view.phases.entries()]
      .sort(([a], [b]) => a - b)
      .slice(0, MAX_PHASES_PER_RUN)
      .map(([, title]) => title),
    currentPhase: currentPhaseOf(view),
    agents: toAgentSnapshots(view),
    sessionId: boundText(view.sessionId),
    // This store has no notion of a parent session.
    parentSessionId: undefined,
    error: boundText(view.error),
    totalTokens: finiteNonNegative(view.totalTokens),
    startedAt: isoOrUndefined(view.startTimeMs),
    updatedAt: isoOrUndefined(view.updatedAtMs),
    completedAt: isTerminalRun(status) ? isoOrUndefined(view.endTimeMs) : undefined,
    durationMs: undefined,
  };
};

export interface PiClaudeWorkflowStoreOptions {
  /**
   * The Pi session directory this provider instance launched Pi with. The
   * extension writes its runs under `<sessionDir>/workflows`; tests point it at a
   * fixture directory.
   */
  readonly sessionDir: string;
}

export interface PiClaudeWorkflowStoreShape {
  /**
   * One sweep of the feed directory for runs owned by a session in `sessionIds`.
   * Same contract as the snapshot store's sweep: `unresolvedRunIds` names runs
   * that are present but could not be read, and only an absent feed directory is
   * an empty listing — any other failure to read it dies, because it is not
   * evidence that the runs are gone.
   */
  readonly listRunsForSession: (input: {
    readonly sessionIds: ReadonlyArray<string>;
  }) => Effect.Effect<PiWorkflowRunListing>;
}

interface FeedFileInfo {
  readonly size: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

/** Folded state per feed file, carried between sweeps. */
interface FeedState {
  readonly offset: number;
  /** File identity, so a replaced file is folded from scratch rather than at an offset. */
  readonly ino: number;
  readonly view: FoldedFeed;
}

/** Reads at most `budget` bytes from the open file's position, merged into one buffer. */
const readUpTo = (file: FileSystem.File, budget: number) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let remaining = budget;
    while (remaining > 0) {
      const read = yield* file.readAlloc(remaining);
      if (Option.isNone(read) || read.value.length === 0) break;
      chunks.push(read.value);
      remaining -= read.value.length;
    }
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0]!;
    const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      merged.set(chunk, at);
      at += chunk.length;
    }
    return merged;
  });

const runIdOfFileName = (fileName: string): string =>
  fileName.slice(0, Math.max(0, fileName.length - FEED_SUFFIX.length));

export const makePiClaudeWorkflowStore = Effect.fn("makePiClaudeWorkflowStore")(function* (
  options: PiClaudeWorkflowStoreOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const semaphore = yield* Semaphore.make(1);
  const feeds = new Map<string, FeedState>();

  /** `null` for anything that is not a readable file (absent, a directory, an error). */
  const statFeedFile = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.map((info): FeedFileInfo | null => {
        const size = Number(info.size);
        if (info.type !== "File" || !Number.isFinite(size)) return null;
        return {
          size,
          ino: Option.getOrElse(info.ino, () => 0),
          mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
        };
      }),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.succeed(null),
      ),
      Effect.orElseSucceed(() => null),
    );

  /**
   * Folds everything appended since the last sweep. `null` when the file cannot be
   * read at all — not when it simply has nothing new, which is the common case and
   * returns the previous view.
   */
  const foldFeed = (filePath: string, info: FeedFileInfo) =>
    Effect.gen(function* () {
      const previous = feeds.get(filePath);
      // A file that shrank or was replaced is not the file this reader folded.
      const state =
        previous !== undefined && previous.ino === info.ino && previous.offset <= info.size
          ? previous
          : { offset: 0, ino: info.ino, view: emptyFold() };
      const remaining = info.size - state.offset;
      if (remaining <= 0) return state.view;

      const budget = Math.min(remaining, MAX_FEED_BYTES_PER_SWEEP);
      const bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(filePath, { flag: "r" });
          yield* file.seek(state.offset, "start");
          return yield* readUpTo(file, budget);
        }),
      );
      // 0x0a is a whole byte in UTF-8, so the boundary can be found before
      // decoding and a record split across two writes is never half-parsed.
      const lastNewline = bytes.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        if (remaining > budget) {
          yield* Effect.logDebug(
            "Pi workflow feed record exceeds the per-sweep budget; waiting for more.",
            { filePath, offset: state.offset },
          );
        }
        feeds.set(filePath, state);
        return state.view;
      }
      const consumed = bytes.subarray(0, lastNewline + 1);
      const view = foldLines(state.view, new TextDecoder().decode(consumed));
      feeds.set(filePath, { offset: state.offset + consumed.length, ino: info.ino, view });
      return view;
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logDebug("Pi workflow feed could not be read.", { filePath, cause }).pipe(
            Effect.as(null),
          ),
      ),
      Effect.orElseSucceed(() => null),
    );

  const listRunsForSession: PiClaudeWorkflowStoreShape["listRunsForSession"] = (input) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        const feedsDir = path.join(options.sessionDir, "workflows");
        // An absent directory means the extension never ran for this instance.
        // Anything else — permissions, I/O error, a file where the directory
        // should be — is not evidence of absence, so it dies and the caller's
        // sweep guard leaves every tracked run alone this round.
        const entries = yield* fileSystem.readDirectory(feedsDir).pipe(
          Effect.map((names): Option.Option<ReadonlyArray<string>> => Option.some(names)),
          Effect.catchIf(
            (cause) => cause.reason._tag === "NotFound",
            () => Effect.succeed(Option.none<ReadonlyArray<string>>()),
          ),
          Effect.orDie,
        );
        if (Option.isNone(entries)) return EMPTY_LISTING;

        const unresolvedRunIds = new Set<string>();
        const candidates: Array<{
          readonly fileName: string;
          readonly filePath: string;
          readonly info: FeedFileInfo;
        }> = [];
        for (const fileName of entries.value) {
          if (!fileName.endsWith(FEED_SUFFIX)) continue;
          const filePath = path.join(feedsDir, fileName);
          const info = yield* statFeedFile(filePath);
          if (info === null) {
            // Listed but unreadable: it exists, so it must not read as gone.
            unresolvedRunIds.add(runIdOfFileName(fileName));
            continue;
          }
          candidates.push({ fileName, filePath, info });
        }
        // Select by recency: a run's feed is written as the run progresses, so
        // `mtime` is the only signal that keeps a live run in a capped sweep.
        candidates.sort(
          (a, b) =>
            b.info.mtimeMs - a.info.mtimeMs ||
            (a.fileName < b.fileName ? 1 : a.fileName > b.fileName ? -1 : 0),
        );
        const selected = candidates.slice(0, MAX_RUN_FILES);
        // Past the cap nothing was read, so nothing can be said about those runs.
        for (const skipped of candidates.slice(MAX_RUN_FILES)) {
          unresolvedRunIds.add(runIdOfFileName(skipped.fileName));
        }

        const wanted = new Set(input.sessionIds.filter((id) => id.length > 0));
        const seen = new Set<string>();
        const runs: Array<PiWorkflowRunSnapshot> = [];
        for (const candidate of selected) {
          seen.add(candidate.filePath);
          const view = yield* foldFeed(candidate.filePath, candidate.info);
          if (view === null) {
            unresolvedRunIds.add(runIdOfFileName(candidate.fileName));
            continue;
          }
          const run = toRunSnapshot(view);
          if (run === null) {
            // Readable but not renderable: the record names no run id, so this
            // reader cannot even say which run it holds.
            unresolvedRunIds.add(runIdOfFileName(candidate.fileName));
            continue;
          }
          // A feed from before the owning session was recorded is readable but
          // unattributable: it stays invisible instead of landing on this thread.
          if (run.sessionId !== undefined && wanted.has(run.sessionId)) runs.push(run);
        }

        // A feed that vanished (pruned, deleted, renamed) must not pin its folded
        // view for the process lifetime.
        for (const key of feeds.keys()) {
          if (key.startsWith(feedsDir) && !seen.has(key)) feeds.delete(key);
        }

        const ordered = runs.sort((a, b) => {
          const aTime = a.updatedAt === undefined ? 0 : Date.parse(a.updatedAt);
          const bTime = b.updatedAt === undefined ? 0 : Date.parse(b.updatedAt);
          return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
        });
        // Matches past the return cap were read and matched, but the caller will
        // not see them: dropping them silently would look like the run ended.
        for (const dropped of ordered.slice(MAX_MATCHED_RUNS)) {
          unresolvedRunIds.add(dropped.runId);
        }
        return {
          runs: ordered.slice(0, MAX_MATCHED_RUNS),
          unresolvedRunIds: [...unresolvedRunIds],
        };
      }),
    );

  return { listRunsForSession } satisfies PiClaudeWorkflowStoreShape;
});
