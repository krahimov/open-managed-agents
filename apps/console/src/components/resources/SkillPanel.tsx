import { useQuietQuery } from "@/lib/useApiQuery";
import { PanelGroup } from "../PanelGroup";
import { useRef, useState } from "react";
import { CheckIcon, DownloadIcon, FileArchiveIcon, ShieldCheckIcon, Trash2Icon, UploadCloudIcon } from "lucide-react";
import { Link } from "react-router";

import { useApi } from "@/lib/api";
import { formatAbsolute } from "@/lib/format";
import { useQueryClient } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import type { AgentRecord } from "../../types/agent";
import { EntityAvatar } from "../AgentAvatar";
import { Chip, StatusBadge } from "../Badge";
import { Callout } from "../Callout";
import { CodeWell } from "../EventCard";
import { CopyButton, IdChip } from "../IdChip";
import { Property, PropertyList } from "../PropertyList";
import { RelativeTime } from "../RelativeTime";
import { Skeleton, SkeletonText } from "../Skeleton";
import { errorMessage, formatBytes } from "./ResourceBits";
import {
  MAX_UPLOAD_BYTES,
  categoryMeta,
  cleanDescription,
  descriptionIsCutOff,
  humanSkillName,
  isZipFile,
  parseScanReport,
  skillOrigin,
  skillSecurity,
  skillSummary,
  skillTitle,
  type CatalogEntry,
  type Skill,
  type VersionDetail,
  type VersionSummary,
  skillIcon,
} from "./skills";
import { UsedByList } from "./usage";

// ── Drop zone ───────────────────────────────────────────────────────

/**
 * Where a skill .zip is dropped or chosen. Validates type and size before
 * accepting; the caller owns the file and the error message.
 */
export function SkillDropZone({
  file,
  onFile,
  onError,
  disabled,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const accept = (f: File) => {
    if (!isZipFile(f)) return onError(`"${f.name}" is not a .zip file.`);
    if (f.size > MAX_UPLOAD_BYTES) {
      return onError(`That zip is ${formatBytes(f.size)}. The upload limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`);
    }
    onError("");
    onFile(f);
  };
  const clear = () => {
    onFile(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled) return;
        const f = e.dataTransfer.files?.[0];
        if (f) accept(f);
      }}
      className={cn(
        "rounded-lg border border-dashed transition-quick",
        over ? "border-plum bg-plum-subtle/50" : "border-border-strong bg-bg-inset/60",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) accept(f);
        }}
      />
      {file ? (
        <div className="flex items-center gap-3 px-4 py-3.5">
          <EntityAvatar icon={FileArchiveIcon} size="lg" tone="surface" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-small-size font-medium text-fg" title={file.name}>
              {file.name}
            </div>
            <div className="text-xs text-fg-subtle">{formatBytes(file.size)}</div>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => inputRef.current?.click()}>
            Replace
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            Remove
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center px-4 py-8 text-center">
          <span className="flex size-10 items-center justify-center rounded-[12px] bg-bg-surface text-fg-muted shadow-[var(--shadow-xs)] dark:bg-bg-soft">
            <UploadCloudIcon className="size-5" />
          </span>
          <p className="mt-3 text-small-size font-medium text-fg">Drop a skill .zip here</p>
          <p className="mt-0.5 text-xs text-fg-muted">Up to {formatBytes(MAX_UPLOAD_BYTES)}, with SKILL.md inside.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3.5" onClick={() => inputRef.current?.click()}>
            Choose file
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Skill panel ─────────────────────────────────────────────────────

/**
 * A skill, inspected without leaving the list: what it is, where it came
 * from, whether it passed its scan, which agents use it, what it tells
 * them (SKILL.md and files), and its versions where the runtime keeps
 * them.
 */
export function SkillSheet({
  skill,
  agents,
  agentsLoading,
  onClose,
  onChanged,
  onDelete,
}: {
  skill: Skill | null;
  agents: AgentRecord[] | undefined;
  agentsLoading?: boolean;
  onClose: () => void;
  /** The skill changed on the server (new version): refresh the list. */
  onChanged: () => void;
  onDelete: (skill: Skill) => void;
}) {
  return (
    <Sheet open={!!skill} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-full gap-0 p-0 data-[side=right]:sm:max-w-[580px]"
        // Keep focus on the panel itself: the first focusable element is a
        // copy chip, and focusing it would pop its tooltip on open.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus?.();
        }}
        tabIndex={-1}
      >
        {skill && (
          <SkillSheetBody
            key={skill.id}
            skill={skill}
            agents={agents}
            agentsLoading={agentsLoading}
            onChanged={onChanged}
            onDelete={onDelete}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SkillSheetBody({
  skill: listed,
  agents,
  agentsLoading,
  onChanged,
  onDelete,
}: {
  skill: Skill;
  agents: AgentRecord[] | undefined;
  agentsLoading?: boolean;
  onChanged: () => void;
  onDelete: (skill: Skill) => void;
}) {
  const { api } = useApi();
  const queryClient = useQueryClient();

  // The record carries more than the list row (SKILL.md, the scan report).
  const detail = useQuietQuery<Skill>(`/v1/skills/${listed.id}`);
  const skill: Skill = { ...listed, ...(detail.data ?? {}) };

  // Versions exist only where the runtime keeps them.
  const versioned = skill.latest_version != null;
  const versions = useQuietQuery<{ data: VersionSummary[] }>(`/v1/skills/${skill.id}/versions`, versioned);
  const latest = useQuietQuery<VersionDetail>(
    `/v1/skills/${skill.id}/versions/${skill.latest_version}`,
    versioned,
  );

  const origin = skillOrigin(skill);
  const security = skillSecurity(skill.security_status);
  const report = parseScanReport(skill.security_report);
  const builtIn = skill.source === "anthropic";
  const title = skillTitle(skill);
  const snippet = `"skills": [{ "type": "${builtIn ? "anthropic" : "custom"}", "skill_id": "${builtIn ? skill.name : skill.id}"${versioned ? ', "version": "latest"' : ""} }]`;

  // New version (versioned runtimes only)
  const [showUpload, setShowUpload] = useState(false);
  const [zip, setZip] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const publish = async () => {
    if (!zip) return;
    setUploadError("");
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", zip);
      await api(`/v1/skills/${skill.id}/versions/upload`, { method: "POST", body: fd, silentErrors: true });
      setShowUpload(false);
      setZip(null);
      onChanged();
      await queryClient.invalidateQueries({ queryKey: ["quiet"] });
    } catch (e) {
      setUploadError(errorMessage(e, "The upload failed"));
    } finally {
      setUploading(false);
    }
  };

  const files = latest.data?.files ?? [];

  return (
    <>
      <SheetHeader className="flex-row items-start gap-4 pb-5">
        <EntityAvatar icon={skillIcon(`${skill.name} ${title}`)} size="xl" />
        <div className="min-w-0 flex-1 pt-0.5">
          <SheetTitle className="truncate" title={title}>
            {title}
          </SheetTitle>
          <SheetDescription className="mt-1">{skillSummary(skill.description) || "No description."}</SheetDescription>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Chip title={origin.detail}>{origin.label}</Chip>
            {security && (
              <StatusBadge status={skill.security_status ?? ""} label={security.label} tone={security.tone} variant="soft" />
            )}
            {versioned && (
              <Chip tone="outline" mono>
                v{skill.latest_version}
              </Chip>
            )}
          </div>
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 pb-6">
        <OwnDescription description={skill.description} />

        <PanelGroup label="Details">
          <PropertyList>
            <Property label="Source">
              <span className="break-all" title={origin.detail}>
                {origin.detail ?? origin.label}
              </span>
            </Property>
            {title !== skill.name && (
              <Property label="Name">
                <span className="font-mono text-xs">{skill.name}</span>
              </Property>
            )}
            {security && (
              <Property label="Security scan" align="start">
                <span className="inline-flex items-start gap-1.5">
                  <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
                  <span>
                    {security.about}
                    {report && (
                      <span className="block text-fg-subtle">
                        {report.findings.length === 0
                          ? "No findings."
                          : `${report.findings.length} ${report.findings.length === 1 ? "finding" : "findings"}.`}{" "}
                        {report.bytes > 0 && formatBytes(report.bytes)}
                      </span>
                    )}
                  </span>
                </span>
              </Property>
            )}
            {skill.content_hash && (
              <Property label="Pinned hash">
                <span className="inline-flex items-center gap-1">
                  <span className="font-mono text-xs text-fg-muted" title={skill.content_hash}>
                    sha256 {skill.content_hash.slice(0, 12)}…
                  </span>
                  <CopyButton value={skill.content_hash} label="Copy sha256" className="size-6" />
                </span>
              </Property>
            )}
            <Property label="Added">
              <RelativeTime value={skill.created_at} />
            </Property>
            <Property label="Skill id">
              <IdChip id={skill.id} full />
            </Property>
          </PropertyList>
          {report && report.findings.length > 0 && (
            <ul className="mt-3 space-y-1.5 rounded-lg bg-bg-soft p-3">
              {report.findings.map((f, i) => (
                <li key={i} className="flex items-baseline gap-2 text-xs">
                  <Chip tone={f.severity === "block" ? "danger" : "warning"}>{f.severity === "block" ? "Blocked" : "Flagged"}</Chip>
                  <span className="shrink-0 font-mono text-fg-subtle">{f.kind}</span>
                  <span className="break-words text-fg-muted">{f.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </PanelGroup>

        <PanelGroup label="Used by">
          <UsedByList
            agents={agents}
            loading={agentsLoading}
            empty="No agent has this skill yet. Add it from an agent's Edit dialog, or with the snippet below."
          />
        </PanelGroup>

        <PanelGroup label="Add it to an agent" action={<CopyButton value={snippet} label="Copy snippet" className="size-6" />}>
          <CodeWell className="max-h-none text-fg-muted">{snippet}</CodeWell>
        </PanelGroup>

        {detail.isLoading && !skill.content && !versioned ? (
          <PanelGroup label="SKILL.md">
            <SkeletonText lines={6} />
          </PanelGroup>
        ) : skill.content ? (
          <PanelGroup label="SKILL.md" action={<CopyButton value={skill.content} label="Copy SKILL.md" className="size-6" />}>
            <CodeWell className="max-h-[420px]">{skill.content}</CodeWell>
          </PanelGroup>
        ) : null}

        {versioned && (
          <PanelGroup label={`Files in v${skill.latest_version}`}>
            {latest.isLoading ? (
              <SkeletonText lines={4} />
            ) : files.length === 0 ? (
              <p className="text-small text-fg-subtle">
                {latest.error ? "The files of this version could not be loaded." : "This version has no files."}
              </p>
            ) : (
              <div className="space-y-3">
                {files.map((f) => (
                  <div key={f.filename}>
                    <div className="mb-1 flex h-6 items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs text-fg-muted" title={f.filename}>
                        {f.filename}
                      </span>
                      {f.encoding === "base64" ? (
                        <Chip>Binary</Chip>
                      ) : (
                        <CopyButton value={f.content} label={`Copy ${f.filename}`} className="size-6" />
                      )}
                    </div>
                    {f.encoding === "base64" ? (
                      <p className="rounded-md bg-bg-soft px-3 py-2 text-xs text-fg-subtle">Binary file. Not previewed.</p>
                    ) : (
                      <CodeWell className="max-h-60">{f.content}</CodeWell>
                    )}
                  </div>
                ))}
              </div>
            )}
          </PanelGroup>
        )}

        {versioned && (
          <PanelGroup
            label="Versions"
            action={
              !builtIn && !showUpload ? (
                <Button variant="ghost" size="xs" onClick={() => setShowUpload(true)}>
                  Upload new version
                </Button>
              ) : undefined
            }
          >
            {showUpload && (
              <div className="mb-3 space-y-3 rounded-lg border border-border p-3.5">
                {uploadError && <Callout tone="danger">{uploadError}</Callout>}
                <SkillDropZone file={zip} onFile={setZip} onError={setUploadError} disabled={uploading} />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={uploading}
                    onClick={() => {
                      setShowUpload(false);
                      setZip(null);
                      setUploadError("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => void publish()} disabled={!zip} loading={uploading}>
                    Publish version
                  </Button>
                </div>
              </div>
            )}
            {versions.isLoading ? (
              <Skeleton className="h-9 w-full" rounded="lg" />
            ) : (versions.data?.data ?? []).length === 0 ? (
              <p className="text-small text-fg-subtle">No version history is available.</p>
            ) : (
              <ul className="overflow-hidden rounded-lg border border-border">
                {(versions.data?.data ?? []).map((v) => (
                  <li
                    key={v.version}
                    className="flex h-10 items-center justify-between gap-3 border-t border-border px-3.5 text-small first:border-t-0"
                  >
                    <span className="flex items-center gap-2">
                      <Chip tone="outline" mono>
                        v{v.version}
                      </Chip>
                      {v.version === skill.latest_version && <Chip tone="success">Latest</Chip>}
                    </span>
                    <span className="text-fg-muted" title={formatAbsolute(v.created_at)}>
                      <RelativeTime value={v.created_at} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </PanelGroup>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-bg-inset/60 px-6 py-3.5">
        <p className="min-w-0 truncate text-xs text-fg-subtle">
          {builtIn ? "Built-in skills are maintained by Anthropic and cannot be removed." : "Deleting a skill cannot be undone."}
        </p>
        {!builtIn && (
          <Button variant="outline" size="sm" onClick={() => onDelete(skill)}>
            <Trash2Icon data-icon="inline-start" />
            Delete skill
          </Button>
        )}
      </div>
    </>
  );
}

// ── The skill's own words ───────────────────────────────────────────

/**
 * A skill's description as its author wrote it. It is addressed to the
 * agent ("Use this skill whenever…"), which is why cards show a rephrased
 * line instead; here it is shown whole and said to be what it is. Draws
 * nothing when the card's line already is the whole description.
 */
function OwnDescription({ description, catalog }: { description: string | null | undefined; catalog?: boolean }) {
  const full = cleanDescription(description);
  if (!full) return null;
  const cutOff = descriptionIsCutOff(description);
  if (!cutOff && full.replace(/[.\s]+$/, "") === skillSummary(description).replace(/[.\s]+$/, "")) return null;
  return (
    <PanelGroup label="When agents use it">
      <p className="text-small whitespace-pre-line text-fg-muted">
        {full}
        {cutOff && "…"}
      </p>
      <p className="mt-2 text-xs text-fg-subtle">
        The skill's own description. Agents read it to decide when to pick the skill up.
        {cutOff && catalog && " The catalog lists the first part; the scan report shows the whole SKILL.md."}
      </p>
    </PanelGroup>
  );
}

// ── Catalog entry panel ─────────────────────────────────────────────

/**
 * A skill in the catalog, read before installing: what you get, the
 * skill's own description in full, where it comes from, and Install.
 */
export function CatalogSheet({
  entry,
  installed,
  scanning,
  busy,
  onInstall,
  onClose,
}: {
  entry: CatalogEntry | null;
  installed: boolean;
  /** This entry is being fetched and scanned. */
  scanning: boolean;
  /** Another scan is running. */
  busy: boolean;
  onInstall: (entry: CatalogEntry) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!entry} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-full gap-0 p-0 data-[side=right]:sm:max-w-[520px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus?.();
        }}
        tabIndex={-1}
      >
        {entry && (
          <CatalogSheetBody entry={entry} installed={installed} scanning={scanning} busy={busy} onInstall={onInstall} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function CatalogSheetBody({
  entry,
  installed,
  scanning,
  busy,
  onInstall,
}: {
  entry: CatalogEntry;
  installed: boolean;
  scanning: boolean;
  busy: boolean;
  onInstall: (entry: CatalogEntry) => void;
}) {
  const title = humanSkillName(entry.name);
  const category = categoryMeta(entry.category);
  return (
    <>
      <SheetHeader className="flex-row items-start gap-4 pb-5">
        <EntityAvatar icon={skillIcon(entry.name, entry.category)} size="xl" />
        <div className="min-w-0 flex-1 pt-0.5">
          <SheetTitle className="truncate pr-8" title={title}>
            {title}
          </SheetTitle>
          <SheetDescription className="mt-1">{skillSummary(entry.description) || "No description."}</SheetDescription>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Chip icon={category.icon}>{category.label}</Chip>
            {entry.curated && <Chip icon={ShieldCheckIcon}>Curated by Anthropic</Chip>}
            {installed && (
              <Chip tone="success" icon={CheckIcon}>
                Installed
              </Chip>
            )}
          </div>
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 pb-6">
        <OwnDescription description={entry.description} catalog />

        <PanelGroup label="Details">
          <PropertyList>
            <Property label="Name">
              <span className="inline-flex items-center gap-1">
                <span className="font-mono text-xs">{entry.name}</span>
                <CopyButton value={entry.name} label="Copy name" className="size-6" />
              </span>
            </Property>
            <Property label="Source" align="start">
              <span className="inline-flex items-start gap-1">
                <span className="font-mono text-xs break-all text-fg-muted">{entry.source}</span>
                <CopyButton value={entry.source} label="Copy source" className="-mt-1 size-6 shrink-0" />
              </span>
            </Property>
            <Property label="Vetting" align="start">
              {entry.curated
                ? "Curated by Anthropic. Scanned again and pinned to a hash when it installs."
                : "From the community. Scanned and pinned to a hash when it installs."}
            </Property>
          </PropertyList>
        </PanelGroup>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-bg-inset/60 px-6 py-3.5">
        <p className="min-w-0 text-xs text-fg-subtle">
          {installed ? "Already in this workspace." : "Nothing installs until you have read the scan report."}
        </p>
        {installed ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/skills">View installed skills</Link>
          </Button>
        ) : (
          <Button size="sm" onClick={() => onInstall(entry)} disabled={busy} loading={scanning} loadingLabel="Scanning">
            <DownloadIcon data-icon="inline-start" />
            Install
          </Button>
        )}
      </div>
    </>
  );
}
