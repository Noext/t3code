import { describe, expect, it } from "vite-plus/test";

import {
  parsePiCompactTokenCount,
  parsePiModelCatalog,
  piCatalogToServerProviderModels,
} from "./piModelCatalog.ts";

/**
 * Captured from a real `pi --list-models` run, including the startup chatter an
 * extension prints to stdout before the table. This is the shape the probe has
 * to survive: the first line is not a column header.
 */
const REAL_OUTPUT = `[dashboard] endpoint ws+unix:///root/.pi/dashboard/gateway-9999.sock:/ (source=rendezvous-record pinned=false)
provider      model                                     context  max-out  thinking  images
local-openai  codex-auto-review                         128K     8.2K     yes       no    
local-openai  gpt-5.6-sol                               1.1M     8.2K     yes       no    
local-openai  opencode-go/kimi-k3                       128K     8.2K     yes       no    
local-openai  opencode-go/muse-spark-1.3-contributor    1M       131.1K   yes       no    
`;

describe("parsePiModelCatalog", () => {
  it("reads provider, model, and thinking support from the table", () => {
    expect(parsePiModelCatalog(REAL_OUTPUT)).toEqual([
      {
        provider: "local-openai",
        model: "codex-auto-review",
        supportsThinking: true,
        contextWindow: 128 * 1024,
        maxOutputTokens: Math.round(8.2 * 1024),
      },
      {
        provider: "local-openai",
        model: "gpt-5.6-sol",
        supportsThinking: true,
        contextWindow: Math.round(1.1 * 1024 ** 2),
        maxOutputTokens: Math.round(8.2 * 1024),
      },
      {
        provider: "local-openai",
        model: "opencode-go/kimi-k3",
        supportsThinking: true,
        contextWindow: 128 * 1024,
        maxOutputTokens: Math.round(8.2 * 1024),
      },
      {
        provider: "local-openai",
        model: "opencode-go/muse-spark-1.3-contributor",
        supportsThinking: true,
        contextWindow: 1024 ** 2,
        maxOutputTokens: Math.round(131.1 * 1024),
      },
    ]);
  });

  it("ignores non-tabular lines and empty output", () => {
    expect(parsePiModelCatalog("")).toEqual([]);
    expect(parsePiModelCatalog('No models matching "gemini"\n')).toEqual([]);
    expect(
      parsePiModelCatalog("provider      model   context  max-out  thinking  images\n"),
    ).toEqual([]);
    // A provider that registered no models prints nothing useful, and a row
    // with missing metric columns must not be read as a model.
    expect(parsePiModelCatalog("local-openai  partial-model  128K\n")).toEqual([]);
  });

  it("rejects startup chatter that happens to have six whitespace-separated fields", () => {
    const chatter =
      "[dashboard] endpoint ws+unix:///root/.pi/dashboard/gateway-9999.sock:/ source=rendezvous-record pinned=false\n";
    expect(parsePiModelCatalog(chatter)).toEqual([]);
  });

  it("reads a table whose column gaps collapsed to single spaces", () => {
    expect(
      parsePiModelCatalog(
        "provider model context max-out thinking images\nanthropic claude-sonnet-4-5 200K 64K yes yes\n",
      ),
    ).toEqual([
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        supportsThinking: true,
        contextWindow: 200 * 1024,
        maxOutputTokens: 64 * 1024,
      },
    ]);
  });

  it("deduplicates repeated rows and reports models without thinking", () => {
    const output = [
      "provider  model  context  max-out  thinking  images",
      "openai    gpt-5  128K     8.2K     no        yes",
      "openai    gpt-5  128K     8.2K     no        yes",
    ].join("\n");
    expect(parsePiModelCatalog(output)).toEqual([
      {
        provider: "openai",
        model: "gpt-5",
        supportsThinking: false,
        contextWindow: 128 * 1024,
        maxOutputTokens: Math.round(8.2 * 1024),
      },
    ]);
  });
});

describe("parsePiCompactTokenCount", () => {
  it("treats K/M/G as binary multiples", () => {
    expect(parsePiCompactTokenCount("128K")).toBe(131_072);
    expect(parsePiCompactTokenCount("1M")).toBe(1_048_576);
    expect(parsePiCompactTokenCount("131.1K")).toBe(134_246);
    expect(parsePiCompactTokenCount("8192")).toBe(8192);
  });

  it("rejects values Pi never prints", () => {
    expect(parsePiCompactTokenCount("")).toBeUndefined();
    expect(parsePiCompactTokenCount("-")).toBeUndefined();
    expect(parsePiCompactTokenCount("many")).toBeUndefined();
  });
});

describe("piCatalogToServerProviderModels", () => {
  it("namespaces slugs by provider and exposes thinking as a reasoning option", () => {
    const [thinking, plain] = piCatalogToServerProviderModels([
      {
        provider: "local-openai",
        model: "opencode-go/kimi-k3",
        supportsThinking: true,
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
      },
      {
        provider: "anthropic",
        model: "claude-haiku-4",
        supportsThinking: false,
        contextWindow: 204_800,
        maxOutputTokens: 65_536,
      },
    ]);

    expect(thinking).toMatchObject({
      slug: "local-openai/opencode-go/kimi-k3",
      name: "opencode-go/kimi-k3",
      subProvider: "local-openai",
      isCustom: false,
    });
    expect(thinking?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      type: "select",
    });
    expect(plain?.capabilities?.optionDescriptors).toEqual([]);
  });
});
