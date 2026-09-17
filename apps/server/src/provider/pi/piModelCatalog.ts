/**
 * Parsing for `pi --list-models`.
 *
 * Pi fronts many upstream providers, and each one contributes models to a
 * single flat table:
 *
 *     provider      model                                     context  max-out  thinking  images
 *     local-openai  codex-auto-review                         128K     8.2K     yes       no
 *     anthropic     claude-sonnet-4-5                         200K     64K      yes       yes
 *
 * Two quirks shape this module:
 *
 *   - Pi configures providers through extensions, which may resolve their
 *     model list at startup (the `local-openai` extension fetches a hub over
 *     HTTP and registers whatever it finds). The catalog is therefore live
 *     evidence that credentials reached the process, which is why
 *     `checkPiProviderStatus` reads it instead of trusting `pi auth check` —
 *     Pi's own credential store is empty when providers are extension-backed.
 *   - Pi prints unrelated startup chatter (extension logs, banners) to stdout
 *     ahead of the table, so a line is only a model row when it matches the
 *     full column shape. Everything else is ignored.
 *
 * @module provider/pi/piModelCatalog
 */
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

/** One row of the `pi --list-models` table. */
export interface PiCatalogModel {
  /** Pi provider id, e.g. `anthropic` or an extension-registered `local-openai`. */
  readonly provider: string;
  /** Model id within that provider. May itself contain `/` (e.g. `opencode-go/kimi-k3`). */
  readonly model: string;
  readonly supportsThinking: boolean;
  /** Provider context window in tokens, as printed by Pi. */
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

const HEADER_LINE = /^provider\s+model\s+context\s+max-out\s+thinking\s+images$/;

const YES_NO = new Set(["yes", "no"]);

/**
 * `128K`, `1.1M`, `131.1K`, or a bare token count. Pi renders these with 1024
 * steps, so `K` and `M` are binary multiples.
 */
export function parsePiCompactTokenCount(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([KMG])?$/i.exec(value.trim());
  if (!match?.[1]) {
    return undefined;
  }
  const magnitude = Number.parseFloat(match[1]);
  if (!Number.isFinite(magnitude)) {
    return undefined;
  }
  const scale = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  return Math.round(magnitude * scale);
}

/**
 * Think levels Pi accepts for a model that advertises reasoning at all. `xhigh`
 * and `max` are model-specific and are resolved per session through
 * `get_available_thinking_levels`, so they are deliberately absent here.
 */
const PORTABLE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export function parsePiModelCatalog(output: string): ReadonlyArray<PiCatalogModel> {
  const models: Array<PiCatalogModel> = [];
  const seen = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || HEADER_LINE.test(trimmed)) {
      continue;
    }
    // Columns are space-padded to their widest cell, so single spaces only
    // appear inside a cell (currently never) while column gaps are runs of two
    // or more. Falling back to whole-line splitting keeps a misaligned table
    // readable instead of dropping every row.
    const cells = trimmed
      .split(/\s{2,}/)
      .map((cell) => cell.trim())
      .filter(Boolean);
    const parts = cells.length >= 6 ? cells : trimmed.split(/\s+/);
    // provider + model + the four metric columns.
    if (parts.length < 6) {
      continue;
    }
    const metrics = parts.slice(-4);
    const provider = parts[0] ?? "";
    const model = parts.slice(1, -4).join(" ");
    if (!provider || !model) {
      continue;
    }
    // Startup chatter is whitespace-separated too, so a row is only accepted
    // when every metric column holds a value Pi could actually have printed.
    const contextWindow = parsePiCompactTokenCount(metrics[0] ?? "");
    const maxOutputTokens = parsePiCompactTokenCount(metrics[1] ?? "");
    const thinking = metrics[2]?.toLowerCase() ?? "";
    const images = metrics[3]?.toLowerCase() ?? "";
    if (
      contextWindow === undefined ||
      maxOutputTokens === undefined ||
      !YES_NO.has(thinking) ||
      !YES_NO.has(images)
    ) {
      continue;
    }
    const key = `${provider}/${model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    models.push({
      provider,
      model,
      supportsThinking: thinking === "yes",
      contextWindow,
      maxOutputTokens,
    });
  }

  return models;
}

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

function piModelCapabilities(supportsThinking: boolean): ModelCapabilities {
  if (!supportsThinking) {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: PORTABLE_THINKING_LEVELS.map((level) => ({
          id: level,
          label: level,
          ...(level === "medium" ? { isDefault: true } : {}),
        })),
      },
    ],
  });
}

/**
 * The T3 slug for a Pi model. Pi's `--model` accepts `provider/id` and splits
 * on the first `/`, which this round-trips exactly — including provider-fronted
 * ids that already contain a slash (`local-openai/opencode-go/kimi-k3`).
 */
export function piModelSlug(model: PiCatalogModel): string {
  return `${model.provider}/${model.model}`;
}

export function piCatalogToServerProviderModels(
  models: ReadonlyArray<PiCatalogModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const providerModels: Array<ServerProviderModel> = [];
  for (const model of models) {
    const slug = piModelSlug(model);
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    providerModels.push({
      slug,
      name: model.model,
      subProvider: model.provider,
      isCustom: false,
      capabilities: piModelCapabilities(model.supportsThinking),
    });
  }
  return providerModels;
}
