import { useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { CheckIcon, DownloadIcon, LinkIcon, ShieldCheckIcon } from "lucide-react";

import { GALLERY_GRID } from "../lib/agents";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { EntityAvatar } from "../components/AgentAvatar";
import { Chip, StatusBadge } from "../components/Badge";
import { Callout } from "../components/Callout";
import { Disclosure } from "../components/Disclosure";
import { EmptyState } from "../components/EmptyState";
import { CodeWell } from "../components/EventCard";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { ErrorState } from "../components/QueryProblem";
import { Section } from "../components/SectionCard";
import { SkeletonCard } from "../components/Skeleton";
import { Tip } from "../components/Tip";
import { ListToolbar } from "../components/Toolbar";
import { errorMessage, formatBytes } from "../components/resources/ResourceBits";
import { CatalogSheet } from "../components/resources/SkillPanel";
import {
  CATEGORY_ORDER,
  categoryMeta,
  cleanDescription,
  humanSkillName,
  scanVerdict,
  skillSummary,
  type CatalogEntry,
  type ScanCandidate,
  skillIcon,
} from "../components/resources/skills";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { withReason } from "../lib/failure-text";

const GRID = GALLERY_GRID;

/**
 * One curated skill: a name a person would use, one whole line saying what
 * you get, who vouches for it, and Install. The card opens the skill's
 * panel, where its own description is shown in full.
 */
function CatalogCard({
  entry,
  installed,
  scanning,
  busy,
  onOpen,
  onInstall,
  className,
  style,
}: {
  entry: CatalogEntry;
  installed: boolean;
  scanning: boolean;
  busy: boolean;
  onOpen: () => void;
  onInstall: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const title = humanSkillName(entry.name);
  const summary = skillSummary(entry.description);
  return (
    <article
      style={style}
      className={cn(
        "group/card lift relative flex flex-col rounded-xl border border-border bg-bg-surface p-5 shadow-[var(--shadow-sm)]",
        "has-[h3>button:focus-visible]:outline-2 has-[h3>button:focus-visible]:outline-offset-2 has-[h3>button:focus-visible]:outline-plum",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <EntityAvatar icon={skillIcon(entry.name, entry.category)} size="lg" />
        {installed && (
          <span className="inline-flex h-[22px] items-center gap-1 rounded-full bg-success-subtle px-2 text-xs font-medium text-success">
            <CheckIcon className="size-3 stroke-[2.5]" />
            Installed
          </span>
        )}
      </div>
      <h3 className="mt-3.5 text-h3 text-fg">
        {/* The stretched button makes the whole card open the skill's panel. */}
        <button
          type="button"
          onClick={onOpen}
          title={title === entry.name ? undefined : `${title} (${entry.name})`}
          className="block max-w-full truncate rounded-sm text-left after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none"
        >
          {title}
        </button>
      </h3>
      {/* A whole sentence, never one cut by the card: the helper stops at a clause. */}
      <p className="mt-1 line-clamp-3 min-h-[2.5rem] text-small text-fg-muted">{summary || "No description."}</p>
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <Tip label={<span className="font-mono">{entry.source}</span>}>
          <span className="relative z-10 inline-flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
            <ShieldCheckIcon className="size-3.5 shrink-0" />
            <span className="truncate">{entry.curated ? "Curated by Anthropic" : "Community"}</span>
          </span>
        </Tip>
        {installed ? (
          <Button variant="ghost" size="sm" asChild className="relative z-10">
            <Link to="/skills">View</Link>
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={onInstall}
            disabled={busy}
            loading={scanning}
            loadingLabel="Scanning"
            aria-label={`Install ${title}`}
            className="relative z-10"
          >
            <DownloadIcon data-icon="inline-start" />
            Install
          </Button>
        )}
      </div>
    </article>
  );
}

/**
 * Skill catalog — browse and install.
 *
 * Two ways in: the curated manifest (GET /v1/skills/catalog), and
 * anything a URL can reach (a SKILL.md link, `owner/repo[/path]`, or a
 * whole `curl …` line from a marketplace listing).
 *
 * Every install goes through quarantine: POST /v1/skills/scan returns a
 * static-analysis report (verdict, findings, sha256); the person reads
 * it and approves; POST /v1/skills re-scans on the server and refuses a
 * blocked verdict whatever the client says.
 */
export function SkillsCatalog({ onInstalled }: { onInstalled?: () => void } = {}) {
  const { api } = useApi();
  const catalogQuery = useApiQuery<{ data: CatalogEntry[] }>("/v1/skills/catalog");
  const entries = useMemo(() => catalogQuery.data?.data ?? [], [catalogQuery.data]);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");

  const [showImport, setShowImport] = useState(false);
  const [importInput, setImportInput] = useState("");
  const [importError, setImportError] = useState("");
  const [scanning, setScanning] = useState<string | null>(null); // source being scanned
  const [candidates, setCandidates] = useState<ScanCandidate[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null); // candidate source
  const [installedNow, setInstalledNow] = useState<Set<string>>(new Set());
  const [openName, setOpenName] = useState<string | null>(null); // catalog entry shown in the panel

  const scan = async (source: string, fromImport = false) => {
    setScanning(source);
    setImportError("");
    try {
      const res = await api<{ data: ScanCandidate[] }>("/v1/skills/scan", {
        method: "POST",
        body: JSON.stringify({ source }),
        silentErrors: true,
      });
      // One overlay at a time: the report replaces the import form and the skill's panel.
      setShowImport(false);
      setOpenName(null);
      setCandidates(res.data);
    } catch (err) {
      const message = withReason("The scan failed", err);
      if (fromImport) setImportError(message);
      else toast.error(message);
    } finally {
      setScanning(null);
    }
  };

  const install = async (cand: ScanCandidate) => {
    setInstalling(cand.source);
    try {
      await api("/v1/skills", {
        method: "POST",
        body: JSON.stringify({ content: cand.content, source: cand.source }),
        silentErrors: true,
      });
      toast.success(`Installed ${humanSkillName(cand.name)}`);
      setInstalledNow((prev) => new Set(prev).add(cand.source));
      setCandidates((prev) => {
        const rest = (prev ?? []).filter((c) => c.source !== cand.source);
        return rest.length > 0 ? rest : null;
      });
      setImportInput("");
      void catalogQuery.refetch?.();
      onInstalled?.();
    } catch (err) {
      toast.error(withReason("The install failed", err));
    } finally {
      setInstalling(null);
    }
  };

  const isInstalled = (e: CatalogEntry) => e.installed || installedNow.has(e.source);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    const rank = (c: string) => {
      const i = CATEGORY_ORDER.indexOf(c);
      return i === -1 ? CATEGORY_ORDER.length : i;
    };
    return [...counts.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  }, [entries]);

  // The manifest arrives whole, so searching it here is exact.
  const q = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      entries.filter((e) => {
        if (category !== "all" && e.category !== category) return false;
        if (!q) return true;
        return (
          e.name.toLowerCase().includes(q) ||
          humanSkillName(e.name).toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q)
        );
      }),
    [entries, category, q],
  );
  const grouped = useMemo(
    () => categories.map(([c]) => [c, visible.filter((e) => e.category === c)] as const).filter(([, list]) => list.length > 0),
    [categories, visible],
  );
  const installedCount = entries.filter(isInstalled).length;
  const openEntry = openName ? (entries.find((e) => e.name === openName) ?? null) : null;

  const pill = (value: string, label: string, count: number) => {
    const active = category === value;
    return (
      <button
        key={value}
        type="button"
        aria-pressed={active}
        onClick={() => setCategory(value)}
        className={cn(
          "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-small-size font-medium transition-quick",
          active ? "bg-bg-pressed text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
        )}
      >
        {label}
        <span className={cn("text-xs font-normal", active ? "text-fg-muted" : "text-fg-subtle")}>{count}</span>
      </button>
    );
  };

  const card = (e: CatalogEntry, i: number) => (
    <CatalogCard
      key={e.name}
      entry={e}
      installed={isInstalled(e)}
      scanning={scanning === e.source}
      busy={scanning !== null}
      onOpen={() => setOpenName(e.name)}
      onInstall={() => void scan(e.source)}
      className="stagger animate-rise-in"
      style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
    />
  );

  return (
    <Page
      width="wide"
      header={
        <PageHeader
          width="wide"
          title="Skill catalog"
          subtitle="Ready-made skills for your agents. Every install is scanned, and you approve it first."
          actions={
            <>
              <Button variant="outline" asChild>
                <Link to="/skills">Installed skills</Link>
              </Button>
              <Button onClick={() => setShowImport(true)}>
                <LinkIcon data-icon="inline-start" />
                Import from URL
              </Button>
            </>
          }
          toolbar={
            <ListToolbar
              search={{ value: search, onChange: setSearch, placeholder: "Search the catalog" }}
              filters={
                entries.length > 0 ? (
                  <div className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto" role="group" aria-label="Category">
                    {pill("all", "All", entries.length)}
                    {categories.map(([c, n]) => pill(c, categoryMeta(c).label, n))}
                  </div>
                ) : undefined
              }
              summary={
                entries.length > 0 ? `${installedCount} of ${entries.length} installed` : undefined
              }
            />
          }
        />
      }
    >
      {catalogQuery.error ? (
        <ErrorState
          title="The catalog could not be loaded"
          error={catalogQuery.error}
          retry={() => void catalogQuery.refetch()}
        />
      ) : catalogQuery.isLoading ? (
        <div className={GRID} aria-hidden="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          kind="skill"
          size="lg"
          title="The catalog is empty"
          body="This server does not publish a curated catalog. You can still import a skill from a URL or a GitHub repository."
          action={<Button onClick={() => setShowImport(true)}>Import from URL</Button>}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          kind="skill"
          size="lg"
          title="No skills match"
          body="Try a different word, or look in another category."
          action={
            <Button
              variant="outline"
              onClick={() => {
                setSearch("");
                setCategory("all");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : category === "all" && !q ? (
        <div className="space-y-10">
          {grouped.map(([c, list]) => {
            const meta = categoryMeta(c);
            return (
              <Section key={c} title={meta.label} description={meta.blurb}>
                <div className={GRID}>{list.map(card)}</div>
              </Section>
            );
          })}
        </div>
      ) : (
        <div className={GRID}>{visible.map(card)}</div>
      )}

      {/* One skill, read before installing: its own description in full. */}
      <CatalogSheet
        entry={openEntry}
        installed={openEntry ? isInstalled(openEntry) : false}
        scanning={!!openEntry && scanning === openEntry.source}
        busy={scanning !== null}
        onInstall={(e) => void scan(e.source)}
        onClose={() => setOpenName(null)}
      />

      {/* Import from anywhere: the marketplace / arbitrary-URL path. */}
      <Modal
        open={showImport}
        onClose={() => {
          if (scanning) return;
          setShowImport(false);
          setImportError("");
        }}
        title="Import from URL"
        subtitle="Nothing installs yet. The content is fetched and scanned, and you read the report first."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowImport(false)} disabled={scanning !== null}>
              Cancel
            </Button>
            <Button
              onClick={() => void scan(importInput.trim(), true)}
              disabled={!importInput.trim()}
              loading={scanning !== null && scanning === importInput.trim()}
              loadingLabel="Scanning"
            >
              Scan skill
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {importError && <Callout tone="danger">{importError}</Callout>}
          <Field label="Where is the skill?">
            <Textarea
              value={importInput}
              onChange={(e) => setImportInput(e.target.value)}
              placeholder="https://example.com/skills/release-notes/SKILL.md"
              rows={3}
              autoFocus
              spellCheck={false}
              className="font-mono text-small-size md:text-small-size"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && importInput.trim()) {
                  e.preventDefault();
                  void scan(importInput.trim(), true);
                }
              }}
            />
          </Field>
          <div>
            <p className="text-xs font-medium text-fg-subtle">You can paste</p>
            <ul className="mt-2 space-y-1.5 text-small text-fg-muted">
              <li className="flex items-baseline gap-2">
                <Chip mono>URL</Chip>a link to a SKILL.md file
              </li>
              <li className="flex items-baseline gap-2">
                <Chip mono>owner/repo/path</Chip>a GitHub repository, or a folder in one
              </li>
              <li className="flex items-baseline gap-2">
                <Chip mono>curl …</Chip>the whole install command from a marketplace listing
              </li>
            </ul>
          </div>
        </div>
      </Modal>

      {/* Scan report: read, then approve. */}
      <Modal
        open={candidates !== null}
        onClose={() => {
          if (installing) return;
          setCandidates(null);
        }}
        title="Review before installing"
        subtitle="A skill is instructions your agents will follow. Read what the scan found, then decide."
        maxWidth="max-w-2xl"
        footer={
          <Button variant="ghost" onClick={() => setCandidates(null)} disabled={installing !== null}>
            Close
          </Button>
        }
      >
        <div className="space-y-4">
          {(candidates ?? []).map((cand) => {
            const verdict = scanVerdict(cand.report.verdict);
            const blocked = cand.report.verdict === "blocked";
            return (
              <section key={cand.source} className="overflow-hidden rounded-lg border border-border">
                <header className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-h3 text-fg" title={cand.name || undefined}>
                      {humanSkillName(cand.name)}
                    </h3>
                    <p className="mt-0.5 truncate font-mono text-micro-size text-fg-subtle" title={cand.source}>
                      {cand.source}
                    </p>
                  </div>
                  <StatusBadge status={cand.report.verdict} label={verdict.label} tone={verdict.tone} variant="soft" />
                </header>
                <div className="space-y-3 px-4 pb-4">
                  {cand.description && (
                    <p className="text-small text-fg-muted">{cleanDescription(cand.description)}</p>
                  )}
                  {cand.report.findings.length === 0 ? (
                    <Callout tone="success" icon={ShieldCheckIcon}>
                      No findings. The static scan came back clean.
                    </Callout>
                  ) : (
                    <ul className={cn("space-y-2 rounded-lg p-3", blocked ? "bg-danger-subtle" : "bg-warning-subtle")}>
                      {cand.report.findings.map((f, i) => (
                        <li key={i} className="flex items-baseline gap-2 text-small">
                          <Chip tone={f.severity === "block" ? "danger" : "warning"} className="bg-bg-surface dark:bg-bg-soft">
                            {f.severity === "block" ? "Blocks install" : "Needs review"}
                          </Chip>
                          <span className="min-w-0">
                            <span className="font-mono text-xs text-fg-muted">{f.kind}</span>{" "}
                            <span className="break-words text-fg">{f.detail}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Disclosure
                    title="Read SKILL.md"
                    meta={`${formatBytes(cand.report.bytes)} · sha256 ${cand.report.content_sha256.slice(0, 12)}…`}
                  >
                    <CodeWell className="max-h-64">
                      {cand.content.slice(0, 4000)}
                      {cand.content.length > 4000 ? "\n…" : ""}
                    </CodeWell>
                  </Disclosure>
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <p className="min-w-0 text-xs text-fg-subtle">
                      {blocked
                        ? "Blocking findings cannot be overridden."
                        : "The content is pinned to this hash when it installs."}
                    </p>
                    {!blocked && (
                      <Button
                        size="sm"
                        onClick={() => void install(cand)}
                        disabled={installing !== null}
                        loading={installing === cand.source}
                        loadingLabel="Installing"
                      >
                        {cand.report.verdict === "flagged" ? "Approve and install" : "Install skill"}
                      </Button>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      </Modal>
    </Page>
  );
}
