import type { MessageAttachment } from "../../lib/attachments";

/**
 * CONTRACT (step 0 baseline). Owner: C4. Rendered under a sent user
 * message in ConversationView (C3 places it; the attachments come from the
 * event's `metadata.attachments`, read with lib/attachments). Renders
 * nothing yet.
 *
 * Port of main's MessageAttachmentChips (components/SessionFiles.tsx).
 * One chip per attached file, right-aligned under the bubble: file name and
 * size; the title says where it was placed in the sandbox (`path`) when it
 * has one. Nothing when the list is empty. Keeps the test id
 * `message-attachments`.
 */
export interface MessageAttachmentChipsProps {
  attachments: MessageAttachment[];
}

export function MessageAttachmentChips(_props: MessageAttachmentChipsProps) {
  return null;
}
