/**
 * Model-free stand-in for an interactive `pi --mode rpc` agent session.
 *
 * Where `fakePiRpc.mjs` exercises the transport (framing, correlation,
 * timeouts), this fixture exercises the adapter: it answers the session
 * commands and replays a realistic event sequence per prompt. The prompt text
 * selects the script, so one fixture covers the happy path, retry exhaustion,
 * extension dialogs, and aborts.
 *
 * It also keeps a session tree, because a rewind can only be recognised by the
 * entries Pi reports for it: every message event is persisted as an entry with
 * a parent, `get_entries` reports them plus `leafId`, and `fork` rebuilds the
 * session around a user entry exactly like Pi does (retained ids survive, the
 * session id does not).
 *
 * The tree is persisted under `--session-dir` keyed by session id, because Pi
 * persists it too: a *new* process launched with `--session-id` resumes the
 * entries the previous one left behind, which is what an adapter restart (or
 * the test for one) sees. `FAKE_PI_REASSIGN_SESSION_ID` models Pi losing the
 * saved session: the fixture then reports that id and an empty tree instead of
 * the one the resume named.
 *
 * Prompts starting with `/` are directives, not content:
 *   /fail        exhaust retries, then settle
 *   /slow        settle only after FAKE_PI_SETTLE_DELAY_MS
 *   /dialog      ask a question with `select` and wait for the answer
 *   /notify      emit warn/error notifies plus status chatter
 *   /state       reply `session=<id> users=<n>` for the entries seen so far
 *   /model       reply `model=<provider>/<id>` for the model Pi actually holds
 *   /fork-cancel make the next `fork` answer `cancelled: true`
 *   /fork-wrong  make the next `fork` cut one user message too far back
 *   /stats-fail  make the next `get_session_stats` answer `success: false`
 *   /stats-hold  hold the next `get_session_stats` answer until the next command
 *   /entries-fail make the next `get_entries` answer `success: false`
 *   /entries-hold hold the next `get_entries` answer until the next command
 *
 * When a `prompt` carries native `images`, the turn answers with
 * `images=<count> <mimeType,...>` instead of the default script, so a test can
 * observe exactly which images crossed the wire.
 *
 * Run as: node fakePiAgent.mjs [--session-dir <dir>] [--session-id <id>]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let buffer = "";
let settling = false;

const write = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const respond = (id, command, data) => {
  write({
    type: "response",
    id,
    command,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
};

const argv = process.argv.slice(2);
const argValue = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const sessionIdArg = argValue("--session-id");
const sessionDir = argValue("--session-dir") ?? join(tmpdir(), "fake-pi-sessions");
let sessionId = sessionIdArg ?? "01a0ae8e-fake-session-id";

/** Pi's append-only session tree, as `get_entries` reports it. */
let entries = [];
let leafId = null;
let entrySeq = 0;
/** Set by a directive so a test can drive a refused or wrong fork. */
let forkBehavior = "ok";
let forkSeq = 0;
/** Set by a directive so a test can drive an unreadable session tree. */
let entriesShouldFail = false;

const sessionPath = (id) => join(sessionDir, `${id}.json`);

/** Persists the tree so a process resumed with the same session id sees it. */
const saveSession = () => {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    sessionPath(sessionId),
    JSON.stringify({ id: sessionId, entries, leafId, entrySeq, forkSeq }),
  );
};

const entrySeqFromEntries = () =>
  entries.reduce(
    (max, entry) => Math.max(max, Number.parseInt(String(entry.id).slice(1), 10) || 0),
    0,
  );

/** Loads the tree a previous process left for `id`, if there is one. */
const loadSession = (id) => {
  try {
    const stored = JSON.parse(readFileSync(sessionPath(id), "utf8"));
    if (Array.isArray(stored.entries)) entries = stored.entries;
    leafId = typeof stored.leafId === "string" ? stored.leafId : null;
    entrySeq = Number.isInteger(stored.entrySeq) ? stored.entrySeq : entrySeqFromEntries();
    forkSeq = Number.isInteger(stored.forkSeq) ? stored.forkSeq : 0;
  } catch {
    // No stored session: `--session-id` names a session this process starts.
  }
};

if (sessionIdArg !== undefined) {
  // Pi starts a new session when the one a resume names is gone; a test uses
  // this to make the reported id differ from the one the cursor carried.
  const reassignedSessionId = process.env.FAKE_PI_REASSIGN_SESSION_ID;
  if (reassignedSessionId !== undefined && reassignedSessionId.length > 0) {
    sessionId = reassignedSessionId;
  } else {
    loadSession(sessionIdArg);
  }
}

/**
 * Mirrors Pi's own invalidation: a compaction lets `contextUsage.tokens` go
 * null until a fresh assistant response supplies valid usage again. The
 * fixture clears it when it serves that null estimate, so a test that compacts
 * and then runs another turn observes exactly one valid usage read.
 */
let statsContextUnavailable = false;
/** Set by a directive so a test can drive a failing `get_session_stats`. */
let statsShouldFail = false;
/** Set by a directive so the next `get_session_stats` is held open. */
let statsShouldHold = false;
/** Releases a held `get_session_stats`, if one is waiting. */
let heldStatsResponse = null;
/** Set by a directive so the next `get_entries` is held open. */
let entriesShouldHold = false;
/** Releases a held `get_entries`, if one is waiting. */
let heldEntriesResponse = null;
/** User entries that existed before the prompt currently being handled. */
let promptUsersBefore = 0;
/** Images the in-flight `prompt` carried, echoed back by `runTurn`. */
let promptImages = [];

const appendEntry = (message) => {
  const id = `e${++entrySeq}`;
  entries.push({ id, parentId: leafId, type: "message", timestamp: Date.now(), message });
  leafId = id;
  saveSession();
};

const userEntryCount = () => entries.filter((entry) => entry.message?.role === "user").length;

/** Keeps the branch ending at `leaf`, dropping everything after it. */
const truncateTo = (leaf) => {
  if (!leaf) {
    entries = [];
    leafId = null;
    return;
  }
  const index = entries.findIndex((entry) => entry.id === leaf);
  entries = entries.slice(0, index + 1);
  leafId = entries.at(-1)?.id ?? null;
};

let currentModel = {
  id: "opencode-go/kimi-k3",
  name: "opencode-go/kimi-k3",
  provider: "local-openai",
  reasoning: true,
  input: ["text"],
  contextWindow: 131072,
  maxTokens: 8192,
};

const usage = (index) => ({
  input: 100 + index,
  output: index + 1,
  cacheRead: 40,
  cacheWrite: 5,
  totalTokens: 100 + index + index + 1 + 45,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** Replies with one assistant message and settles the turn. */
const replyText = (text) => {
  const reply = { role: "assistant", content: [{ type: "text", text }] };
  write({ type: "message_start", message: reply });
  write({
    type: "message_update",
    usage: usage(0),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
  write({ type: "message_end", message: reply });
  appendEntry(reply);
  write({ type: "turn_end", message: reply, toolResults: [] });
  settle();
};

const runTurn = (message) => {
  const trimmed = message.trim();
  const directive = trimmed.startsWith("/") ? (trimmed.slice(1).split(/\s+/)[0] ?? "") : "";
  write({ type: "turn_start" });

  if (promptImages.length > 0) {
    const mimeTypes = promptImages.map((image) => image.mimeType).join(",");
    const summary = `images=${promptImages.length} ${mimeTypes}`;
    const imageMessage = { role: "assistant", content: [{ type: "text", text: summary }] };
    write({ type: "message_start", message: imageMessage });
    write({
      type: "message_update",
      usage: usage(0),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: summary },
    });
    write({ type: "message_end", message: imageMessage });
    appendEntry(imageMessage);
    write({ type: "turn_end", message: imageMessage, toolResults: [] });
    settle();
    return;
  }

  if (directive === "state") {
    replyText(`session=${sessionId} users=${promptUsersBefore}`);
    return;
  }

  if (directive === "model") {
    // Echoes the model Pi actually holds, so a test can observe a `set_model`
    // that crossed the wire rather than the adapter's local bookkeeping.
    const held = `${currentModel.provider ? `${currentModel.provider}/` : ""}${currentModel.id}`;
    replyText(`model=${held}`);
    return;
  }

  if (directive === "notify") {
    write({ type: "extension_ui_request", id: "ui-status", method: "setStatus", statusKey: "x" });
    write({
      type: "extension_ui_request",
      id: "ui-info",
      method: "notify",
      message: "info chatter",
      notifyType: "info",
    });
    write({
      type: "extension_ui_request",
      id: "ui-warn",
      method: "notify",
      message: "extension warning",
      notifyType: "warning",
    });
  }

  if (directive === "fork-cancel") {
    forkBehavior = "cancel";
  }
  if (directive === "fork-wrong") {
    forkBehavior = "wrong";
  }
  if (directive === "stats-fail") {
    statsShouldFail = true;
  }
  if (directive === "stats-hold") {
    statsShouldHold = true;
  }
  if (directive === "entries-fail") {
    entriesShouldFail = true;
  }
  if (directive === "entries-hold") {
    entriesShouldHold = true;
  }

  if (directive === "fail") {
    write({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: "529 overloaded_error",
    });
    write({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "529 overloaded_error",
    });
    // Real Pi still emits the turn tail after retries are exhausted. The
    // adapter must not read `turn_end` as "this turn succeeded".
    write({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
      toolResults: [],
    });
    settle();
    return;
  }

  if (directive === "dialog") {
    const id = "dialog-1";
    write({
      type: "extension_ui_request",
      id,
      method: "select",
      title: "Allow dangerous command?",
      options: ["Allow", "Block"],
      timeout: 60000,
    });
    // Pi blocks here until the client answers. Emitting the answer as a
    // visible assistant message is what lets a test observe that the reply was
    // actually forwarded.
    pendingDialog = (value) => {
      write({ type: "message_start", message: { role: "assistant", content: [] } });
      write({
        type: "message_update",
        usage: usage(0),
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `answer:${value}` },
      });
      write({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `answer:${value}` }] },
      });
      settle();
    };
    return;
  }

  write({ type: "message_start", message: { role: "assistant", content: [] } });
  // Extension chatter arrives as custom messages and must not become assistant items.
  const customNoise = {
    role: "custom",
    customType: "remote-pi:name-assigned",
    content: "noise",
  };
  write({ type: "message_start", message: customNoise });
  write({ type: "message_end", message: customNoise });
  appendEntry(customNoise);
  write({
    type: "message_update",
    usage: usage(0),
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "thinking…" },
  });
  write({
    type: "message_update",
    usage: usage(1),
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello " },
  });
  write({
    type: "message_update",
    usage: usage(2),
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "world" },
  });
  write({
    type: "message_update",
    usage: usage(3),
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 2,
      id: "call-1",
      toolName: "bash",
    },
  });
  write({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "ls -la" },
  });
  write({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "ls -la" },
    partialResult: { content: [{ type: "text", text: "total 48\n" }], details: {} },
  });
  // Pi resends everything accumulated; only the new tail may be forwarded.
  write({
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "ls -la" },
    partialResult: { content: [{ type: "text", text: "total 48\nfile.txt\n" }], details: {} },
  });
  write({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "total 48\nfile.txt\n" }], details: {} },
    isError: false,
  });
  write({
    type: "tool_execution_start",
    toolCallId: "call-2",
    toolName: "read",
    args: { file_path: "/root/Dev/t3code/AGENTS.md" },
  });
  write({
    type: "tool_execution_end",
    toolCallId: "call-2",
    toolName: "read",
    result: { content: [{ type: "text", text: "x".repeat(9000) }], details: {} },
    isError: true,
  });
  const assistantMessage = { role: "assistant", content: [{ type: "text", text: "Hello world" }] };
  const toolResults = [{ role: "tool", content: "total 48\nfile.txt\n" }];
  write({ type: "message_end", message: assistantMessage });
  appendEntry(assistantMessage);
  write({ type: "turn_end", message: assistantMessage, toolResults });
  for (const toolResult of toolResults) {
    appendEntry(toolResult);
  }

  if (directive === "slow") {
    setTimeout(settle, Number(process.env.FAKE_PI_SETTLE_DELAY_MS ?? 400));
    return;
  }
  settle();
};

let pendingDialog = null;

const settle = () => {
  settling = false;
  write({ type: "agent_settled" });
};

/** `get_session_stats` payload; consumes the post-compaction invalidation once. */
const sessionStatsPayload = () => {
  const invalidated = statsContextUnavailable;
  statsContextUnavailable = false;
  return {
    sessionFile: `/tmp/fake/${sessionId}.jsonl`,
    sessionId,
    userMessages: entries.filter((entry) => entry.message?.role === "user").length,
    tokens: { input: 12000, output: 3400, cacheRead: 50000, cacheWrite: 2000, total: 67400 },
    cost: 0.12,
    contextUsage: invalidated
      ? { tokens: null, contextWindow: currentModel.contextWindow, percent: null }
      : { tokens: 61000, contextWindow: currentModel.contextWindow, percent: 47 },
  };
};

const handle = (command) => {
  const id = command.id;
  // A held answer is released by the next command, which is how a test keeps
  // an RPC open for exactly as long as it wants without depending on a clock.
  if (heldStatsResponse && command.type !== "get_session_stats") {
    const release = heldStatsResponse;
    heldStatsResponse = null;
    release();
  }
  if (heldEntriesResponse && command.type !== "get_entries") {
    const release = heldEntriesResponse;
    heldEntriesResponse = null;
    release();
  }
  switch (command.type) {
    case "get_state":
      respond(id, "get_state", {
        model: currentModel,
        thinkingLevel: "high",
        isStreaming: settling,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        sessionFile: `/tmp/fake/${sessionId}.jsonl`,
        sessionId,
        messageCount: entries.length,
        pendingMessageCount: 0,
      });
      return;
    case "get_entries":
      if (entriesShouldFail) {
        entriesShouldFail = false;
        write({
          type: "response",
          id,
          command: "get_entries",
          success: false,
          error: "session tree unavailable",
        });
        return;
      }
      if (entriesShouldHold) {
        entriesShouldHold = false;
        heldEntriesResponse = () => respond(id, "get_entries", { entries, leafId });
        return;
      }
      respond(id, "get_entries", { entries, leafId });
      return;
    case "get_session_stats":
      if (statsShouldFail) {
        statsShouldFail = false;
        write({
          type: "response",
          id,
          command: "get_session_stats",
          success: false,
          error: "stats unavailable",
        });
        return;
      }
      if (statsShouldHold) {
        statsShouldHold = false;
        heldStatsResponse = () => respond(id, "get_session_stats", sessionStatsPayload());
        return;
      }
      respond(id, "get_session_stats", sessionStatsPayload());
      return;
    case "fork": {
      const behavior = forkBehavior;
      forkBehavior = "ok";
      const index = entries.findIndex((entry) => entry.id === command.entryId);
      const entry = index >= 0 ? entries[index] : undefined;
      if (!entry || entry.message?.role !== "user") {
        write({
          type: "response",
          id,
          command: "fork",
          success: false,
          error: `Invalid entry ID for forking: ${String(command.entryId)}`,
        });
        return;
      }
      if (behavior === "cancel") {
        respond(id, "fork", { text: "", cancelled: true });
        return;
      }
      // Pi forks *before* the given entry and copies the retained path into a
      // new session file, so the entries keep their ids but the session does
      // not. The old session file is left behind untouched, like Pi's.
      let target = entry.parentId;
      if (behavior === "wrong") {
        const previousUser = entries
          .slice(0, index)
          .findLast((candidate) => candidate.message?.role === "user");
        target = previousUser ? previousUser.parentId : null;
      }
      truncateTo(target);
      sessionId = `fake-fork-${++forkSeq}`;
      saveSession();
      respond(id, "fork", { text: entry.message.content, cancelled: false });
      return;
    }
    case "set_model": {
      if (process.env.FAKE_PI_REJECT_MODEL === command.modelId) {
        write({
          type: "response",
          id,
          command: "set_model",
          success: false,
          error: `unknown model: ${command.modelId}`,
        });
        return;
      }
      currentModel = {
        ...currentModel,
        id: command.modelId,
        name: command.modelId,
        provider: command.provider ?? currentModel.provider,
      };
      respond(id, "set_model", currentModel);
      return;
    }
    case "set_thinking_level":
      respond(id, "set_thinking_level", { level: command.level });
      return;
    case "get_available_thinking_levels":
      respond(id, "get_available_thinking_levels", {
        levels: ["off", "minimal", "low", "medium", "high"],
      });
      return;
    case "prompt":
      if (settling && command.streamingBehavior !== "steer") {
        write({
          type: "response",
          id,
          command: "prompt",
          success: false,
          error: "agent is streaming; specify streamingBehavior",
        });
        return;
      }
      respond(id, "prompt");
      // Pi persists the user message as a session entry on `message_end`.
      promptUsersBefore = userEntryCount();
      promptImages = Array.isArray(command.images) ? command.images : [];
      const userMessage = {
        role: "user",
        content: command.message ?? "",
        timestamp: Date.now(),
      };
      write({ type: "message_start", message: userMessage });
      write({ type: "message_end", message: userMessage });
      appendEntry(userMessage);
      if (command.streamingBehavior === "steer") {
        // A steer message joins the running turn and produces no new events of
        // its own until that turn settles.
        return;
      }
      settling = true;
      runTurn(command.message ?? "");
      return;
    case "abort":
      respond(id, "abort");
      settling = false;
      settle();
      return;
    case "compact":
      statsContextUnavailable = true;
      write({ type: "compaction_start", reason: "manual" });
      write({
        type: "compaction_end",
        reason: "manual",
        result: {
          summary: "summary",
          firstKeptEntryId: "e1",
          tokensBefore: 150000,
          estimatedTokensAfter: 32000,
        },
        aborted: false,
        willRetry: false,
      });
      respond(id, "compact", {
        summary: "summary",
        firstKeptEntryId: "e1",
        tokensBefore: 150000,
        estimatedTokensAfter: 32000,
      });
      return;
    case "extension_ui_response": {
      const handled = pendingDialog;
      pendingDialog = null;
      respond(id, "extension_ui_response");
      handled?.(command.value ?? String(command.confirmed ?? command.cancelled));
      return;
    }
    case "notify":
      return;
    default:
      write({
        type: "response",
        id,
        command: command.type,
        success: false,
        error: `unknown command: ${command.type}`,
      });
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const parts = buffer.split("\n");
  buffer = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.endsWith("\r") ? part.slice(0, -1) : part;
    if (line.length === 0) {
      continue;
    }
    handle(JSON.parse(line));
  }
});
