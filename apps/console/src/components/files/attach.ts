import {
  attachFileToSession,
  isImageType,
  uploadFile,
  type MessageAttachment,
  type UploadedFile,
} from "@/lib/attachments";

/**
 * Attach files to a message in a session, the way both composers do it.
 *
 * Every file is uploaded to Files, scoped to the session (so it shows in
 * the session's Files and is cleaned up with it). Then:
 *   - an image rides in the message as a picture the model can see;
 *   - any other file is attached to the session as a resource, which the
 *     server writes into the agent's sandbox before it answers, so the file
 *     is on disk before the turn that mentions it runs.
 *
 * The message itself is built with lib/attachments' buildUserMessageEvent:
 * the person's words stay the first (visible) block, a model-readable note
 * with the sandbox paths follows, and `metadata.attachments` carries the
 * chips shown under the bubble.
 *
 * Unlike lib/attachments' all-or-nothing `prepareAttachments`, this reports
 * every file that failed, with its own reason, so the composer can name
 * each one and offer to send without them. `cache` remembers what already
 * went up, so trying again does not upload a second copy.
 */

type Api = Parameters<typeof uploadFile>[0];

export interface AttachmentCache {
  uploaded: WeakMap<File, UploadedFile>;
  attached: WeakMap<File, MessageAttachment>;
}

export function newAttachmentCache(): AttachmentCache {
  return { uploaded: new WeakMap(), attached: new WeakMap() };
}

export interface AttachOutcome {
  attachments: MessageAttachment[];
  failed: Array<{ file: File; reason: string }>;
}

export async function attachToSession(
  api: Api,
  sessionId: string,
  files: File[],
  cache: AttachmentCache,
  reasonOf: (err: unknown) => string,
): Promise<AttachOutcome> {
  const attachments: MessageAttachment[] = [];
  const failed: AttachOutcome["failed"] = [];
  for (const file of files) {
    const done = cache.attached.get(file);
    if (done) {
      attachments.push(done);
      continue;
    }
    try {
      let uploaded = cache.uploaded.get(file);
      if (!uploaded) {
        uploaded = await uploadFile(api, file, { scopeId: sessionId });
        cache.uploaded.set(file, uploaded);
      }
      const base = {
        file_id: uploaded.id,
        filename: uploaded.filename || file.name,
        media_type: uploaded.media_type || file.type,
        size_bytes: typeof uploaded.size_bytes === "number" ? uploaded.size_bytes : file.size,
      };
      const attachment: MessageAttachment = isImageType(base.media_type)
        ? { ...base, kind: "image" }
        : { ...base, kind: "file", path: await attachFileToSession(api, sessionId, uploaded) };
      cache.attached.set(file, attachment);
      attachments.push(attachment);
    } catch (err) {
      failed.push({ file, reason: reasonOf(err) });
    }
  }
  return { attachments, failed };
}

/** “Sending with 2 files…”: how many attachments a message carries, in words. */
export function attachmentCount(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}
