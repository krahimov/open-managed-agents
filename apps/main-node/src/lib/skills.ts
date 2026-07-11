/**
 * Skills — tenant-scoped SKILL.md storage with one-shot GitHub import.
 *
 * A skill is a single SKILL.md document (Vercel skills-CLI compatible:
 * YAML frontmatter `name` + `description`, markdown body). Agents attach
 * skills via AgentConfig.skills [{type:"custom", skill_id}]; the
 * claude-agent-sdk harness materializes attached skills into the session
 * cwd at .claude/skills/<name>/SKILL.md and enables project-scope
 * discovery (settingSources MUST include "project" — `skills:` alone
 * cannot compensate, discovery is governed by settingSources).
 *
 * Import sources accepted by importFromSource():
 *   - raw URL ending in SKILL.md
 *   - "owner/repo" or "owner/repo/sub/path" GitHub shorthand (HEAD branch);
 *     when the path has no SKILL.md, the repo tree is scanned for
 *     skills/<x>/SKILL.md entries (capped) — same layout `npx skills add`
 *     produces.
 *
 * Storage follows the self-contained DDL pattern (node-session-work-queue,
 * webhooks) — promote to packages/db-schema when the feature graduates.
 */

import { nanoid } from "nanoid";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { publicUrlAllowed } from "./webhooks.js";

export interface SkillRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  source: string;
  content: string;
  created_at: number;
  /** sha256 of the exact installed bytes — what the human approved is what
   *  runs; materialization re-verifies against this. */
  content_hash?: string | null;
  /** curated | approved | flagged | blocked (quarantine pipeline verdict at
   *  install time; legacy rows are null). */
  security_status?: string | null;
  /** JSON SkillScanReport from skill-scan.ts, for the console report card. */
  security_report?: string | null;
}

const MAX_IMPORT_PER_REPO = 10;
const MAX_SKILL_BYTES = 256 * 1024;

export function parseFrontmatter(content: string): { name?: string; description?: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!m) return {};
  const lines = m[1].split("\n");
  const pick = (key: string) => {
    const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (idx === -1) return undefined;
    const inline = lines[idx].slice(key.length + 1).trim();
    // YAML block scalar (`description: >` or `|`, with optional +/- chomping):
    // the value is the following deeper-indented lines, joined. Folded (>)
    // vs literal (|) both collapse to spaces here — descriptions are prose,
    // and this parser stays deliberately dumb (no YAML dependency).
    if (/^[>|][+-]?$/.test(inline)) {
      const block: string[] = [];
      for (let i = idx + 1; i < lines.length; i++) {
        if (lines[i].trim() === "") continue;
        if (!/^\s/.test(lines[i])) break;
        block.push(lines[i].trim());
      }
      return block.length > 0 ? block.join(" ") : undefined;
    }
    return inline ? inline.replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: pick("name"), description: pick("description") };
}

/** kebab-case the skill name so it doubles as a directory name. */
export function normalizeSkillName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export class SkillStore {
  constructor(private readonly sql: SqlClient) {}

  async ensureSchema(): Promise<void> {
    await this.sql.exec(`CREATE TABLE IF NOT EXISTS skills (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      source text NOT NULL DEFAULT '',
      content text NOT NULL,
      created_at bigint NOT NULL
    )`);
    await this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_skills_tenant ON skills (tenant_id, name)`,
    );
    // Quarantine-pipeline columns, additive for pre-existing tables. ADD
    // COLUMN throws when the column exists — swallow per-column so partial
    // upgrades converge (same pattern as other self-contained DDL stores).
    for (const ddl of [
      `ALTER TABLE skills ADD COLUMN content_hash text`,
      `ALTER TABLE skills ADD COLUMN security_status text`,
      `ALTER TABLE skills ADD COLUMN security_report text`,
    ]) {
      try {
        await this.sql.exec(ddl);
      } catch {
        // column already exists
      }
    }
  }

  async create(opts: {
    tenantId: string;
    content: string;
    source?: string;
    name?: string;
    contentHash?: string;
    securityStatus?: string;
    securityReport?: string;
  }): Promise<SkillRow> {
    if (opts.content.length > MAX_SKILL_BYTES) throw new Error("skill content too large");
    const fm = parseFrontmatter(opts.content);
    const name = normalizeSkillName(opts.name ?? fm.name ?? "");
    if (!name) throw new Error("skill needs a name (frontmatter `name:` or explicit)");
    const row: SkillRow = {
      id: `skill-${nanoid()}`,
      tenant_id: opts.tenantId,
      name,
      description: fm.description ?? "",
      source: opts.source ?? "",
      content: opts.content,
      created_at: Date.now(),
      content_hash: opts.contentHash ?? null,
      security_status: opts.securityStatus ?? null,
      security_report: opts.securityReport ?? null,
    };
    await this.sql
      .prepare(
        `INSERT INTO skills (id, tenant_id, name, description, source, content, created_at, content_hash, security_status, security_report)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.tenant_id,
        row.name,
        row.description,
        row.source,
        row.content,
        row.created_at,
        row.content_hash,
        row.security_status,
        row.security_report,
      )
      .run();
    return row;
  }

  async list(tenantId: string): Promise<Array<Omit<SkillRow, "content">>> {
    const res = await this.sql
      .prepare(
        `SELECT id, tenant_id, name, description, source, created_at, content_hash, security_status
         FROM skills WHERE tenant_id = ? ORDER BY created_at DESC`,
      )
      .bind(tenantId)
      .all<Omit<SkillRow, "content">>();
    return res.results ?? [];
  }

  async get(tenantId: string, id: string): Promise<SkillRow | null> {
    return this.sql
      .prepare(`SELECT * FROM skills WHERE tenant_id = ? AND id = ?`)
      .bind(tenantId, id)
      .first<SkillRow>();
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const res = await this.sql
      .prepare(`DELETE FROM skills WHERE tenant_id = ? AND id = ?`)
      .bind(tenantId, id)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /** Resolve agent skill refs ({type:"custom", skill_id}) to rows; unknown
   *  ids are skipped (agent still runs, skill simply absent). */
  async resolveRefs(
    tenantId: string,
    refs: Array<{ skill_id: string; type: string }> | undefined,
  ): Promise<SkillRow[]> {
    const out: SkillRow[] = [];
    for (const ref of refs ?? []) {
      if (ref.type !== "custom" || !ref.skill_id) continue;
      const row = await this.get(tenantId, ref.skill_id).catch(() => null);
      if (row) out.push(row);
    }
    return out;
  }

  /**
   * Fetch SKILL.md candidates from a raw URL or GitHub owner/repo[/path]
   * shorthand WITHOUT installing — the quarantine pipeline scans between
   * fetch and create (routes call fetchFromSource → scan → create).
   */
  async fetchFromSource(
    source: string,
  ): Promise<Array<{ content: string; source: string }>> {
    const fetchText = async (
      url: string,
      redirect: "follow" | "error" | "manual" = "follow",
    ): Promise<string | null> => {
      const res = await fetch(url, {
        headers: { "user-agent": "openma-skills-import/1.0" },
        signal: AbortSignal.timeout(15_000),
        redirect,
      });
      if (!res.ok) return null;
      const text = await res.text();
      return text.length > MAX_SKILL_BYTES ? null : text;
    };

    // Raw URL straight to a SKILL.md. User-supplied, so it goes through the
    // SSRF gate (public https hosts only) and redirects are refused — a
    // public URL 302ing to an internal address must not be followed. The
    // fixed-host GitHub fetches below skip both (host is ours to choose).
    if (/^https?:\/\//.test(source)) {
      if (!(await publicUrlAllowed(source))) {
        throw new Error(
          "URL not allowed: skill imports fetch only public HTTPS hosts (private/internal addresses are blocked)",
        );
      }
      const text = await fetchText(source, "error").catch(() => null);
      if (!text) {
        throw new Error(
          `could not fetch ${source} (redirects are not followed — paste the final URL)`,
        );
      }
      return [{ content: text, source }];
    }

    // GitHub shorthand: owner/repo[/sub/path]
    const m = /^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/.exec(source.trim());
    if (!m) throw new Error("source must be a URL or owner/repo[/path]");
    const [, owner, repo, sub] = m;
    const raw = (p: string) => `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${p}`;

    // 1. Direct SKILL.md at the given path (or repo root)
    const direct = await fetchText(raw(sub ? `${sub}/SKILL.md` : "SKILL.md"));
    if (direct) {
      return [{ content: direct, source }];
    }

    // 2. Scan the repo tree for */SKILL.md (npx-skills repo layout)
    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
      { headers: { "user-agent": "openma-skills-import/1.0" }, signal: AbortSignal.timeout(15_000) },
    );
    if (!treeRes.ok) throw new Error(`github tree lookup failed (${treeRes.status})`);
    const tree = (await treeRes.json()) as { tree?: Array<{ path: string; type: string }> };
    const paths = (tree.tree ?? [])
      .filter((e) => e.type === "blob" && e.path.endsWith("SKILL.md"))
      .filter((e) => !sub || e.path.startsWith(`${sub}/`))
      .slice(0, MAX_IMPORT_PER_REPO);
    if (paths.length === 0) throw new Error("no SKILL.md found in repo");

    const out: Array<{ content: string; source: string }> = [];
    for (const e of paths) {
      const text = await fetchText(raw(e.path));
      if (!text) continue;
      out.push({ content: text, source: `${source}:${e.path}` });
    }
    if (out.length === 0) throw new Error("found SKILL.md entries but none fetchable");
    return out;
  }

  /** Legacy one-shot import (fetch + install, no scan gate) — kept for the
   *  CLI path; console + agent flows go through fetchFromSource + scan. */
  async importFromSource(tenantId: string, source: string): Promise<SkillRow[]> {
    const candidates = await this.fetchFromSource(source);
    const out: SkillRow[] = [];
    for (const c of candidates) {
      out.push(await this.create({ tenantId, content: c.content, source: c.source }));
    }
    return out;
  }
}
