/**
 * Pure translations from Pi's RPC vocabulary to T3's canonical runtime shapes.
 *
 * Everything here is a plain function over decoded JSON so the mapping can be
 * tested without spawning `pi`. The adapter owns the process; this module owns
 * the vocabulary.
 *
 * @module provider/pi/PiEventMapping
 */
import type {
  CanonicalItemType,
  RuntimeContentStreamKind,
  ThreadTokenUsageSnapshot,
  TurnTokenUsage,
  UserInputQuestion,
} from "@t3tools/contracts";

/** Pi's `usage` object, shared by streaming updates and session statistics. */
export interface PiUsage {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly cost?: unknown;
}

/** A content part of an `AgentMessage`. Only the parts T3 renders are modelled. */
export type PiContentPart =
  | { readonly type: "text"; readonly text?: string | undefined }
  | { readonly type: "thinking"; readonly thinking?: string | undefined }
  | { readonly type: string; readonly [key: string]: unknown };

export interface PiAssistantMessage {
  readonly role?: string | undefined;
  readonly content?: ReadonlyArray<PiContentPart> | string | undefined;
  readonly [key: string]: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/**
 * Pi reports raw prompt tokens separately from cache reads and writes, and its
 * own `totalTokens` sums all four. T3's `inputTokens` is documented as
 * *including* cache reads and writes, so the three are added back together
 * here rather than passed through.
 */
export function piUsageToTurnTokenUsage(usage: PiUsage | undefined): TurnTokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const input = asFiniteNumber(usage.input);
  const output = asFiniteNumber(usage.output);
  const cachedInput = asFiniteNumber(usage.cacheRead);
  const cacheCreation = asFiniteNumber(usage.cacheWrite);
  const cacheFields = {
    ...(cachedInput !== undefined ? { cachedInputTokens: cachedInput } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
  };
  if (input !== undefined && output !== undefined) {
    return {
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: input + (cachedInput ?? 0) + (cacheCreation ?? 0),
      outputTokens: output,
      ...cacheFields,
      hasSubagents: false,
    };
  }
  if (input === undefined && output === undefined) {
    return undefined;
  }
  return {
    usageScope: "main_agent",
    usageStatus: "partial",
    ...(input !== undefined
      ? { inputTokens: input + (cachedInput ?? 0) + (cacheCreation ?? 0) }
      : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...cacheFields,
    hasSubagents: false,
  };
}

/**
 * Maps `get_session_stats` onto T3's context-window snapshot.
 *
 * That command reports two different quantities: session-cumulative token
 * counts under `tokens`, and a live context-window estimate under
 * `contextUsage`. Only the estimate can drive T3's context meter, so a missing
 * estimate yields no snapshot at all. Pi omits `contextUsage` entirely when it
 * has no model, and reports `tokens`/`percent` as null right after a compaction;
 * treating either as zero would draw an empty bar over a full context window.
 */
export function piSessionStatsToThreadTokenUsage(
  value: unknown,
): ThreadTokenUsageSnapshot | undefined {
  const record = asRecord(value);
  const contextUsage = asRecord(record?.contextUsage);
  const usedTokens = asFiniteNumber(contextUsage?.tokens);
  if (usedTokens === undefined) {
    return undefined;
  }
  const contextWindow = asFiniteNumber(contextUsage?.contextWindow);
  const maxTokens = contextWindow !== undefined && contextWindow > 0 ? contextWindow : undefined;
  const cappedUsedTokens = maxTokens !== undefined ? Math.min(usedTokens, maxTokens) : usedTokens;

  const tokens = asRecord(record?.tokens);
  const input = asFiniteNumber(tokens?.input);
  const output = asFiniteNumber(tokens?.output);
  const cacheRead = asFiniteNumber(tokens?.cacheRead);
  const cacheWrite = asFiniteNumber(tokens?.cacheWrite);
  const total = asFiniteNumber(tokens?.total);
  // Pi's `input` excludes cache; T3's canonical input includes it. Session
  // totals, so `inputTokens` may exceed `usedTokens` (which is only the current
  // context slice).
  const inputTokens =
    input !== undefined || cacheRead !== undefined || cacheWrite !== undefined
      ? (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined;

  return {
    usedTokens: cappedUsedTokens,
    ...(total !== undefined && total > cappedUsedTokens ? { totalProcessedTokens: total } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { inputTokens } : {}),
    ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  };
}

export function piMessageAssistantText(message: PiAssistantMessage | undefined): string {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/**
 * Pi ships four built-in tools and lets extensions add more. Only the built-ins
 * have an exact canonical counterpart; anything else becomes a dynamic tool
 * call, which renders as a generic tool row rather than being dropped.
 */
export function piToolItemType(toolName: string): CanonicalItemType {
  switch (toolName.trim().toLowerCase()) {
    case "bash":
    case "shell":
      return "command_execution";
    case "write":
    case "edit":
    case "multiedit":
    case "apply_patch":
      return "file_change";
    case "read":
    case "view":
      return "dynamic_tool_call";
    case "web_search":
    case "websearch":
      return "web_search";
    case "task":
    case "agent":
      return "collab_agent_tool_call";
    default:
      return "dynamic_tool_call";
  }
}

/** Stream kind for an assistant streaming delta. Unknown kinds are not rendered. */
export function piDeltaStreamKind(
  assistantEventType: string,
): Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text"> | undefined {
  switch (assistantEventType) {
    case "text_delta":
      return "assistant_text";
    case "thinking_delta":
      return "reasoning_text";
    default:
      return undefined;
  }
}

/** Collects `{type:"text"}` parts of a tool result into display text. */
export function piToolResultText(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result.trim().length > 0 ? result : undefined;
  }
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
        ? ((part as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((value): value is string => typeof value === "string")
    .join("");
  return text.trim().length > 0 ? text : undefined;
}

/**
 * A short human label for a tool row. Pi gives us the tool name and its raw
 * arguments; the interesting argument differs per tool, so only the tools whose
 * argument the user actually recognises are labelled.
 */
export function piToolTitle(toolName: string, args: unknown): string {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const firstString = (keys: ReadonlyArray<string>): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return undefined;
  };
  const target =
    firstString(["command", "file_path", "path", "filePath", "pattern", "url", "query"]) ??
    firstString(["description"]);
  return target ? `${toolName}: ${target}` : toolName;
}

/** The extension UI methods that block Pi until the client answers. */
const PI_DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;
export type PiDialogMethod = (typeof PI_DIALOG_METHODS)[number];

export interface PiExtensionUiRequest {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method: string;
  readonly title?: string | undefined;
  readonly message?: string | undefined;
  readonly options?: ReadonlyArray<string> | undefined;
  readonly placeholder?: string | undefined;
  readonly prefill?: string | undefined;
  readonly notifyType?: string | undefined;
  readonly timeout?: number | undefined;
  readonly [key: string]: unknown;
}

function isPiDialogMethod(method: string): method is PiDialogMethod {
  return (PI_DIALOG_METHODS as ReadonlyArray<string>).includes(method);
}

/**
 * Pi dialogs are single-question prompts, so they map onto a one-entry
 * `user-input.requested`. Option `description` is required by the contract and
 * Pi has nothing to put there, so it is empty rather than invented.
 *
 * `select`/`confirm` keep a stable value per option (the option index for
 * `select`, `yes`/`no` for `confirm`) so answers survive a client round trip
 * without depending on display strings.
 */
export function piQuestionFromDialog(
  request: PiExtensionUiRequest,
  questionId: string,
): UserInputQuestion | undefined {
  if (!isPiDialogMethod(request.method)) {
    return undefined;
  }
  const header = request.title?.trim() || "Pi";
  if (request.method === "select") {
    const options = (request.options ?? []).filter(
      (option): option is string => typeof option === "string" && option.trim().length > 0,
    );
    if (options.length === 0) {
      return undefined;
    }
    return {
      id: questionId,
      header,
      question: request.title?.trim() || "Choose an option",
      options: options.map((option, index) => ({
        label: option,
        description: "",
        value: String(index),
      })),
      allowCustomAnswer: false,
    };
  }
  if (request.method === "confirm") {
    return {
      id: questionId,
      header,
      question: request.message?.trim() || request.title?.trim() || "Confirm",
      options: [
        { label: "Yes", description: "", value: "yes" },
        { label: "No", description: "", value: "no" },
      ],
      allowCustomAnswer: false,
    };
  }
  // `input` and `editor` are free-form; the placeholder is guidance, not a value.
  return {
    id: questionId,
    header,
    question: request.title?.trim() || "Enter a value",
    options: [],
    allowCustomAnswer: true,
    ...(request.method === "editor" ? { multiSelect: false } : {}),
  };
}

/**
 * Turns the client's answer back into the `extension_ui_response` Pi expects.
 * A missing or unrecognised answer cancels the dialog: leaving it unanswered
 * would block the agent until Pi's own timeout, or forever when none is set.
 */
export function piResponseFromAnswers(
  request: PiExtensionUiRequest,
  answer: string | undefined,
): { readonly type: "extension_ui_response"; readonly id: string } & Record<string, unknown> {
  const base = { type: "extension_ui_response", id: request.id } as const;
  if (answer === undefined) {
    return { ...base, cancelled: true };
  }
  switch (request.method) {
    case "select": {
      const options = request.options ?? [];
      const index = Number.parseInt(answer, 10);
      const selected = Number.isInteger(index) ? options[index] : undefined;
      if (typeof selected !== "string") {
        // A client may send the option label instead of its value.
        const byLabel = options.find((option) => option === answer);
        return typeof byLabel === "string"
          ? { ...base, value: byLabel }
          : { ...base, cancelled: true };
      }
      return { ...base, value: selected };
    }
    case "confirm": {
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "yes" || trimmed === "true") {
        return { ...base, confirmed: true };
      }
      if (trimmed === "no" || trimmed === "false") {
        return { ...base, confirmed: false };
      }
      return { ...base, cancelled: true };
    }
    case "input":
    case "editor":
      return { ...base, value: answer };
    default:
      return { ...base, cancelled: true };
  }
}

/**
 * `notify` is the only fire-and-forget UI method with user-visible content.
 * `setStatus`, `setWidget`, `setTitle` and `set_editor_text` describe TUI
 * chrome that has no T3 surface, so they are ignored deliberately.
 */
export function piNotifyMessage(request: PiExtensionUiRequest): string | undefined {
  if (request.method !== "notify") {
    return undefined;
  }
  const message = typeof request.message === "string" ? request.message.trim() : "";
  return message.length > 0 ? message : undefined;
}
