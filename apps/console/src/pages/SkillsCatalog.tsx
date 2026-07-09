import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Modal } from "../components/Modal";
import { Button } from "@/components/ui/button";

/**
 * Skills → Catalog tab. Browse-and-install over two sources:
 *
 *   1. Curated manifest (anthropics/skills) — GET /v1/skills/catalog,
 *      one-click install, "curated" badge.
 *   2. Anything curl can reach — paste a URL, owner/repo[/path], or a
 *      whole `curl …` one-liner (MCP Market listings hand out those).
 *
 * Every install runs the quarantine pipeline: POST /v1/skills/scan returns
 * a static-analysis report card (verdict, findings, sha256); the human
 * ratifies flags; POST /v1/skills re-scans server-side and hard-stops
 * blocked verdicts regardless of what the client claimed.
 */

interface CatalogEntry {
  name: string;
  category: string;
  source: string;
  description: string;
  curated: boolean;
  installed: boolean;
}

interface ScanFinding {
  severity: "block" | "flag";
  kind: string;
  detail: string;
}

interface ScanCandidate {
  source: string;
  name: string;
  description: string;
  content: string;
  report: {
    verdict: "pass" | "flagged" | "blocked";
    findings: ScanFinding[];
    content_sha256: string;
    bytes: number;
  };
}

const VERDICT_STYLE: Record<string, string> = {
  pass: "text-success bg-success-subtle",
  flagged: "text-warning bg-warning-subtle",
  blocked: "text-danger bg-danger-subtle",
};

const CATEGORY_ORDER = ["documents", "design", "engineering", "communication", "meta", "general"];

export function SkillsCatalog({ onInstalled }: { onInstalled?: () => void } = {}) {
  const { api } = useApi();
  const catalogQuery = useApiQuery<{ data: CatalogEntry[] }>("/v1/skills/catalog");
  const entries = useMemo(() => catalogQuery.data?.data ?? [], [catalogQuery.data]);

  const [importInput, setImportInput] = useState("");
  const [scanning, setScanning] = useState<string | null>(null); // source being scanned
  const [candidates, setCandidates] = useState<ScanCandidate[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null); // candidate source
  const [installedNow, setInstalledNow] = useState<Set<string>>(new Set());

  const scan = async (source: string) => {
    setScanning(source);
    try {
      const res = await api<{ data: ScanCandidate[] }>("/v1/skills/scan", {
        method: "POST",
        body: JSON.stringify({ source }),
      });
      setCandidates(res.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Scan failed");
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
      });
      toast.success(`Installed ${cand.name || "skill"}`);
      setInstalledNow((prev) => new Set(prev).add(cand.source));
      setCandidates((prev) => {
        const rest = (prev ?? []).filter((c) => c.source !== cand.source);
        return rest.length > 0 ? rest : null;
      });
      void catalogQuery.refetch?.();
      onInstalled?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Install failed");
    } finally {
      setInstalling(null);
    }
  };

  const grouped = useMemo(() => {
    const byCat = new Map<string, CatalogEntry[]>();
    for (const e of entries) {
      const list = byCat.get(e.category) ?? [];
      list.push(e);
      byCat.set(e.category, list);
    }
    return [...byCat.entries()].sort(
      (a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]),
    );
  }, [entries]);

  return (
    <div className="flex-1 overflow-y-auto">
    <div className="pl-4 pr-5 py-6 space-y-8 max-w-6xl">
      <header>
        <h1 className="text-[20px] leading-tight font-semibold text-fg">Skill catalog</h1>
        <p className="mt-1.5 text-[15px] text-fg-muted">
          Curated skills your agents can learn — every install is scanned and hash-pinned.
        </p>
      </header>
      {/* Import-from-anywhere — the MCP Market / arbitrary-URL path. */}
      <section className="border border-border rounded-lg bg-bg-surface p-4">
        <div className="text-sm font-medium">Import from a URL or marketplace</div>
        <p className="mt-1 text-xs text-fg-muted max-w-[68ch]">
          Paste a SKILL.md URL, a GitHub <span className="font-mono">owner/repo[/path]</span>, or a
          whole <span className="font-mono">curl</span> command from a marketplace listing. The
          content is scanned before anything installs — you'll review the report first.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            value={importInput}
            onChange={(e) => setImportInput(e.target.value)}
            placeholder="https://…/SKILL.md · owner/repo · curl -fsSL https://…"
            className="flex-1 bg-bg border border-border rounded-md px-3 py-1.5 text-[13px] font-mono placeholder:text-fg-subtle focus:outline-none focus:border-border-strong"
            onKeyDown={(e) => {
              if (e.key === "Enter" && importInput.trim()) void scan(importInput.trim());
            }}
          />
          <Button
            onClick={() => scan(importInput.trim())}
            disabled={!importInput.trim() || scanning !== null}
            loading={scanning === importInput.trim()}
            loadingLabel="Scanning…"
          >
            Scan
          </Button>
        </div>
      </section>

      {/* Curated catalog grid */}
      {grouped.map(([category, items]) => (
        <section key={category}>
          <div className="text-[11px] uppercase tracking-wider text-fg-subtle font-semibold mb-2.5">
            {category}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {items.map((e) => (
              <div
                key={e.name}
                className="border border-border rounded-lg bg-bg-surface p-3.5 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[13px] font-medium truncate">{e.name}</span>
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-accent shrink-0">
                    curated
                  </span>
                </div>
                <p className="text-xs text-fg-muted line-clamp-3 flex-1">{e.description}</p>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-fg-subtle font-mono truncate">{e.source}</span>
                  {e.installed || installedNow.has(e.source) ? (
                    <span className="text-xs font-medium text-success shrink-0">Installed ✓</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => scan(e.source)}
                      disabled={scanning !== null}
                      loading={scanning === e.source}
                      loadingLabel="Scanning…"
                    >
                      Install
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {catalogQuery.isLoading && (
        <div className="text-sm text-fg-subtle">Loading catalog…</div>
      )}

      {/* ===== Scan report / ratification dialog ===== */}
      <Modal
        open={candidates !== null}
        onClose={() => setCandidates(null)}
        title="Security scan report"
        subtitle="Review what this skill contains before installing — a skill is instructions your agents will follow."
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          {(candidates ?? []).map((cand) => (
            <div key={cand.source} className="border border-border rounded-lg overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border bg-bg-surface">
                <div className="min-w-0">
                  <span className="font-mono text-sm font-medium">{cand.name || "unnamed"}</span>
                  <span className="ml-2 text-[11px] text-fg-subtle font-mono truncate">
                    {cand.source}
                  </span>
                </div>
                <span
                  className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded ${VERDICT_STYLE[cand.report.verdict]}`}
                >
                  {cand.report.verdict}
                </span>
              </div>
              <div className="px-4 py-3 space-y-2 text-xs">
                {cand.description && <p className="text-fg-muted">{cand.description}</p>}
                <div className="font-mono text-[11px] text-fg-subtle">
                  sha256 {cand.report.content_sha256.slice(0, 16)}… · {cand.report.bytes} bytes
                </div>
                {cand.report.findings.length === 0 ? (
                  <div className="text-success">No findings — clean static scan.</div>
                ) : (
                  <ul className="space-y-1">
                    {cand.report.findings.map((f, i) => (
                      <li key={i} className="flex gap-2 items-baseline">
                        <span
                          className={`shrink-0 text-[10px] uppercase font-bold ${f.severity === "block" ? "text-danger" : "text-warning"}`}
                        >
                          {f.severity}
                        </span>
                        <span className="font-mono text-[11px] text-fg-subtle shrink-0">
                          {f.kind}
                        </span>
                        <span className="text-fg-muted break-all">{f.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <details>
                  <summary className="cursor-pointer text-fg-subtle hover:text-fg">
                    Preview content
                  </summary>
                  <pre className="mt-2 p-2 bg-bg rounded border border-border max-h-48 overflow-auto text-[11px] whitespace-pre-wrap">
                    {cand.content.slice(0, 4000)}
                    {cand.content.length > 4000 ? "\n…" : ""}
                  </pre>
                </details>
                <div className="pt-1 flex justify-end">
                  {cand.report.verdict === "blocked" ? (
                    <span className="text-danger text-xs">
                      Blocked — hard findings can't be overridden.
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => install(cand)}
                      disabled={installing !== null}
                      loading={installing === cand.source}
                      loadingLabel="Installing…"
                    >
                      {cand.report.verdict === "flagged" ? "Approve & install" : "Install"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
    </div>
  );
}
