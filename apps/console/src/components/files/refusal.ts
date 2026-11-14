import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/attachments";

/**
 * What a person is told when a file they picked, pasted or dropped is not
 * attached to a message.
 *
 * What is true, and the only thing these words may say:
 * - A message carries any kind of file: images go to the model as pictures,
 *   every other file is saved in the agent's sandbox, where it can read it.
 * - A file can be up to 25 MB (the server's upload limit), and a message
 *   carries up to 10 of them.
 *
 * So a file is only ever turned away for its size or for being one too
 * many. The notice names the files and says which limit they hit.
 */

export type RefusalWhy = "size" | "count";
export interface Refusal {
  name: string;
  why: RefusalWhy;
}

export const MAX_ATTACHMENT_MEGABYTES = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));

/**
 * Sort picked files into the ones that can be attached and the ones that
 * cannot. `already` is how many files the message holds before these.
 */
export function screenAttachments(
  incoming: File[],
  already: number,
  { maxFiles = MAX_ATTACHMENTS_PER_MESSAGE, maxBytes = MAX_ATTACHMENT_BYTES }: { maxFiles?: number; maxBytes?: number } = {},
): { accepted: File[]; refused: Refusal[] } {
  const accepted: File[] = [];
  const refused: Refusal[] = [];
  for (const f of incoming) {
    if (f.size > maxBytes) refused.push({ name: f.name, why: "size" });
    else if (already + accepted.length >= maxFiles) refused.push({ name: f.name, why: "count" });
    else accepted.push(f);
  }
  return { accepted, refused };
}

/** Why the files were not attached, in a sentence or two. */
export function refusalText(
  refused: Refusal[],
  { maxFiles = MAX_ATTACHMENTS_PER_MESSAGE, maxMegabytes = MAX_ATTACHMENT_MEGABYTES }: { maxFiles?: number; maxMegabytes?: number } = {},
): string {
  const whys = new Set(refused.map((r) => r.why));
  const parts: string[] = [];
  if (whys.has("size")) parts.push(`A file can be up to ${maxMegabytes} MB.`);
  if (whys.has("count")) parts.push(`A message carries up to ${maxFiles} files. Send these in a second message.`);
  return parts.join(" ");
}

/** The notice's title: “orders.csv” was not attached. */
export function refusalTitle(refused: Refusal[], nameList: (names: string[]) => string): string {
  const names = refused.map((r) => r.name);
  return `${nameList(names)} ${names.length === 1 ? "was" : "were"} not attached`;
}
