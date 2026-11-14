import type { ComponentType } from "react";
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
} from "lucide-react";
import type { FileRecord } from "@open-managed-agents/api-types";

import { getActiveTenantId, readApiError } from "@/lib/api";
import { getClerkBearerToken } from "@/lib/clerk-auth";

/**
 * What a file is, in the words a person uses ("CSV table", "Markdown
 * document"), the icon that goes with it, and how the panel can preview
 * it. Same icon families as the session's Files list, so a file wears the
 * same mark wherever it shows up.
 */
export type PreviewKind = "markdown" | "table" | "code" | "text" | "image" | "none";

export interface FileKind {
  icon: ComponentType<{ className?: string }>;
  label: string;
  preview: PreviewKind;
}

const BY_EXTENSION: Record<string, FileKind> = {
  csv: { icon: FileSpreadsheetIcon, label: "CSV table", preview: "table" },
  tsv: { icon: FileSpreadsheetIcon, label: "TSV table", preview: "table" },
  xlsx: { icon: FileSpreadsheetIcon, label: "Excel workbook", preview: "none" },
  xls: { icon: FileSpreadsheetIcon, label: "Excel workbook", preview: "none" },
  md: { icon: FileTextIcon, label: "Markdown document", preview: "markdown" },
  markdown: { icon: FileTextIcon, label: "Markdown document", preview: "markdown" },
  txt: { icon: FileTextIcon, label: "Text file", preview: "text" },
  log: { icon: FileTextIcon, label: "Log file", preview: "text" },
  pdf: { icon: FileTextIcon, label: "PDF document", preview: "none" },
  doc: { icon: FileTextIcon, label: "Word document", preview: "none" },
  docx: { icon: FileTextIcon, label: "Word document", preview: "none" },
  json: { icon: FileCodeIcon, label: "JSON data", preview: "code" },
  jsonl: { icon: FileCodeIcon, label: "JSON lines", preview: "text" },
  xml: { icon: FileCodeIcon, label: "XML document", preview: "code" },
  yaml: { icon: FileCodeIcon, label: "YAML file", preview: "code" },
  yml: { icon: FileCodeIcon, label: "YAML file", preview: "code" },
  html: { icon: FileCodeIcon, label: "HTML page", preview: "code" },
  css: { icon: FileCodeIcon, label: "Stylesheet", preview: "code" },
  sql: { icon: FileCodeIcon, label: "SQL script", preview: "code" },
  py: { icon: FileCodeIcon, label: "Python script", preview: "code" },
  ts: { icon: FileCodeIcon, label: "TypeScript file", preview: "code" },
  tsx: { icon: FileCodeIcon, label: "TypeScript file", preview: "code" },
  js: { icon: FileCodeIcon, label: "JavaScript file", preview: "code" },
  sh: { icon: FileCodeIcon, label: "Shell script", preview: "code" },
  zip: { icon: FileArchiveIcon, label: "Zip archive", preview: "none" },
  gz: { icon: FileArchiveIcon, label: "Compressed archive", preview: "none" },
  tar: { icon: FileArchiveIcon, label: "Tar archive", preview: "none" },
};

export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function fileKind(file: Pick<FileRecord, "filename" | "media_type">): FileKind {
  const ext = fileExtension(file.filename);
  const type = (file.media_type || "").toLowerCase();
  if (type.startsWith("image/")) {
    const flavour = (ext || type.slice(6)).toUpperCase();
    // SVG is markup: draw it as an image, never inject it.
    return { icon: FileImageIcon, label: `${flavour} image`, preview: "image" };
  }
  if (BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  if (type.startsWith("audio/")) return { icon: FileAudioIcon, label: "Audio", preview: "none" };
  if (type.startsWith("video/")) return { icon: FileVideoIcon, label: "Video", preview: "none" };
  if (type === "application/json") return BY_EXTENSION.json;
  if (type === "text/csv") return BY_EXTENSION.csv;
  if (type === "text/markdown") return BY_EXTENSION.md;
  if (type.endsWith("xml")) return BY_EXTENSION.xml;
  if (type.startsWith("text/")) return { icon: FileTextIcon, label: "Text file", preview: "text" };
  return { icon: FileIcon, label: ext ? `${ext.toUpperCase()} file` : "File", preview: "none" };
}

/** Text previews load whole, so keep them small; images a little larger. */
export const PREVIEW_LIMIT = { text: 512 * 1024, image: 8 * 1024 * 1024 } as const;

/**
 * The raw bytes of a file. The API client always parses JSON, so this is a
 * direct request with the same credentials and workspace pin it sends.
 */
export async function fetchFileContent(id: string, signal?: AbortSignal): Promise<Blob> {
  const tenant = getActiveTenantId();
  const token = await getClerkBearerToken();
  const res = await fetch(`/v1/files/${encodeURIComponent(id)}/content`, {
    credentials: "include",
    signal,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { "x-active-tenant": tenant } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(readApiError(body, res.status).message);
  }
  return res.blob();
}

/** Save a file to the person's machine under its own name. */
export async function downloadFile(file: Pick<FileRecord, "id" | "filename">): Promise<void> {
  const blob = await fetchFileContent(file.id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Rows of a CSV/TSV text. Handles quoted fields, escaped quotes and newlines inside quotes. */
export function parseDelimited(text: string, delimiter: "," | "\t", maxRows = 200): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let total = 0;
  const pushRow = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0] !== "") {
      total += 1;
      if (rows.length < maxRows) rows.push(row);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") pushRow();
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) pushRow();
  return { rows, total };
}
