/**
 * The Pi provider adapter: one `pi --mode rpc` process per thread.
 *
 * ## Shape of a turn
 *
 * Pi's `prompt` command responds the moment the prompt is *accepted*, not when
 * the agent finishes, and everything after that arrives on the event stream.
 * `sendTurn` therefore sends the prompt under a lock, then waits outside the
 * lock for `agent_settled` — the one event that means "no retry, compaction, or
 * queued continuation is left". Waiting outside the lock is what makes steering
 * work: a prompt that arrives mid-turn reuses the active turn id and is sent
 * with `streamingBehavior: "steer"`, so both callers resolve on the same
 * settlement and only one emits `turn.completed`.
 *
 * ## Extension dialogs block the agent
 *
 * Pi extensions can ask the user a question (`ctx.ui.select/confirm/input/
 * editor`) over the same stream. Pi *blocks* until `extension_ui_response`
 * arrives, and only returns early when the request carried its own `timeout`.
 * Every dialog is therefore registered as a pending T3 user-input request, and
 * every path that ends a session answers outstanding dialogs with
 * `cancelled: true` — otherwise stopping a thread would leave a Pi process
 * hanging forever.
 *
 * ## Attachments
 *
 * `ProviderService` already appends `[Attached image "x.png" is saved at: …]`
 * to the turn text, so the agent receives attachment paths in-band and reads
 * them with its own tools. The adapter forwards the text unchanged and, when
 * the turn carries supported raster images, additionally sends them as Pi's
 * native `images` payload so the model sees the pixels directly. An image that
 * cannot be read or exceeds the size budget is skipped with a runtime warning
 * and still reaches the agent through its path in the text.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type PiSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnCompletedPayload,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as PlatformError from "effect/PlatformError";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { buildPiPromptImages } from "../pi/PiImageAttachments.ts";
import {
  emptyPiWorkflowTracker,
  reconcilePiWorkflowRuns,
  type PiWorkflowEmission,
} from "../pi/PiWorkflowProgress.ts";
import * as PiRpcTransport from "../pi/PiRpcTransport.ts";
import type { PiRpcEvent, PiRpcTransportShape } from "../pi/PiRpcTransport.ts";
import { defaultPiWorkflowStoreRoot, makePiWorkflowStore } from "../pi/PiWorkflowStore.ts";
import {
  piDeltaStreamKind,
  piNotifyMessage,
  piQuestionFromDialog,
  piResponseFromAnswers,
  piToolItemType,
  piToolResultText,
  piToolTitle,
  piSessionStatsToThreadTokenUsage,
  piUsageToTurnTokenUsage,
  type PiExtensionUiRequest,
  type PiUsage,
} from "../pi/PiEventMapping.ts";

const PROVIDER = ProviderDriverKind.make("pi");

const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
  turnStartEntryIds: Schema.optional(Schema.Unknown),
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);

/**
 * Rewind boundaries travel in the resume cursor, one Pi session entry id per
 * T3 turn, so a process that never saw a turn can still fork before it. A
 * malformed list is dropped rather than rejecting the cursor: a session id
 * that still works is worth more than boundaries that do not.
 */
const decodeTurnStartEntryIds = (value: unknown): Array<string | null> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries: ReadonlyArray<unknown> = value;
  return entries.every((id) => id === null || (typeof id === "string" && id.length > 0))
    ? entries.map((id) => (typeof id === "string" ? id : null))
    : undefined;
};

const piResumeCursor = (
  sessionId: string,
  turnStartEntryIds: ReadonlyArray<string | null>,
): {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly turnStartEntryIds?: ReadonlyArray<string | null>;
} => ({
  schemaVersion: 1,
  sessionId,
  ...(turnStartEntryIds.length > 0 ? { turnStartEntryIds: [...turnStartEntryIds] } : {}),
});

/** Pi streams a whole bash command's output; the websocket must not carry all of it. */
const MAX_ITEM_DETAIL_CHARS = 4_000;
const MAX_ITEM_TITLE_CHARS = 200;
/** Pi answers session commands immediately; this only bounds a wedged process. */
const MODEL_REQUEST_TIMEOUT_MS = 30_000;
/**
 * How long a settled turn waits for its rewind boundary.
 *
 * `get_entries` returns Pi's whole session tree, so its cost grows with the
 * thread and a wedged process can hold it for the full RPC timeout. The wait
 * is bounded because this read runs on `sendTurn`'s way out: a read that
 * misses the budget leaves the turn's boundary `null`, which makes a later
 * rewind fail with a clear "never recorded" message rather than fork before a
 * wrong entry.
 */
const BOUNDARY_READ_BUDGET = "1 second";

type Adapter = ProviderAdapterShape<ProviderAdapterError>;

interface TurnIntent {
  readonly turnId: TurnId;
  readonly generation: number;
  settled: boolean;
}

interface PendingDialog {
  readonly request: PiExtensionUiRequest;
  readonly question: UserInputQuestion;
}

interface OpenTool {
  readonly toolName: string;
  readonly itemType: ReturnType<typeof piToolItemType>;
  /** Characters of accumulated output already emitted, so updates send only the delta. */
  streamedChars: number;
}

interface TurnOutcome {
  state: TurnCompletedPayload["state"];
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
}

/**
 * One T3 turn as this process observed it. A rewind forks Pi's session just
 * before `startEntryId`, the entry of the user message that opens the turn.
 */
interface SessionTurn {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  /**
   * The session position (leaf id) the turn started from, read before its
   * prompt was sent. `null` means the session was empty, `undefined` means the
   * read failed, which leaves this turn's boundary unknown.
   */
  readonly anchorEntryId: string | null | undefined;
  /** Pi session entry the turn starts at; `null` while it is still unknown. */
  startEntryId: string | null;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly scope: Scope.Closeable;
  readonly transport: PiRpcTransportShape;
  readonly promptLock: Semaphore.Semaphore;
  readonly stopLock: Semaphore.Semaphore;
  /** Dialogs Pi is currently blocked on, keyed by the id T3 shows the client. */
  readonly dialogs: Map<ApprovalRequestId, PendingDialog>;
  readonly tools: Map<string, OpenTool>;
  /** Turns this process observed, in turn order, for snapshots and rewinds. */
  readonly turns: Array<SessionTurn>;
  /**
   * Turn boundaries restored from the resume cursor, in turn order, that this
   * process never observed. `null` is a boundary that was never known.
   */
  readonly restoredTurnStarts: Array<string | null>;
  /** Pi session id the thread resumes from; mirrored into the resume cursor. */
  sessionId: string;
  /**
   * Session position the next turn starts from, in the same sense as
   * `SessionTurn.anchorEntryId`. `undefined` means it has not been read yet.
   */
  boundaryAnchor: string | null | undefined;
  session: ProviderSession;
  activeTurn:
    | { readonly intent: TurnIntent; readonly settled: Deferred.Deferred<void> }
    | undefined;
  /** Assistant item opened by the current turn, closed on `message_end`. */
  assistantItemId: string | undefined;
  generation: number;
  turnOutcome: TurnOutcome;
  turnUsage: PiUsage | undefined;
  /**
   * The session-stats read still in flight, if any. At most one runs per
   * session; starting the next one cancels this fiber.
   */
  sessionStatsRead: Fiber.Fiber<void, never> | undefined;
  stopped: boolean;
}

export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  /** T3-owned directory holding Pi's session files for this provider instance. */
  readonly sessionDir: string;
  /**
   * Supplied by the driver rather than required from the adapter's own
   * environment, so the adapter keeps `R = never` like every other adapter.
   */
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /**
   * Builds the RPC transport for a session. The production path spawns `pi`;
   * tests substitute a fixture process, and receive the computed argv so the
   * launch flags stay asserted rather than bypassed.
   */
  readonly makeTransport?:
    | ((input: {
        readonly cwd: string;
        readonly args: ReadonlyArray<string>;
        readonly env: NodeJS.ProcessEnv;
        readonly threadId: ThreadId;
      }) => Effect.Effect<
        PiRpcTransportShape,
        PiRpcTransport.PiRpcSpawnError | PlatformError.PlatformError,
        Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
      >)
    | undefined;
  readonly nativeEventLogger?: PiNativeEventLogger | undefined;
  /**
   * Root of the Pi dynamic-workflows run store. Defaults to the operator's
   * `~/.pi/workflows`; tests point it at a fixture directory. This is a test
   * seam, not user config.
   */
  readonly workflowStoreRoot?: string | undefined;
  /** Sweep cadence for the workflow store; tests shorten it. */
  readonly workflowSweepIntervalMs?: number | undefined;
}

/** Subset of `EventNdjsonLogger` the adapter writes raw protocol records to. */
export interface PiNativeEventLogger {
  readonly write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
}

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;

const trimOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * `PiRpcError` is a union of tagged transport errors rather than a class, so a
 * runtime check has to go through the tag.
 */
const isPiRpcError = (cause: unknown): cause is { readonly message: string } => {
  if (typeof cause !== "object" || cause === null) return false;
  const tag = (cause as { _tag?: unknown })._tag;
  return typeof tag === "string" && tag.startsWith("PiRpc") && "message" in cause;
};

// TaggedError subclasses are Effect Schemas; `instanceof` is not the
// schema-aware check for them.
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);

const decodeRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * One record of Pi's append-only session tree, as `get_entries` reports it.
 * `parentId` is what makes a leaf id walkable back to the root, which is how
 * the active branch — and therefore the ordered user messages on it — is read.
 */
interface PiEntryRecord {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly type: string;
  readonly role: string | undefined;
}

const decodePiEntry = (value: unknown): PiEntryRecord | undefined => {
  const record = decodeRecord(value);
  const id = trimOrUndefined(record?.id);
  const type = trimOrUndefined(record?.type);
  if (!id || !type) return undefined;
  return {
    id,
    parentId: trimOrUndefined(record?.parentId),
    type,
    role: type === "message" ? trimOrUndefined(decodeRecord(record?.message)?.role) : undefined,
  };
};

/**
 * Walks `leafId` back to the root. Returns undefined when the leaf or any of
 * its ancestors is missing from the reported entries — a partial read must
 * fail rather than silently shorten the conversation.
 */
const piActivePath = (
  entries: ReadonlyArray<PiEntryRecord>,
  leafId: string | undefined,
): ReadonlyArray<PiEntryRecord> | undefined => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: Array<PiEntryRecord> = [];
  const seen = new Set<string>();
  let current = leafId;
  while (current !== undefined) {
    if (seen.has(current)) return undefined;
    const entry = byId.get(current);
    if (!entry) return undefined;
    seen.add(current);
    path.unshift(entry);
    current = entry.parentId;
  }
  return path;
};

const isPiUserEntry = (entry: PiEntryRecord): boolean =>
  entry.type === "message" && entry.role === "user";

/**
 * The session position a turn starts from: the tip of the active branch.
 * `null` is an empty session; a branch that cannot be walked makes the
 * position unknown instead, because resolving a boundary from a wrong anchor
 * would name the wrong turn.
 */
const piBoundaryAnchor = (
  activePath: ReadonlyArray<PiEntryRecord> | undefined,
): string | null | undefined =>
  activePath === undefined ? undefined : (activePath.at(-1)?.id ?? null);

/**
 * Pi's `--model` flag splits `provider/id` on the first `/`, which is exactly
 * how T3 namespaces Pi model slugs (the ids themselves may contain `/`). A slug
 * with no provider prefix addresses Pi's configured default provider.
 */
export const splitPiModelSlug = (
  slug: string,
): { readonly provider: string | undefined; readonly model: string } => {
  const separator = slug.indexOf("/");
  return separator > 0 && separator < slug.length - 1
    ? { provider: slug.slice(0, separator), model: slug.slice(separator + 1) }
    : { provider: undefined, model: slug };
};

/** Spawn arguments for a session, derived from the T3 thread's selections. */
export function buildPiLaunchArgs(input: {
  readonly settings: PiSettings;
  readonly sessionDir: string;
  readonly resumeSessionId?: string | undefined;
  readonly modelSlug?: string | undefined;
  readonly thinkingLevel?: string | undefined;
}): ReadonlyArray<string> {
  const args: Array<string> = ["--mode", "rpc", "--session-dir", input.sessionDir];
  // Extensions are never disabled: they are what register Pi's providers.
  // `PI_OFFLINE` is likewise never set, because an extension that fetches its
  // model catalog would then register nothing.
  if (input.resumeSessionId) {
    args.push("--session-id", input.resumeSessionId);
  }
  if (input.modelSlug) {
    const { provider, model } = splitPiModelSlug(input.modelSlug);
    if (provider) args.push("--provider", provider);
    args.push("--model", model);
  }
  if (input.thinkingLevel) {
    args.push("--thinking", input.thinkingLevel);
  }
  return args;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  settings: PiSettings,
  options: PiAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const sessions = new Map<ThreadId, SessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create a Pi event ID.",
          cause,
        }),
    ),
  );
  const stamp = Effect.all({
    eventId: Effect.map(randomId, EventId.make),
    createdAt: nowIso,
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  const logNative = (record: unknown, threadId: ThreadId | null): Effect.Effect<void> =>
    options.nativeEventLogger?.write(record, threadId) ?? Effect.void;

  const withThreadLock = <A, E, R>(threadId: ThreadId, task: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => [lock, new Map(current).set(threadId, lock)] as const),
      );
    }).pipe(Effect.flatMap((lock) => lock.withPermit(task)));

  //
  // Pi workflow runs (dynamic workflows, `@quintinshaw/pi-dynamic-workflows`).
  //
  // The extension draws its live progress in a TUI panel that RPC mode cannot
  // serve, so the only live source is the run store it writes to disk. This
  // reader is off the turn path by construction: it is a spaced sweep forked
  // into the thread's session scope, it never blocks a turn, and every failure
  // is swallowed and logged so a foreign, unversioned format can only make the
  // feature invisible, never break a thread.
  //
  const workflowStore = yield* makePiWorkflowStore({
    homeDir: options.workflowStoreRoot ?? defaultPiWorkflowStoreRoot(options.environment),
  });
  // A non-positive or non-finite cadence would be a hot loop over the store.
  const configuredSweepIntervalMs = options.workflowSweepIntervalMs ?? 3_000;
  const workflowSweepInterval = Duration.millis(
    Number.isFinite(configuredSweepIntervalMs) && configuredSweepIntervalMs >= 1
      ? configuredSweepIntervalMs
      : 3_000,
  );

  /** Stamp one reconciled emission and publish it on the provider stream. */
  const emitWorkflowEmission = (threadId: ThreadId, emission: PiWorkflowEmission) =>
    Effect.gen(function* () {
      const eventStamp = yield* stamp;
      const base = {
        eventId: eventStamp.eventId,
        createdAt: eventStamp.createdAt,
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId,
      };
      switch (emission.type) {
        case "task.started":
          return yield* emit({ ...base, type: "task.started", payload: emission.payload });
        case "task.progress":
          return yield* emit({ ...base, type: "task.progress", payload: emission.payload });
        case "task.updated":
          return yield* emit({ ...base, type: "task.updated", payload: emission.payload });
        case "task.completed":
          return yield* emit({ ...base, type: "task.completed", payload: emission.payload });
      }
    });

  /**
   * Sweeps the thread's workflow-store project directory once per cadence. The
   * tracker is per session (not per adapter) so one thread's sweep can never
   * mistake another thread's run for a vanished one. A failed sweep is logged
   * and skipped with the tracker untouched: "I could not read this" must never
   * reach a thread as "this ended".
   */
  const startWorkflowSweep = (context: SessionContext) =>
    Effect.gen(function* () {
      let tracker = emptyPiWorkflowTracker();
      const sweep = Effect.gen(function* () {
        const listing = yield* workflowStore.listRunsForSession({
          cwd: context.cwd,
          sessionIds: [context.sessionId],
        });
        const reconciled = reconcilePiWorkflowRuns({
          runs: listing.runs,
          unresolvedRunIds: listing.unresolvedRunIds,
          tracker,
        });
        tracker = reconciled.tracker;
        for (const emission of reconciled.emissions) {
          yield* emitWorkflowEmission(context.threadId, emission);
        }
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logDebug("Pi workflow sweep failed.", {
              threadId: context.threadId,
              cause,
            }),
        ),
      );
      yield* sweep.pipe(
        Effect.repeat(Schedule.spaced(workflowSweepInterval)),
        Effect.forkIn(context.scope),
        Effect.asVoid,
      );
    });

  const requestError = (threadId: ThreadId, method: string, cause: unknown) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: isPiRpcError(cause)
        ? cause.message
        : `The Pi request '${method}' failed for thread ${threadId}.`,
      cause,
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  /**
   * Restored turns belong to the live Pi session but were never observed by
   * this process, so their items are genuinely unknown. The snapshot reports
   * them with an empty `items` array rather than dropping them, because the
   * turn count a caller sees has to match what a rewind can still address.
   * Their id is derived from the boundary entry the resume cursor saved, which
   * is stable across resumes; a turn whose boundary was never recorded falls
   * back to its position.
   */
  const restoredTurnSnapshot = (startEntryId: string | null, index: number) => ({
    id: TurnId.make(startEntryId ?? `pi-restored-turn-${index}`),
    items: [] as ReadonlyArray<unknown>,
  });

  const snapshotThread = (context: SessionContext) => ({
    threadId: context.threadId,
    turns: [
      ...context.restoredTurnStarts.map(restoredTurnSnapshot),
      ...context.turns.map(({ id, items }) => ({ id, items })),
    ],
  });

  /** Every boundary the thread has, restored turns first, in turn order. */
  const knownTurnStarts = (context: SessionContext): Array<string | null> => [
    ...context.restoredTurnStarts,
    ...context.turns.map((turn) => turn.startEntryId),
  ];

  /**
   * Publishes the boundaries a later resume needs. Pi replaces its session —
   * and its session id — on every fork, so the resume cursor is the only place
   * a boundary outlives a process, and a cursor without one is exactly what
   * made a rewind after a resume fail.
   */
  const writeResumeCursor = (context: SessionContext) =>
    Effect.gen(function* () {
      // Read the timestamp before the state: the read-then-assign below has to
      // be one synchronous step, because this now also runs off the prompt lock
      // (a settled turn's boundary), where a concurrent rollback can change
      // `sessionId` while `updatedAt` is being awaited.
      const updatedAt = yield* nowIso;
      context.session = {
        ...context.session,
        resumeCursor: piResumeCursor(context.sessionId, knownTurnStarts(context)),
        updatedAt,
      };
    });

  const readPiEntries = (context: SessionContext) =>
    context.transport.request({ type: "get_entries" }, { timeout: MODEL_REQUEST_TIMEOUT_MS }).pipe(
      Effect.mapError((cause) => requestError(context.threadId, "get_entries", cause)),
      Effect.map((data) => {
        const record = decodeRecord(data);
        const raw = Array.isArray(record?.entries) ? record.entries : [];
        return {
          entries: raw.flatMap((value) => {
            const entry = decodePiEntry(value);
            return entry ? [entry] : [];
          }),
          leafId: typeof record?.leafId === "string" ? record.leafId : undefined,
        };
      }),
    );

  /**
   * Reads the active branch of Pi's session tree, or `undefined` when it cannot
   * be read. Naming a rewind boundary is a nice-to-have, so a read failure is
   * logged and dropped rather than turning a finished turn into a failed one.
   */
  const readPiActivePath = (context: SessionContext) =>
    readPiEntries(context).pipe(
      Effect.map((tree) => piActivePath(tree.entries, tree.leafId)),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logDebug("Pi session tree unavailable; rewind boundaries stay unknown", {
            threadId: context.threadId,
            cause,
          }).pipe(Effect.as(undefined)),
      ),
    );

  /**
   * Names the session entry a finished turn started from, so a rewind can fork
   * before it even from a process that never saw the turn.
   *
   * The boundary comes from the session tree rather than from counting user
   * messages: Pi has no notion of a turn, and a steered turn appends extra user
   * messages that counting would mistake for extra turn boundaries. The turn's
   * anchor — the position it started from, read before its prompt was sent —
   * makes the first user entry after it the turn's own first message.
   *
   * A failed read only loses this turn's boundary; the next turn relearns the
   * position before its own prompt.
   */
  const resolveTurnBoundary = (context: SessionContext, turn: SessionTurn) =>
    Effect.gen(function* () {
      const activePath = yield* readPiActivePath(context);
      if (!activePath) {
        context.boundaryAnchor = undefined;
        return;
      }
      if (turn.anchorEntryId !== undefined) {
        const anchorIndex =
          turn.anchorEntryId === null
            ? -1
            : activePath.findIndex((entry) => entry.id === turn.anchorEntryId);
        // `null` is a known position — the turn started from an empty session;
        // an anchor missing from the branch is not.
        if (turn.anchorEntryId === null || anchorIndex >= 0) {
          const boundary = activePath.slice(anchorIndex + 1).find(isPiUserEntry);
          if (boundary) turn.startEntryId = boundary.id;
        }
      }
      context.boundaryAnchor = piBoundaryAnchor(activePath);
    });

  /**
   * A rewind replaces Pi's whole session, so the id T3 resumes from changes
   * with it. Reporting the new id as `thread.started` is what keeps a later
   * resume — and the binding `ProviderService` re-reads after a rewind —
   * pointing at the branch the thread is actually on.
   */
  const adoptForkedSession = (context: SessionContext) =>
    Effect.gen(function* () {
      const state = decodeRecord(
        yield* context.transport
          .request({ type: "get_state" }, { timeout: MODEL_REQUEST_TIMEOUT_MS })
          .pipe(Effect.mapError((cause) => requestError(context.threadId, "get_state", cause))),
      );
      const sessionId = trimOrUndefined(state?.sessionId);
      if (!sessionId) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Pi rewound the session but did not report its new session id.",
        });
      }
      context.sessionId = sessionId;
      yield* writeResumeCursor(context);
      yield* emit({
        type: "thread.started",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: context.threadId,
        payload: { providerThreadId: sessionId },
      });
    });

  /**
   * Answers every dialog Pi is blocked on. Called on stop and on process exit;
   * skipping it would strand the agent — and its process — on a question nobody
   * can answer any more.
   */
  const cancelDialogs = (context: SessionContext) =>
    Effect.gen(function* () {
      const pending = [...context.dialogs.values()];
      context.dialogs.clear();
      for (const dialog of pending) {
        yield* emit({
          type: "user-input.resolved",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId: context.threadId,
          requestId: RuntimeRequestId.make(dialog.request.id),
          payload: { answers: {} },
        });
        yield* context.transport
          .notify(piResponseFromAnswers(dialog.request, undefined))
          .pipe(Effect.ignore);
      }
    });

  const stopContext = (context: SessionContext) =>
    context.stopLock.withPermit(
      Effect.gen(function* () {
        if (context.stopped) {
          // The process may have exited on its own; the scope still has to go.
          yield* Scope.close(context.scope, Exit.void);
          return;
        }
        context.stopped = true;
        sessions.delete(context.threadId);
        yield* cancelDialogs(context);
        // Settle any in-flight turn so a waiting sendTurn cannot outlive the session.
        const active = context.activeTurn;
        if (active && !active.intent.settled) {
          active.intent.settled = true;
          yield* Deferred.succeed(active.settled, undefined).pipe(Effect.ignore);
        }
        yield* emit({
          type: "session.exited",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId: context.threadId,
          payload: { reason: "Stopped by user", exitKind: "graceful" },
        });
        yield* Scope.close(context.scope, Exit.void);
      }),
    );

  /**
   * Reads the live context-window estimate and publishes it. `get_session_stats`
   * is a second RPC on top of the turn, so a failure is logged and dropped:
   * losing a meter update must never turn a finished turn into a failed one,
   * and Pi reports an unusable estimate right after compaction.
   */
  const readSessionTokenUsage = (context: SessionContext, turnId: TurnId | undefined) =>
    Effect.gen(function* () {
      const stats = yield* context.transport
        .request({ type: "get_session_stats" }, { timeout: MODEL_REQUEST_TIMEOUT_MS })
        .pipe(
          Effect.mapError((cause) => requestError(context.threadId, "get_session_stats", cause)),
        );
      // Stopping the thread closes the session scope, which interrupts this
      // read; this guard covers a read that finished before the interrupt
      // landed, so no meter update is published after `session.exited`.
      if (context.stopped) return;
      const usage = piSessionStatsToThreadTokenUsage(stats);
      if (!usage) {
        yield* Effect.logDebug("Pi session stats have no usable context window", {
          threadId: context.threadId,
        });
        return;
      }
      yield* emit({
        type: "thread.token-usage.updated",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: context.threadId,
        ...(turnId ? { turnId } : {}),
        payload: { usage },
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logWarning("Pi session stats unavailable", {
              threadId: context.threadId,
              cause,
            }),
      ),
    );

  /**
   * Starts the session-stats read without letting it gate anything the client
   * waits on: a slow or wedged `get_session_stats` must not delay
   * `turn.completed`, `sendTurn`'s return, or the next Pi event.
   *
   * The read runs in the session scope, so stopping the thread interrupts it,
   * and at most one read per session is in flight: starting a new one cancels
   * the previous one. That bounds the requests a process which never answers
   * can accumulate during back-to-back turns, and it stops a slow, older
   * estimate from landing after a newer one. Cancelling can drop one meter
   * tick, but the replacement read has just observed the same session and
   * reports a value at least as new, so the client still ends on the latest
   * one. The turn id is captured here, so an event can never be attributed to
   * a turn that a later settlement replaced.
   */
  const startSessionTokenUsageRead = (context: SessionContext, turnId: TurnId | undefined) =>
    Effect.gen(function* () {
      const previous = context.sessionStatsRead;
      context.sessionStatsRead = yield* readSessionTokenUsage(context, turnId).pipe(
        Effect.forkIn(context.scope),
      );
      if (previous) yield* Fiber.interrupt(previous);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logWarning("Pi session stats could not be read", {
              threadId: context.threadId,
              cause,
            }),
      ),
    );

  /** Returns whether this call is the one that settled the turn. */
  const finishTurn = (context: SessionContext, intent: TurnIntent) =>
    Effect.gen(function* () {
      if (intent.settled || context.generation !== intent.generation) return false;
      intent.settled = true;
      context.activeTurn = undefined;
      context.assistantItemId = undefined;
      context.tools.clear();
      const outcome = context.turnOutcome;
      const usage = piUsageToTurnTokenUsage(context.turnUsage);
      const { lastError: _previousError, ...sessionRest } = context.session;
      context.turnOutcome = { state: "completed" };
      context.turnUsage = undefined;
      context.session = {
        ...sessionRest,
        status: outcome.state === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        updatedAt: yield* nowIso,
        ...(outcome.errorMessage ? { lastError: outcome.errorMessage } : {}),
      };
      yield* emit({
        type: "turn.completed",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: context.threadId,
        turnId: intent.turnId,
        payload: {
          state: outcome.state,
          ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
          ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
          ...(usage ? { tokenUsage: usage } : {}),
        },
      });
      yield* emit({
        type: "session.state.changed",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: context.threadId,
        payload: { state: outcome.state === "failed" ? "error" : "ready" },
      });
      // The turn's own boundary is deliberately not read here: `get_entries`
      // returns Pi's whole session tree, and awaiting it under the prompt lock
      // is what let a slow or wedged read delay steering, rollback, and the
      // return of `sendTurn` for up to the RPC timeout. The cursor is written
      // with the boundary still missing, and `sendTurn` resolves it after the
      // lock is released, bounded by `BOUNDARY_READ_BUDGET`.
      yield* writeResumeCursor(context);
      return true;
    }).pipe(Effect.uninterruptible);

  /**
   * Resolves a settled turn's rewind boundary off the prompt lock. A read
   * that misses `BOUNDARY_READ_BUDGET` is interrupted, leaving the boundary
   * `null`: the cursor then says the boundary is unknown instead of naming one
   * it never verified.
   */
  const resolveFinishedTurnBoundary = (context: SessionContext, turnId: TurnId) =>
    Effect.gen(function* () {
      const finished = context.turns.findLast((turn) => turn.id === turnId);
      if (!finished) return;
      const resolved = yield* resolveTurnBoundary(context, finished).pipe(
        Effect.timeoutOption(BOUNDARY_READ_BUDGET),
      );
      if (Option.isNone(resolved)) {
        // The interrupted read never reached the anchor write, so the anchor
        // still describes the session as it was BEFORE this turn. Keeping it
        // would make the next turn resolve its boundary from that stale
        // position and name THIS turn's message as its own — which is how a
        // one-turn rewind came to remove two. Dropping it forces the next turn
        // to read the position again instead of inheriting a wrong one.
        context.boundaryAnchor = undefined;
        yield* Effect.logDebug("Pi session tree read missed the rewind-boundary budget", {
          threadId: context.threadId,
          turnId,
        });
      }
      yield* writeResumeCursor(context);
    });

  const ensureAssistantItem = (context: SessionContext) =>
    Effect.gen(function* () {
      if (context.assistantItemId) return context.assistantItemId;
      const itemId = `pi-assistant-${yield* randomId}`;
      context.assistantItemId = itemId;
      yield* emit({
        type: "item.started",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: context.threadId,
        turnId: context.activeTurn?.intent.turnId,
        itemId: RuntimeItemId.make(itemId),
        payload: { itemType: "assistant_message", status: "inProgress" },
      });
      return itemId;
    });

  const closeAssistantItem = (context: SessionContext) =>
    Effect.gen(function* () {
      const itemId = context.assistantItemId;
      if (!itemId) return;
      context.assistantItemId = undefined;
      yield* emit({
        type: "item.completed",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: context.threadId,
        turnId: context.activeTurn?.intent.turnId,
        itemId: RuntimeItemId.make(itemId),
        payload: { itemType: "assistant_message", status: "completed" },
      });
    });

  const handleDialog = (context: SessionContext, request: PiExtensionUiRequest) =>
    Effect.gen(function* () {
      const question = piQuestionFromDialog(request, request.id);
      if (!question) {
        // Unanswerable dialog (empty `select`, unknown method): refuse it rather
        // than leaving the agent blocked on a question the client cannot render.
        yield* context.transport
          .notify(piResponseFromAnswers(request, undefined))
          .pipe(Effect.ignore);
        return;
      }
      context.dialogs.set(ApprovalRequestId.make(request.id), { request, question });
      yield* emit({
        type: "user-input.requested",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: context.threadId,
        requestId: RuntimeRequestId.make(request.id),
        payload: { questions: [question] },
      });
    });

  /**
   * Pi resends the whole accumulated tool output on every update, so only the
   * unseen tail is forwarded. Bash output is the only kind T3 streams; other
   * tools report once at completion.
   */
  const handleToolUpdate = (context: SessionContext, record: PiRpcEvent) =>
    Effect.gen(function* () {
      const toolCallId = trimOrUndefined(record.toolCallId);
      const open = toolCallId ? context.tools.get(toolCallId) : undefined;
      if (!toolCallId || !open) return;
      const text = piToolResultText(record.partialResult);
      if (!text || text.length <= open.streamedChars) return;
      const delta = text.slice(open.streamedChars);
      open.streamedChars = text.length;
      if (open.itemType !== "command_execution") return;
      yield* emit({
        type: "content.delta",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: context.threadId,
        turnId: context.activeTurn?.intent.turnId,
        itemId: RuntimeItemId.make(toolCallId),
        payload: { streamKind: "command_output", delta },
      });
    });

  /**
   * Maps one Pi event onto canonical runtime events. Unknown record types are
   * ignored on purpose: Pi's protocol grows, and an unrecognised event must
   * never break a running turn.
   */
  const handleEvent = (context: SessionContext, record: PiRpcEvent) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      yield* logNative({ direction: "in", record }, context.threadId);
      const turnId = context.activeTurn?.intent.turnId;
      switch (record.type) {
        case "message_start":
        case "message_end": {
          const role = trimOrUndefined(decodeRecord(record.message)?.role);
          if (role && role !== "assistant") {
            // A user message becomes a session entry, but it is not the turn
            // boundary: a rewind boundary is derived from Pi's session tree,
            // so extension and user messages need no bookkeeping here.
            return;
          }
          if (record.type === "message_start") {
            yield* ensureAssistantItem(context);
            return;
          }
          const message = decodeRecord(record.message);
          if (message) context.turns.at(-1)?.items.push(message);
          yield* closeAssistantItem(context);
          return;
        }
        case "message_update": {
          const usage = decodeRecord(record.usage);
          if (usage) context.turnUsage = usage as PiUsage;
          const delta = decodeRecord(record.assistantMessageEvent);
          if (!delta) return;
          const eventType = trimOrUndefined(delta.type);
          const streamKind = eventType ? piDeltaStreamKind(eventType) : undefined;
          // `toolcall_*` deltas are skipped: `tool_execution_start` carries the
          // same call id plus its parsed arguments, and emitting both would
          // duplicate every tool row.
          if (!streamKind) return;
          const text = typeof delta.delta === "string" ? delta.delta : "";
          if (text.length === 0) return;
          const itemId = yield* ensureAssistantItem(context);
          yield* emit({
            type: "content.delta",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: context.threadId,
            turnId,
            itemId: RuntimeItemId.make(itemId),
            payload: {
              streamKind,
              delta: text,
              ...(typeof delta.contentIndex === "number"
                ? { contentIndex: Math.trunc(delta.contentIndex) }
                : {}),
            },
            raw: { source: "pi.rpc.event", messageType: record.type, payload: record },
          });
          return;
        }
        case "tool_execution_start": {
          const toolCallId = trimOrUndefined(record.toolCallId);
          if (!toolCallId) return;
          const toolName = trimOrUndefined(record.toolName) ?? "tool";
          const itemType = piToolItemType(toolName);
          context.tools.set(toolCallId, { toolName, itemType, streamedChars: 0 });
          yield* emit({
            type: "item.started",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: context.threadId,
            turnId,
            itemId: RuntimeItemId.make(toolCallId),
            payload: {
              itemType,
              status: "inProgress",
              title: truncate(piToolTitle(toolName, record.args), MAX_ITEM_TITLE_CHARS),
            },
          });
          return;
        }
        case "tool_execution_update":
          yield* handleToolUpdate(context, record);
          return;
        case "tool_execution_end": {
          const toolCallId = trimOrUndefined(record.toolCallId);
          if (!toolCallId) return;
          const open = context.tools.get(toolCallId);
          context.tools.delete(toolCallId);
          const resultText = piToolResultText(record.result);
          yield* emit({
            type: "item.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: context.threadId,
            turnId,
            itemId: RuntimeItemId.make(toolCallId),
            payload: {
              itemType: open?.itemType ?? piToolItemType(trimOrUndefined(record.toolName) ?? ""),
              status: record.isError === true ? "failed" : "completed",
              ...(resultText ? { detail: truncate(resultText, MAX_ITEM_DETAIL_CHARS) } : {}),
            },
          });
          return;
        }
        case "turn_end": {
          // The turn outcome is recorded where it is actually known: an abort
          // sets `cancelled` before it awaits Pi, and exhausted retries set
          // `failed` on `auto_retry_end`. `turn_end` only marks the tail of the
          // turn, so it must never overwrite a terminal outcome — doing so
          // reported a failed turn as completed and dropped its error message.
          const message = decodeRecord(record.message);
          const items = context.turns.at(-1)?.items;
          if (items && message) items.push(message);
          if (items && Array.isArray(record.toolResults)) items.push(...record.toolResults);
          return;
        }
        case "agent_settled": {
          const active = context.activeTurn;
          if (active && !active.intent.settled) {
            yield* Deferred.succeed(active.settled, undefined).pipe(Effect.ignore);
          }
          return;
        }
        case "compaction_start": {
          const compactionId = `pi-compaction-${yield* randomId}`;
          const reason = trimOrUndefined(record.reason);
          context.tools.set(compactionId, {
            toolName: "compaction",
            itemType: "context_compaction",
            streamedChars: 0,
          });
          yield* emit({
            type: "item.started",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: context.threadId,
            turnId,
            itemId: RuntimeItemId.make(compactionId),
            payload: {
              itemType: "context_compaction",
              status: "inProgress",
              title: "Compacting context",
              ...(reason ? { detail: reason } : {}),
            },
          });
          return;
        }
        case "compaction_end": {
          const entry = [...context.tools.entries()].find(
            ([, tool]) => tool.itemType === "context_compaction",
          );
          if (entry) context.tools.delete(entry[0]);
          const aborted = record.aborted === true;
          const errorMessage = trimOrUndefined(record.errorMessage);
          const result = decodeRecord(record.result);
          const tokensBefore =
            typeof result?.tokensBefore === "number" ? Math.trunc(result.tokensBefore) : undefined;
          const estimatedAfter =
            typeof result?.estimatedTokensAfter === "number"
              ? Math.trunc(result.estimatedTokensAfter)
              : undefined;
          yield* emit({
            type: "item.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: context.threadId,
            turnId,
            itemId: RuntimeItemId.make(entry?.[0] ?? `pi-compaction-${yield* randomId}`),
            payload: {
              itemType: "context_compaction",
              status: aborted ? "declined" : errorMessage ? "failed" : "completed",
              title: "Compacting context",
              ...(errorMessage ? { detail: truncate(errorMessage, MAX_ITEM_DETAIL_CHARS) } : {}),
            },
          });
          if (!aborted && !errorMessage) {
            yield* emit({
              type: "thread.state.changed",
              ...(yield* stamp),
              provider: PROVIDER,
              providerInstanceId: options.instanceId,
              threadId: context.threadId,
              payload: {
                state: "compacted",
                ...(tokensBefore !== undefined ? { beforeTokens: tokensBefore } : {}),
                ...(estimatedAfter !== undefined ? { afterTokens: estimatedAfter } : {}),
              },
            });
            // Pi invalidates its context-window estimate right after a
            // compaction; the stats read will skip the meter update until a
            // fresh assistant response restores a usable estimate.
            yield* startSessionTokenUsageRead(context, turnId);
          }
          return;
        }
        case "auto_retry_start": {
          const attempt =
            typeof record.attempt === "number" ? Math.trunc(record.attempt) : undefined;
          const maxAttempts =
            typeof record.maxAttempts === "number" ? Math.trunc(record.maxAttempts) : undefined;
          const reason = trimOrUndefined(record.errorMessage);
          yield* emit({
            type: "runtime.warning",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: context.threadId,
            turnId,
            payload: {
              message: "Pi is retrying after a transient provider error.",
              detail: {
                ...(attempt !== undefined ? { attempt } : {}),
                ...(maxAttempts !== undefined ? { maxAttempts } : {}),
                ...(reason ? { errorMessage: reason } : {}),
              },
            },
          });
          return;
        }
        case "auto_retry_end": {
          if (record.success === false) {
            context.turnOutcome = {
              state: "failed",
              errorMessage: trimOrUndefined(record.finalError) ?? "Pi exhausted its retries.",
            };
          }
          return;
        }
        case "extension_error": {
          const message = trimOrUndefined(record.error) ?? "A Pi extension threw an error.";
          const extensionPath = trimOrUndefined(record.extensionPath);
          const extensionEvent = trimOrUndefined(record.event);
          yield* emit({
            type: "runtime.warning",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: context.threadId,
            turnId,
            payload: {
              message: truncate(message, MAX_ITEM_TITLE_CHARS),
              detail: {
                ...(extensionPath ? { extensionPath } : {}),
                ...(extensionEvent ? { event: extensionEvent } : {}),
              },
            },
          });
          return;
        }
        case "extension_ui_request": {
          const request = record as unknown as PiExtensionUiRequest;
          if (request.method === "notify") {
            const message = piNotifyMessage(request);
            const notifyType = trimOrUndefined(request.notifyType) ?? "info";
            // Only warnings and errors have a T3 surface; `info` is extension
            // chatter with nowhere to go, and `setStatus`/`setWidget`/`setTitle`
            // describe TUI chrome that has no counterpart here.
            if (!message || (notifyType !== "warning" && notifyType !== "error")) return;
            yield* emit({
              type: "runtime.warning",
              ...(yield* stamp),
              provider: PROVIDER,
              providerInstanceId: options.instanceId,
              threadId: context.threadId,
              turnId,
              payload: { message: truncate(message, MAX_ITEM_TITLE_CHARS) },
            });
            return;
          }
          yield* handleDialog(context, request);
          return;
        }
        default:
          return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logWarning("Pi event handling failed", { eventType: record.type, cause }),
      ),
    );

  /**
   * Applies the thread's model and thinking selection through Pi's own
   * setters, so the running agent — not just the next process launch — sees it.
   * A rejected selection fails the turn: silently ignoring it would run the
   * requested work on a model the user did not choose.
   */
  const applyModelSelection = (
    context: SessionContext,
    modelSelection: { readonly model: string; readonly options?: unknown } | undefined,
  ) =>
    Effect.gen(function* () {
      if (!modelSelection) return;
      const requested = modelSelection.model.trim();
      if (requested.length > 0 && requested !== context.session.model) {
        const { provider, model } = splitPiModelSlug(requested);
        yield* context.transport
          .request(
            { type: "set_model", modelId: model, ...(provider ? { provider } : {}) },
            { timeout: MODEL_REQUEST_TIMEOUT_MS },
          )
          .pipe(Effect.mapError((cause) => requestError(context.threadId, "set_model", cause)));
        context.session = { ...context.session, model: requested };
      }
      const thinkingLevel = getModelSelectionStringOptionValue(
        modelSelection as never,
        "reasoningEffort",
      );
      if (thinkingLevel) {
        yield* context.transport
          .request({ type: "set_thinking_level", level: thinkingLevel })
          .pipe(
            Effect.mapError((cause) => requestError(context.threadId, "set_thinking_level", cause)),
          );
      }
    });

  const startSession: Adapter["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (!settings.enabled) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Enable Pi in provider settings before starting a thread.",
          });
        }
        if (
          (input.provider !== undefined && input.provider !== PROVIDER) ||
          (input.providerInstanceId !== undefined &&
            input.providerInstanceId !== options.instanceId) ||
          (input.modelSelection !== undefined &&
            input.modelSelection.instanceId !== options.instanceId)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The Pi provider instance does not match the requested session.",
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The session requires a workspace directory.",
          });
        }
        const cursor = decodeResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && Option.isNone(cursor)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "The saved Pi session is invalid. Start a new thread.",
          });
        }
        const cursorTurnStarts = Option.isSome(cursor)
          ? (decodeTurnStartEntryIds(cursor.value.turnStartEntryIds) ?? [])
          : [];
        const previous = sessions.get(input.threadId);
        if (previous) yield* stopContext(previous);
        const cwd = path.resolve(input.cwd);
        const sessionScope = yield* Scope.make("sequential");
        let transferred = false;
        let context: SessionContext | undefined;
        yield* Effect.addFinalizer(() => {
          if (transferred) return Effect.void;
          sessions.delete(input.threadId);
          return Scope.close(sessionScope, Exit.void);
        });

        return yield* Effect.gen(function* () {
          const modelSlug = input.modelSelection?.model?.trim();
          const thinkingLevel = input.modelSelection
            ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
            : undefined;
          const launchArgs = buildPiLaunchArgs({
            settings,
            sessionDir: options.sessionDir,
            ...(Option.isSome(cursor) ? { resumeSessionId: cursor.value.sessionId } : {}),
            ...(modelSlug ? { modelSlug } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
          });
          const transport = yield* (
            options.makeTransport
              ? options.makeTransport({
                  cwd,
                  args: launchArgs,
                  env: options.environment,
                  threadId: input.threadId,
                })
              : PiRpcTransport.make({
                  binaryPath: settings.binaryPath || "pi",
                  args: launchArgs,
                  cwd,
                  env: options.environment,
                  onStderr: (chunk) => logNative({ direction: "err", chunk }, input.threadId),
                })
          ).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              options.childProcessSpawner,
            ),
          );
          yield* logNative({ direction: "spawn", pid: transport.pid }, input.threadId);

          // `get_state` is the cheapest proof that the process is speaking the
          // protocol, and it yields the session id a resume cursor needs.
          const state = decodeRecord(
            yield* transport.request({ type: "get_state" }, { timeout: MODEL_REQUEST_TIMEOUT_MS }),
          );
          const reportedSessionId = trimOrUndefined(state?.sessionId);
          const cursorSessionId = Option.isSome(cursor) ? cursor.value.sessionId : undefined;
          const sessionId = reportedSessionId ?? cursorSessionId;
          if (!sessionId) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "get_state",
              detail: "Pi started but did not report a session id.",
            });
          }
          // Entry ids are only unique within a session. If Pi started a
          // different session than the cursor named — the saved one was gone —
          // the cursor's boundaries can name unrelated messages, so keeping
          // them could silently fork before the wrong entry. Dropping them
          // makes a rollback for those turns fail with a clear "never
          // recorded" message instead.
          const sessionChanged =
            cursorSessionId !== undefined &&
            reportedSessionId !== undefined &&
            reportedSessionId !== cursorSessionId;
          if (sessionChanged) {
            yield* Effect.logWarning(
              "Pi reported a different session id than the resume cursor; rewind boundaries were dropped because entry ids are only meaningful within a session",
              { threadId: input.threadId, cursorSessionId, reportedSessionId },
            );
          }
          const restoredTurnStarts = sessionChanged ? [] : cursorTurnStarts;

          const createdAt = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            cwd,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(modelSlug ? { model: modelSlug } : {}),
            resumeCursor: piResumeCursor(sessionId, restoredTurnStarts),
            createdAt,
            updatedAt: createdAt,
          };
          const running: SessionContext = {
            threadId: input.threadId,
            cwd,
            scope: sessionScope,
            transport,
            promptLock: yield* Semaphore.make(1),
            stopLock: yield* Semaphore.make(1),
            dialogs: new Map(),
            tools: new Map(),
            turns: [],
            restoredTurnStarts,
            sessionId,
            boundaryAnchor: undefined,
            session,
            activeTurn: undefined,
            assistantItemId: undefined,
            generation: 0,
            turnOutcome: { state: "completed" },
            turnUsage: undefined,
            sessionStatsRead: undefined,
            stopped: false,
          };
          context = running;
          sessions.set(input.threadId, running);

          yield* startWorkflowSweep(running);

          yield* Stream.runForEach(transport.events, (record) => handleEvent(running, record)).pipe(
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(sessionScope),
          );
          // The process can die between turns. Reporting its exit is what lets
          // the client explain a thread that went quiet, and it also releases
          // any dialog Pi was blocked on.
          yield* transport.exited.pipe(
            Effect.flatMap((code) =>
              Effect.gen(function* () {
                if (running.stopped) return;
                running.stopped = true;
                yield* cancelDialogs(running);
                const active = running.activeTurn;
                if (active && !active.intent.settled) {
                  yield* Deferred.succeed(active.settled, undefined).pipe(Effect.ignore);
                }
                yield* emit({
                  type: "session.exited",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  providerInstanceId: options.instanceId,
                  threadId: input.threadId,
                  payload: {
                    reason: `Pi exited with code ${code}.`,
                    exitKind: code === 0 ? "graceful" : "error",
                  },
                });
              }),
            ),
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(sessionScope),
          );

          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            payload: { resume: { schemaVersion: 1, sessionId } },
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Pi RPC session ready" },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            payload: { providerThreadId: sessionId },
          });

          transferred = true;
          return session;
        }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError((cause) =>
            isProviderAdapterRequestError(cause) || isProviderAdapterValidationError(cause)
              ? cause
              : requestError(input.threadId, "session/start", cause),
          ),
        );
      }).pipe(Effect.scoped),
    );

  const sendTurn: Adapter["sendTurn"] = Effect.fn("PiAdapter.sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "The selected model belongs to another provider instance.",
      });
    }
    const prompt = input.input?.trim() ?? "";
    if (prompt.length === 0) {
      // Pi has no promptless continuation: every turn needs a message.
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Pi requires a message on every turn.",
      });
    }
    const { images, skipped } = yield* buildPiPromptImages({
      attachments: input.attachments,
      attachmentsDir: serverConfig.attachmentsDir,
    }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
    for (const skip of skipped) {
      yield* emit({
        type: "runtime.warning",
        ...(yield* stamp),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: input.threadId,
        payload: {
          message: `Pi skipped image attachment '${skip.name}': ${skip.reason}. The turn continues with its file path in the text.`,
        },
      });
    }

    const launch = yield* context.promptLock.withPermit(
      Effect.gen(function* () {
        yield* requireSession(input.threadId);
        const active = context.activeTurn;
        if (active && !active.intent.settled) {
          // Mid-turn prompts steer the running turn rather than opening a new
          // one, which is what Pi's `steer` queue is for. Both callers settle
          // together and only one emits `turn.completed`.
          yield* applyModelSelection(context, input.modelSelection);
          yield* context.transport
            .request({
              type: "prompt",
              message: prompt,
              ...(images.length > 0 ? { images } : {}),
              streamingBehavior: "steer",
            })
            .pipe(Effect.mapError((cause) => requestError(input.threadId, "prompt", cause)));
          return { intent: active.intent, settled: active.settled };
        }

        // The position this turn starts from is what lets a rewind name the
        // entry to fork before. It is read here — under the prompt lock and
        // before the prompt — so it can never accidentally include this turn's
        // own user message; a resumed session relearns it on its first turn.
        if (context.boundaryAnchor === undefined) {
          context.boundaryAnchor = piBoundaryAnchor(yield* readPiActivePath(context));
        }
        const turnId = TurnId.make(yield* randomId);
        const intent: TurnIntent = {
          turnId,
          generation: context.generation + 1,
          settled: false,
        };
        const settled = yield* Deferred.make<void>();
        context.generation = intent.generation;
        context.activeTurn = { intent, settled };
        context.turnOutcome = { state: "completed" };
        context.turnUsage = undefined;
        context.assistantItemId = undefined;
        context.tools.clear();
        context.turns.push({
          id: turnId,
          items: [],
          anchorEntryId: context.boundaryAnchor,
          startEntryId: null,
        });
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };
        yield* emit({
          type: "turn.started",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          turnId,
          payload: input.modelSelection?.model ? { model: input.modelSelection.model } : {},
        });
        yield* emit({
          type: "session.state.changed",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          payload: { state: "running" },
        });
        yield* applyModelSelection(context, input.modelSelection);
        yield* context.transport
          .request({
            type: "prompt",
            message: prompt,
            ...(images.length > 0 ? { images } : {}),
          })
          .pipe(Effect.mapError((cause) => requestError(input.threadId, "prompt", cause)));
        return { intent, settled };
      }),
    );

    yield* Effect.raceFirst(
      Deferred.await(launch.settled),
      context.transport.exited.pipe(Effect.asVoid),
    ).pipe(Effect.mapError((cause) => requestError(input.threadId, "prompt", cause)));

    if (context.stopped) {
      return yield* new ProviderAdapterSessionClosedError({
        provider: PROVIDER,
        threadId: input.threadId,
      });
    }
    const settledNow = yield* context.promptLock.withPermit(finishTurn(context, launch.intent));
    // Both follow-up reads run only in the fiber that settled the turn and
    // only after the prompt lock is released, so neither can delay the
    // terminal events or block steering and rollback behind it.
    if (settledNow) {
      yield* resolveFinishedTurnBoundary(context, launch.intent.turnId);
      // The meter update is started only after the turn is reported, so a slow
      // stats read is never on the settlement path.
      yield* startSessionTokenUsageRead(context, launch.intent.turnId);
    }
    return {
      threadId: input.threadId,
      turnId: launch.intent.turnId,
      resumeCursor: context.session.resumeCursor,
    };
  });

  const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const active = context.activeTurn;
        if (!active || active.intent.settled) return;
        // Recorded before `abort` so a settlement triggered by the abort itself
        // reports "cancelled" instead of racing to "completed".
        context.turnOutcome = { state: "cancelled", stopReason: "aborted" };
        yield* context.transport
          .request({ type: "abort" })
          .pipe(Effect.mapError((cause) => requestError(threadId, "abort", cause)));
        yield* Deferred.succeed(active.settled, undefined).pipe(Effect.ignore);
      }),
    );

  const answerFor = (question: UserInputQuestion, answers: ProviderUserInputAnswers) => {
    const raw = answers[question.id];
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) {
      const first = raw.find((entry): entry is string => typeof entry === "string");
      return first;
    }
    if (typeof raw === "boolean") return raw ? "yes" : "no";
    return undefined;
  };

  const respondToRequest: Adapter["respondToRequest"] = (threadId, _requestId, _decision) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToRequest",
        issue:
          "Pi runs tools without an approval protocol. Approvals arrive as user-input requests.",
      });
    });

  const respondToUserInput: Adapter["respondToUserInput"] = (threadId, requestId, answers) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const dialog = context.dialogs.get(requestId);
        if (!dialog) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: "That Pi prompt is no longer waiting for an answer.",
          });
        }
        context.dialogs.delete(requestId);
        const answer = answerFor(dialog.question, answers);
        yield* context.transport
          .notify(piResponseFromAnswers(dialog.request, answer))
          .pipe(Effect.mapError((cause) => requestError(threadId, "extension_ui_response", cause)));
        yield* emit({
          type: "user-input.resolved",
          ...(yield* stamp),
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId,
          requestId: RuntimeRequestId.make(dialog.request.id),
          payload: { answers },
        });
      }),
    );

  const stopSession: Adapter["stopSession"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.flatMap(requireSession(threadId), (context) => stopContext(context)),
    );

  /**
   * Rewinds by replacing Pi's session with a branch that ends just before the
   * first removed turn.
   *
   * Pi has no in-place rewind. `fork` "Create[s] a new fork from a previous
   * user message on the active branch" and rebuilds the whole session around
   * it — a new file and a new session id — so the branch it leaves behind *is*
   * the rewind. The RPC command takes only an entry id and always forks before
   * that entry, which fixes the boundary as the user message that starts the
   * first removed turn.
   *
   * Naming that entry needs a fact from each side. Pi is authoritative about
   * the entries: `get_entries` is append-only, "includes pre-compaction
   * history", and returns `leafId`, so the active branch can be read again
   * after a resume. T3 is authoritative about which entry starts a turn,
   * because only the adapter knows where each turn began; that entry id is
   * persisted in the resume cursor, one per turn. Both are read at rewind time
   * and cross-checked afterwards, because a snapshot that no longer matches
   * the live session is worse than no rewind at all.
   */
  const rollbackThread: Adapter["rollbackThread"] = (threadId, numTurns) =>
    withThreadLock(
      threadId,
      Effect.flatMap(requireSession(threadId), (context) =>
        // The prompt lock keeps a rewind from racing the launch of a turn.
        context.promptLock.withPermit(
          Effect.gen(function* () {
            if (!Number.isInteger(numTurns) || numTurns < 1) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "rollbackThread",
                issue: "numTurns must be an integer >= 1.",
              });
            }
            if (context.activeTurn && !context.activeTurn.intent.settled) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "rollbackThread",
                issue: "Pi cannot rewind while a turn is running. Interrupt the turn and retry.",
              });
            }
            const totalTurns = context.restoredTurnStarts.length + context.turns.length;
            if (numTurns > totalTurns) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/rollback",
                detail: `This Pi session has observed ${totalTurns} turn(s), so a ${numTurns}-turn rewind has no boundary T3 can name. The provider may hold history this server never saw, for example after a restart. Start a new thread instead.`,
              });
            }
            const retainedCount = totalTurns - numTurns;
            const restoredCount = context.restoredTurnStarts.length;
            const boundaryEntryId =
              retainedCount < restoredCount
                ? (context.restoredTurnStarts[retainedCount] ?? null)
                : (context.turns[retainedCount - restoredCount]?.startEntryId ?? null);
            if (boundaryEntryId === null) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/rollback",
                detail:
                  "The Pi session entry that starts the turn being rewound was never recorded: Pi's session tree could not be read for that turn, or the thread was resumed before this server saved rewind boundaries. Start a new thread instead.",
              });
            }
            const before = yield* readPiEntries(context);
            const path = piActivePath(before.entries, before.leafId);
            if (!path) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/rollback",
                detail:
                  "Pi reported a session tree whose active branch could not be walked, so the rewind boundary is unavailable.",
              });
            }
            const userEntries = path.filter(isPiUserEntry);
            const boundaryIndex = userEntries.findIndex((entry) => entry.id === boundaryEntryId);
            if (boundaryIndex < 0) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/rollback",
                detail:
                  "Pi's session no longer holds the user message that starts the turn being rewound, so the rewind boundary is unavailable. Start a new thread instead.",
              });
            }
            const boundary = userEntries[boundaryIndex]!;
            const expectedUserIds = userEntries.slice(0, boundaryIndex).map((entry) => entry.id);
            const knownMessageIds = new Set(
              before.entries.filter((entry) => entry.type === "message").map((entry) => entry.id),
            );

            // A dialog is a promise Pi is blocked on, and the fork tears that
            // session down underneath it.
            yield* cancelDialogs(context);

            const fork = decodeRecord(
              yield* context.transport
                .request(
                  { type: "fork", entryId: boundary.id },
                  { timeout: MODEL_REQUEST_TIMEOUT_MS },
                )
                .pipe(Effect.mapError((cause) => requestError(threadId, "fork", cause))),
            );
            if (fork?.cancelled === true) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/rollback",
                detail:
                  "A Pi extension cancelled the fork, so the conversation was left unchanged.",
              });
            }

            // Pi copies the retained entries verbatim, so the rewound branch
            // must be exactly the prefix before the boundary entry. Anything
            // else means the live session no longer matches this thread's
            // turns.
            const after = yield* readPiEntries(context);
            const afterPath = piActivePath(after.entries, after.leafId);
            const afterUserIds = afterPath?.filter(isPiUserEntry).map((entry) => entry.id) ?? [];
            const boundaryHeld =
              afterPath !== undefined &&
              afterUserIds.length === expectedUserIds.length &&
              afterUserIds.every((id, index) => id === expectedUserIds[index]) &&
              after.entries
                .filter((entry) => entry.type === "message")
                .every((entry) => knownMessageIds.has(entry.id));
            if (!boundaryHeld) {
              // The session was already replaced, so point future resumes at
              // the live branch before reporting that the rewind was wrong.
              context.boundaryAnchor = piBoundaryAnchor(afterPath);
              yield* adoptForkedSession(context);
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/rollback",
                detail:
                  "Pi did not preserve the requested rewind boundary, so the live session no longer matches this thread's turn history.",
              });
            }

            // Retained boundaries survive the fork because the retained entries
            // and their ids do; the rewound ones must not be resumed into.
            if (retainedCount < restoredCount) {
              context.restoredTurnStarts.splice(retainedCount);
              context.turns.splice(0);
            } else {
              context.turns.splice(retainedCount - restoredCount);
            }
            yield* adoptForkedSession(context);
            context.boundaryAnchor = piBoundaryAnchor(afterPath);
            return snapshotThread(context);
          }),
        ),
      ),
    );

  const stopAll: Adapter["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.void : Effect.logError("Could not stop a Pi session."),
      ),
      Effect.ensuring(PubSub.shutdown(events)),
    ),
  );

  return {
    provider: PROVIDER,
    // Pi has no in-place rewind, but it can fork before a known user entry,
    // and the entry ids a rewind needs are persisted per turn in the resume
    // cursor — so the capability holds for a resumed thread too.
    // Rewind is withheld, and the flag has to match what the code can do: the
    // boundary machinery can mis-anchor after a session-tree read is lost, and a
    // rewind that removes more turns than the user asked for is worse than no
    // rewind at all. The implementation stays; the affordance does not.
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsConversationRollback: false,
    },
    // Pi compacts natively; `compaction_start`/`compaction_end` then report it.
    compaction: {
      type: "native",
      start: (threadId) =>
        requireSession(threadId).pipe(
          Effect.flatMap((context) =>
            context.transport
              .request({ type: "compact" })
              .pipe(Effect.mapError((cause) => requestError(threadId, "compact", cause))),
          ),
          Effect.asVoid,
        ),
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) => Effect.map(requireSession(threadId), snapshotThread),
    rollbackThread,
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
