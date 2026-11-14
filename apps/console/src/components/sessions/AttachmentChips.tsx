import { formatBytes, type MessageAttachment } from "@/lib/attachments";

import { fileKind } from "../files/files";

/**
 * The files a person attached to a message they sent, right-aligned under
 * the bubble (from the event's `metadata.attachments`, read with
 * lib/attachments' `attachmentsOf`). One quiet chip per file: the mark of
 * its kind, its name and size. The tooltip says where it was placed in the
 * agent's sandbox when it has a path. Nothing when the list is empty.
 *
 * Images also ride in the message as pictures and are drawn as thumbnails
 * above the bubble; their chips here say what they were called.
 */
export interface MessageAttachmentChipsProps {
  attachments: MessageAttachment[];
}

export function MessageAttachmentChips({ attachments }: MessageAttachmentChipsProps) {
  if (attachments.length === 0) return null;
  return (
    <ul data-testid="message-attachments" aria-label="Attached files" className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
      {attachments.map((a) => {
        const Kind = fileKind({ filename: a.filename, media_type: a.media_type }).icon;
        return (
          <li
            key={a.file_id}
            title={a.path ? `${a.filename}, saved in the agent's sandbox at ${a.path}` : a.filename}
            className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-fg"
          >
            <Kind className="size-3.5 shrink-0 text-fg-subtle" />
            <span className="min-w-0 truncate">{a.filename}</span>
            <span className="shrink-0 text-fg-subtle tabular-nums">{formatBytes(a.size_bytes)}</span>
          </li>
        );
      })}
    </ul>
  );
}
