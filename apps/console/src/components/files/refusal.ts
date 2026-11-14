import { BRAND_DOCS_URL } from "@/lib/brand";

/**
 * What a person is told when a file they picked, pasted or dropped is not
 * attached to a message, and what they can do instead.
 *
 * What is true, and the only thing these words may say:
 * - A message carries images (the paperclip, a paste, a drop). Up to
 *   `maxFiles`, 25 MB each.
 * - Any other kind of file reaches an agent from Files: it is mounted into
 *   the sandbox when a session starts (Options → Resources → File). A
 *   session that is already running cannot be given one.
 * - A file gets into Files when an agent saves its work, when an image is
 *   attached to a message, or when it is uploaded with the API. The console
 *   has no upload of its own for other files.
 * - A short text file can always be pasted into the message instead.
 *
 * The notice is read by someone writing a message, so it says this in
 * words: how to upload is a link to the docs page that shows it, never an
 * endpoint set in the composer. The words come back as segments so the
 * link can be drawn as one.
 */

export type RefusalWhy = "type" | "size" | "count";
export interface Refusal {
  name: string;
  why: RefusalWhy;
  /** The browser's media type, when it gave one. */
  mediaType?: string;
}

export type Segment = string | { code: string } | { link: string; href: string };

/** What Files holds, as far as the console could read it. */
export interface FilesKnown {
  /** The files read, by name. */
  names: string[];
  /** The read was cut off (a further page exists): a name not seen may still be there. */
  partial: boolean;
}

export interface RefusalAdvice {
  /** The notice's text. */
  body: Segment[];
  /**
   * What the notice can offer. `mount`: open Options with file rows for these
   * names (empty: one blank row to choose in). `new-session`: start a
   * session with this agent. `null`: nothing to press.
   */
  action: { kind: "mount"; names: string[] } | { kind: "new-session" } | null;
}

/** The docs section that shows how a file is uploaded to Files (apps/docs: build/api, "Upload a file to a session"). */
export const UPLOAD_DOCS_URL = `${BRAND_DOCS_URL}/build/api/#upload-a-file-to-a-session`;
/** The link, as a segment: "upload it to Files (how to upload a file)". */
const HOW: Segment = { link: "how to upload a file", href: UPLOAD_DOCS_URL };

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "xml", "html", "htm",
  "log", "sql", "py", "js", "ts", "tsx", "jsx", "sh", "rb", "go", "rs", "java", "c", "h", "cpp", "css", "ini", "env",
]);

/** A file whose contents read as text, so pasting them into the message works. */
export function isTextLike(r: Pick<Refusal, "name" | "mediaType">): boolean {
  const type = (r.mediaType ?? "").toLowerCase();
  if (type.startsWith("text/")) return true;
  if (/^application\/(json|x-ndjson|xml|x-yaml|yaml|toml|sql|javascript|x-sh)\b/.test(type)) return true;
  const ext = /\.([a-z0-9]+)$/i.exec(r.name)?.[1]?.toLowerCase();
  return !!ext && TEXT_EXTENSIONS.has(ext);
}

/**
 * The advice for refused files.
 *
 * `where`: `start` is the session starter (Options can still mount a file);
 * `session` is a session already running (it cannot take a mounted file).
 * `files`: what Files holds, or `undefined` while that is not known (not
 * read yet, or the read failed): then nothing is claimed about it.
 */
export function refusalAdvice({
  refused,
  where,
  files,
  maxFiles,
  maxMegabytes = 25,
}: {
  refused: Refusal[];
  where: "start" | "session";
  files: FilesKnown | undefined;
  maxFiles: number;
  maxMegabytes?: number;
}): RefusalAdvice {
  const wrongType = refused.filter((r) => r.why === "type");
  const whys = new Set(refused.map((r) => r.why));
  const body: Segment[] = [];
  let action: RefusalAdvice["action"] = null;

  if (wrongType.length > 0) {
    const one = wrongType.length === 1;
    const it = one ? "it" : "them";
    const they = one ? "it" : "they";
    const names = new Set(files?.names ?? []);
    const inFiles = files ? wrongType.filter((r) => names.has(r.name)).map((r) => r.name) : [];
    const allInFiles = files !== undefined && inFiles.length === wrongType.length;
    // Only when no name was seen and the read was whole is "not in Files" a fact.
    const noneInFiles = files !== undefined && inFiles.length === 0 && !files.partial;
    const paste = wrongType.every(isTextLike)
      ? one
        ? " A short text file can also be pasted into the message."
        : " Short text files can also be pasted into the message."
      : "";

    body.push("A message carries images only. ");
    if (where === "start") {
      if (allInFiles) {
        body.push(
          `${one ? "This file is" : "These files are"} already in Files, so ${they} can be mounted for this session instead: ${they} will be in the agent's sandbox from the start.`,
        );
        action = { kind: "mount", names: inFiles };
      } else if (noneInFiles && files.names.length === 0) {
        body.push(`Any other file reaches the agent from Files, mounted in Options, and Files is empty. Upload ${it} to Files (`, HOW, `), then mount ${it} here.${paste}`);
      } else if (noneInFiles) {
        body.push(
          "Any other file reaches the agent from Files, mounted in Options. ",
          `${one ? "This one is" : "These are"} not in Files yet: upload ${it} (`,
          HOW,
          `), or mount another file that is.${paste}`,
        );
        action = { kind: "mount", names: [] };
      } else {
        // Files could not be read, or only part of it was: say how it works, claim nothing about what is there.
        body.push(
          "Any other file reaches the agent from Files, mounted in Options. A file gets into Files when an agent saves it or when it is uploaded (",
          HOW,
          `).${paste}`,
        );
        if (files && files.names.length > 0) action = { kind: "mount", names: inFiles };
      }
    } else {
      if (allInFiles) {
        body.push(
          `${one ? "This file is" : "These files are"} in Files, and a file from Files is mounted when a session starts, so this session cannot take ${it}. Start a new session and mount ${it} in Options.${paste}`,
        );
      } else if (noneInFiles) {
        body.push(
          `Any other file is mounted from Files when a session starts, so this session cannot take ${it}. Upload ${it} to Files (`,
          HOW,
          `), then mount ${it} in a new session's Options.${paste}`,
        );
      } else {
        body.push(
          `Any other file is mounted from Files when a session starts, so this session cannot take ${it}. A file gets into Files when an agent saves it or when it is uploaded (`,
          HOW,
          `), and is mounted in a new session's Options.${paste}`,
        );
      }
      action = { kind: "new-session" };
    }
  }
  if (whys.has("size")) body.push(`${body.length ? " " : ""}An image can be up to ${maxMegabytes} MB.`);
  if (whys.has("count")) body.push(`${body.length ? " " : ""}A message carries up to ${maxFiles} images.`);
  return { body, action };
}

/** The notice's title: “orders.csv” was not attached. */
export function refusalTitle(refused: Refusal[], nameList: (names: string[]) => string): string {
  const names = refused.map((r) => r.name);
  return `${nameList(names)} ${names.length === 1 ? "was" : "were"} not attached`;
}

/** The segments as plain text (tests, aria). */
export function segmentsText(body: Segment[]): string {
  return body.map((s) => (typeof s === "string" ? s : "code" in s ? s.code : s.link)).join("");
}
