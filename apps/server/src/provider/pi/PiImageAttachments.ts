/**
 * Resolves a turn's image attachments into Pi's native `images` payload.
 *
 * Pi's `prompt` and `steer` commands accept an optional array of
 * `ImageContent` records (`{ type: "image", data: <base64>, mimeType }`). This
 * mirrors Antigravity's attachment handling — the same on-disk resolution and
 * the same per-image and total byte budgets — and builds Pi's shape instead of
 * ACP's.
 *
 * Non-image attachments are left to the text path: `ProviderService` already
 * appended `[Attached … is saved at: …]` to the turn text, so the agent can
 * read them with its own tools. An image that cannot be resolved, is not a
 * regular file, or exceeds a budget is skipped rather than failing the turn,
 * for the same reason: the text path still names the file, and one bad
 * attachment must not block the message. Skips are reported back so the
 * adapter can surface them as runtime warnings.
 *
 * @module provider/pi/PiImageAttachments
 */
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  isProviderSendTurnSupportedImageMimeType,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";

export interface PiPromptImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PiSkippedImage {
  readonly name: string;
  readonly reason: string;
}

export interface PiPromptImages {
  readonly images: ReadonlyArray<PiPromptImage>;
  readonly skipped: ReadonlyArray<PiSkippedImage>;
}

const formatMiB = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MiB`;

export const buildPiPromptImages = Effect.fn("buildPiPromptImages")(function* (input: {
  readonly attachments: ProviderSendTurnInput["attachments"];
  readonly attachmentsDir: string;
}): Effect.fn.Return<PiPromptImages, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const images: Array<PiPromptImage> = [];
  const skipped: Array<PiSkippedImage> = [];
  let totalBytes = 0;

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") continue;
    const mimeType = attachment.mimeType.trim().toLowerCase();
    // The composer only produces the provider-neutral raster set. Anything
    // else stays path-only, exactly like a non-image file.
    if (!isProviderSendTurnSupportedImageMimeType(mimeType)) continue;

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      skipped.push({ name: attachment.name, reason: "its path could not be resolved" });
      continue;
    }
    const info = yield* fileSystem.stat(attachmentPath).pipe(Effect.orElseSucceed(() => null));
    if (info === null || info.type !== "File") {
      skipped.push({ name: attachment.name, reason: "it could not be read" });
      continue;
    }
    const size = Number(info.size);
    if (size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      skipped.push({
        name: attachment.name,
        reason: `it is larger than ${formatMiB(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)}`,
      });
      continue;
    }
    if (totalBytes + size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
      skipped.push({
        name: attachment.name,
        reason: `the turn's images exceed ${formatMiB(PROVIDER_SEND_TURN_MAX_FILE_BYTES)} in total`,
      });
      continue;
    }
    // Read one byte past the per-image budget so a file that grew after the
    // stat is detected instead of being silently truncated.
    const bytes = yield* fileSystem
      .stream(attachmentPath, { bytesToRead: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 })
      .pipe(
        Stream.runCollect,
        Effect.map((chunks) => Buffer.concat(chunks)),
        Effect.orElseSucceed(() => null),
      );
    if (bytes === null) {
      skipped.push({ name: attachment.name, reason: "it could not be read" });
      continue;
    }
    if (
      bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ||
      totalBytes + bytes.length > PROVIDER_SEND_TURN_MAX_FILE_BYTES
    ) {
      skipped.push({
        name: attachment.name,
        reason: "it changed while being read and is now too large",
      });
      continue;
    }
    totalBytes += bytes.length;
    images.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
  }

  return { images, skipped };
});
