import { describe, expect, it } from "vite-plus/test";

import {
  piDeltaStreamKind,
  piMessageAssistantText,
  piNotifyMessage,
  piQuestionFromDialog,
  piResponseFromAnswers,
  piSessionStatsToThreadTokenUsage,
  piToolItemType,
  piToolResultText,
  piToolTitle,
  piUsageToTurnTokenUsage,
  type PiExtensionUiRequest,
} from "./PiEventMapping.ts";

describe("piUsageToTurnTokenUsage", () => {
  it("folds cache reads and writes into T3's inclusive input count", () => {
    // Pi's `input` excludes cache: get_session_stats totals
    // 50000 + 10000 + 40000 + 5000 as 105000.
    expect(
      piUsageToTurnTokenUsage({
        input: 50_000,
        output: 10_000,
        cacheRead: 40_000,
        cacheWrite: 5_000,
      }),
    ).toEqual({
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: 95_000,
      outputTokens: 10_000,
      cachedInputTokens: 40_000,
      cacheCreationTokens: 5_000,
      hasSubagents: false,
    });
  });

  it("reports partial usage when only one side is known", () => {
    expect(piUsageToTurnTokenUsage({ input: 100 })).toEqual({
      usageScope: "main_agent",
      usageStatus: "partial",
      inputTokens: 100,
      hasSubagents: false,
    });
    expect(piUsageToTurnTokenUsage({ output: 12 })).toEqual({
      usageScope: "main_agent",
      usageStatus: "partial",
      outputTokens: 12,
      hasSubagents: false,
    });
  });

  it("ignores usage Pi has not populated yet", () => {
    expect(piUsageToTurnTokenUsage(undefined)).toBeUndefined();
    expect(piUsageToTurnTokenUsage({})).toBeUndefined();
    expect(piUsageToTurnTokenUsage({ totalTokens: 10 })).toBeUndefined();
    expect(piUsageToTurnTokenUsage({ input: -5, output: Number.NaN })).toBeUndefined();
  });

  it("rounds fractional counts rather than emitting them", () => {
    expect(piUsageToTurnTokenUsage({ input: 10.6, output: 1.2 })).toMatchObject({
      inputTokens: 11,
      outputTokens: 1,
    });
  });
});

describe("piSessionStatsToThreadTokenUsage", () => {
  it("maps the context estimate and folds cache into input", () => {
    expect(
      piSessionStatsToThreadTokenUsage({
        tokens: {
          input: 12_000,
          output: 3_400,
          cacheRead: 50_000,
          cacheWrite: 2_000,
          total: 67_400,
        },
        contextUsage: { tokens: 61_000, contextWindow: 131_072, percent: 47 },
      }),
    ).toEqual({
      usedTokens: 61_000,
      totalProcessedTokens: 67_400,
      maxTokens: 131_072,
      inputTokens: 64_000,
      cachedInputTokens: 50_000,
      outputTokens: 3_400,
    });
  });

  it("has no snapshot when Pi cannot estimate the context", () => {
    // Pi omits `contextUsage` with no model, and nulls its tokens right after
    // a compaction; neither may be reported as zero.
    expect(piSessionStatsToThreadTokenUsage({ tokens: { input: 10, output: 1 } })).toBeUndefined();
    expect(
      piSessionStatsToThreadTokenUsage({
        contextUsage: { tokens: null, contextWindow: 131_072, percent: null },
      }),
    ).toBeUndefined();
    expect(piSessionStatsToThreadTokenUsage(undefined)).toBeUndefined();
  });

  it("omits maxTokens rather than inventing one", () => {
    expect(
      piSessionStatsToThreadTokenUsage({ contextUsage: { tokens: 1_000, percent: 1 } }),
    ).toEqual({ usedTokens: 1_000 });
  });
});

describe("piToolItemType", () => {
  it("maps the four built-in tools and falls back to a dynamic call", () => {
    expect(piToolItemType("bash")).toBe("command_execution");
    expect(piToolItemType("Write")).toBe("file_change");
    expect(piToolItemType("edit")).toBe("file_change");
    expect(piToolItemType("read")).toBe("dynamic_tool_call");
    expect(piToolItemType("some_extension_tool")).toBe("dynamic_tool_call");
    expect(piToolItemType("")).toBe("dynamic_tool_call");
  });
});

describe("piToolTitle", () => {
  it("prefers the argument a user recognises", () => {
    expect(piToolTitle("bash", { command: "ls -la" })).toBe("bash: ls -la");
    expect(piToolTitle("read", { file_path: "/tmp/a.ts" })).toBe("read: /tmp/a.ts");
    expect(piToolTitle("edit", { filePath: "/tmp/a.ts", old_string: "x" })).toBe("edit: /tmp/a.ts");
  });

  it("falls back to the bare tool name", () => {
    expect(piToolTitle("bash", undefined)).toBe("bash");
    expect(piToolTitle("bash", { command: "   " })).toBe("bash");
    expect(piToolTitle("bash", { command: 42 })).toBe("bash");
  });
});

describe("piToolResultText", () => {
  it("joins text parts and keeps other content out", () => {
    expect(
      piToolResultText({
        content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
      }),
    ).toBe("ab");
    expect(piToolResultText("raw")).toBe("raw");
    expect(piToolResultText({ content: [] })).toBeUndefined();
    expect(piToolResultText({ content: [{ type: "image" }] })).toBeUndefined();
    expect(piToolResultText(null)).toBeUndefined();
  });
});

describe("piMessageAssistantText", () => {
  it("reads only assistant text parts", () => {
    expect(
      piMessageAssistantText({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "hi" },
        ],
      }),
    ).toBe("hi");
    expect(
      piMessageAssistantText({
        role: "assistant",
        content: [{ type: "thinking", thinking: "hmm" }],
      }),
    ).toBe("");
    expect(piMessageAssistantText({ role: "assistant", content: "plain" })).toBe("plain");
    expect(piMessageAssistantText(undefined)).toBe("");
  });
});

describe("piDeltaStreamKind", () => {
  it("only renders text and thinking deltas", () => {
    expect(piDeltaStreamKind("text_delta")).toBe("assistant_text");
    expect(piDeltaStreamKind("thinking_delta")).toBe("reasoning_text");
    expect(piDeltaStreamKind("toolcall_delta")).toBeUndefined();
    expect(piDeltaStreamKind("text_start")).toBeUndefined();
    expect(piDeltaStreamKind("nope")).toBeUndefined();
  });
});

const dialog = (overrides: Partial<PiExtensionUiRequest>): PiExtensionUiRequest => ({
  type: "extension_ui_request",
  id: "d1",
  method: "select",
  ...overrides,
});

describe("piQuestionFromDialog", () => {
  it("turns select options into stable indices", () => {
    const question = piQuestionFromDialog(
      dialog({ title: "Allow?", options: ["Allow", "Block"] }),
      "d1",
    );
    expect(question).toMatchObject({
      id: "d1",
      header: "Allow?",
      allowCustomAnswer: false,
    });
    expect(question?.options).toEqual([
      { label: "Allow", description: "", value: "0" },
      { label: "Block", description: "", value: "1" },
    ]);
  });

  it("turns confirm into a yes/no question carrying the message", () => {
    const question = piQuestionFromDialog(
      dialog({ method: "confirm", title: "Clear?", message: "All messages will be lost." }),
      "d1",
    );
    expect(question?.question).toBe("All messages will be lost.");
    expect(question?.options.map((option) => option.value)).toEqual(["yes", "no"]);
  });

  it("treats input and editor as free-form", () => {
    expect(piQuestionFromDialog(dialog({ method: "input", placeholder: "x" }), "d1")).toMatchObject(
      {
        allowCustomAnswer: true,
        options: [],
      },
    );
    expect(piQuestionFromDialog(dialog({ method: "editor", prefill: "a\nb" }), "d1")).toMatchObject(
      {
        allowCustomAnswer: true,
      },
    );
  });

  it("refuses dialogs it cannot render", () => {
    expect(piQuestionFromDialog(dialog({ options: [] }), "d1")).toBeUndefined();
    expect(piQuestionFromDialog(dialog({ options: undefined }), "d1")).toBeUndefined();
    expect(piQuestionFromDialog(dialog({ method: "setStatus" }), "d1")).toBeUndefined();
  });
});

describe("piResponseFromAnswers", () => {
  it("answers a select by index or by label", () => {
    const request = dialog({ options: ["Allow", "Block"] });
    expect(piResponseFromAnswers(request, "1")).toEqual({
      type: "extension_ui_response",
      id: "d1",
      value: "Block",
    });
    expect(piResponseFromAnswers(request, "Allow")).toEqual({
      type: "extension_ui_response",
      id: "d1",
      value: "Allow",
    });
  });

  it("answers confirm with a boolean", () => {
    expect(piResponseFromAnswers(dialog({ method: "confirm" }), "yes")).toMatchObject({
      confirmed: true,
    });
    expect(piResponseFromAnswers(dialog({ method: "confirm" }), "no")).toMatchObject({
      confirmed: false,
    });
  });

  it("passes free-form text through", () => {
    expect(piResponseFromAnswers(dialog({ method: "input" }), "42")).toMatchObject({ value: "42" });
    expect(piResponseFromAnswers(dialog({ method: "editor" }), "a\nb")).toMatchObject({
      value: "a\nb",
    });
  });

  it("cancels instead of leaving Pi blocked", () => {
    // No answer, an out-of-range index, an unparseable confirm, and a dialog
    // the client could not render must all resolve as a cancellation.
    expect(piResponseFromAnswers(dialog({ options: ["Allow"] }), undefined)).toMatchObject({
      cancelled: true,
    });
    expect(piResponseFromAnswers(dialog({ options: ["Allow"] }), "9")).toMatchObject({
      cancelled: true,
    });
    expect(piResponseFromAnswers(dialog({ method: "confirm" }), "maybe")).toMatchObject({
      cancelled: true,
    });
    expect(piResponseFromAnswers(dialog({ method: "setStatus" }), "x")).toMatchObject({
      cancelled: true,
    });
  });
});

describe("piNotifyMessage", () => {
  it("reads notify messages and ignores other UI methods", () => {
    expect(
      piNotifyMessage(
        dialog({ method: "notify", message: "blocked by user", notifyType: "warning" }),
      ),
    ).toBe("blocked by user");
    expect(piNotifyMessage(dialog({ method: "notify", message: "   " }))).toBeUndefined();
    expect(piNotifyMessage(dialog({ method: "setStatus" }))).toBeUndefined();
  });
});
