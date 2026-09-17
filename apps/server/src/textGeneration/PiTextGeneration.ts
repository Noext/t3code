/**
 * Pi-backed text generation for T3's non-chat surfaces: commit messages, change
 * request bodies, branch names, and thread titles.
 *
 * Each call spawns a short-lived `pi --mode rpc` process rather than reusing a
 * thread session. The process is `--no-session` (it must leave no trace in the
 * session store) and `--no-tools` (these prompts must not touch the workspace),
 * but it keeps extensions loaded — an extension is what registers the provider
 * that owns the requested model.
 *
 * @module textGeneration/PiTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type ModelSelection, type PiSettings, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import * as PiRpcTransport from "../provider/pi/PiRpcTransport.ts";
import {
  piDeltaStreamKind,
  piMessageAssistantText,
  type PiAssistantMessage,
} from "../provider/pi/PiEventMapping.ts";

const PI_TEXT_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * `provider/id`, split so `--provider` and `--model` are unambiguous even when
 * the model id itself contains a slash.
 */
const modelArgs = (model: string | undefined): ReadonlyArray<string> => {
  const slug = model?.trim();
  if (!slug) return [];
  const separator = slug.indexOf("/");
  return separator > 0 && separator < slug.length - 1
    ? ["--provider", slug.slice(0, separator), "--model", slug.slice(separator + 1)]
    : ["--model", slug];
};

export interface PiTextGenerationOptions {
  /**
   * Builds the short-lived RPC transport. The production path spawns `pi`;
   * tests substitute a fake and receive the computed argv so the launch flags
   * stay asserted rather than bypassed.
   */
  readonly makeTransport?:
    | ((input: {
        readonly cwd: string;
        readonly args: ReadonlyArray<string>;
        readonly env: NodeJS.ProcessEnv;
      }) => Effect.Effect<
        PiRpcTransport.PiRpcTransportShape,
        PiRpcTransport.PiRpcSpawnError,
        Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
      >)
    | undefined;
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options: PiTextGenerationOptions = {},
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const settled = yield* Deferred.make<void>();

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const args = [
            "--mode",
            "rpc",
            "--no-session",
            "--no-tools",
            ...modelArgs(modelSelection.model),
          ];
          const transport = yield* (
            options.makeTransport
              ? options.makeTransport({ cwd, args, env: environment })
              : PiRpcTransport.make({
                  binaryPath: piSettings.binaryPath || "pi",
                  args,
                  cwd,
                  env: environment,
                })
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner));

          yield* Stream.runForEach(transport.events, (record) =>
            Effect.gen(function* () {
              if (record.type === "message_update") {
                const assistantEvent = record.assistantMessageEvent;
                if (typeof assistantEvent !== "object" || assistantEvent === null) return;
                const delta = assistantEvent as { type?: unknown; delta?: unknown };
                const streamKind =
                  typeof delta.type === "string" ? piDeltaStreamKind(delta.type) : undefined;
                if (streamKind === "assistant_text" && typeof delta.delta === "string") {
                  yield* Ref.update(outputRef, (current) => current + delta.delta);
                }
                return;
              }
              if (record.type === "message_end") {
                // `message_end.message` is authoritative: it replaces whatever
                // the streamed deltas assembled.
                const message = record.message;
                if (typeof message !== "object" || message === null) return;
                const text = piMessageAssistantText(message as PiAssistantMessage);
                if (text.trim().length > 0) {
                  yield* Ref.set(outputRef, text);
                }
                return;
              }
              if (record.type === "agent_settled") {
                yield* Deferred.succeed(settled, undefined).pipe(Effect.ignore);
                return;
              }
              if (record.type === "auto_retry_end" && record.success === false) {
                yield* Deferred.succeed(settled, undefined).pipe(Effect.ignore);
              }
            }),
          ).pipe(
            Effect.catchCause(() => Effect.void),
            Effect.forkScoped,
          );

          yield* transport
            .request({ type: "prompt", message: prompt })
            .pipe(Effect.mapError((cause) => cause));

          yield* Effect.raceFirst(Deferred.await(settled), transport.exited.pipe(Effect.asVoid));
          return yield* Ref.get(outputRef);
        }),
      );

      const trimmed = result.trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail: "Pi returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Pi returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.timeoutOption(PI_TEXT_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Pi text generation timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Pi text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
