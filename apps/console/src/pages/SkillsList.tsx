import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { CopyIcon, LayoutGridIcon, Rows3Icon, Trash2Icon, UploadIcon } from "lucide-react";

import { GALLERY_GRID } from "../lib/agents";
import { useApi } from "../lib/api";
import { useServerFeature } from "../lib/server-features";
import { copyText } from "../lib/clipboard";
import { useApiQuery } from "../lib/useApiQuery";
import { EntityAvatar } from "../components/AgentAvatar";
import { Chip, StatusBadge } from "../components/Badge";
import { Callout } from "../components/Callout";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { Field } from "../components/Field";
import { FilterChip } from "../components/FilterChip";
import { Modal } from "../components/Modal";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu, type RowAction } from "../components/RowActionsMenu";
import { SegmentedControl } from "../components/SegmentedControl";
import { Tip } from "../components/Tip";
import { ResourceIdentity, errorMessage } from "../components/resources/ResourceBits";
import { ResourceListError } from "../components/resources/ResourceListError";
import { SkillDropZone, SkillSheet } from "../components/resources/SkillPanel";
import {
  skillOrigin,
  skillSecurity,
  skillSummary,
  skillTitle,
  type Skill,
  skillIcon,
} from "../components/resources/skills";
import { UsedBy, useResourceUsage } from "../components/resources/usage";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PopoverContent } from "@/components/ui/popover";
import type { AgentRecord } from "../types/agent";

type SourceValue = "any" | "anthropic" | "custom";
type ViewValue = "grid" | "list";

const SOURCE_OPTIONS: { value: SourceValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "anthropic", label: "Anthropic" },
  { value: "custom", label: "Custom" },
];

const SUBTITLE = "Playbooks your agents can pick up: instructions and files for one kind of work.";
const VIEW_KEY = "muse:skills:view";

function readView(): ViewValue {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

/** The security scan of a skill as a soft badge; nothing when the runtime reports none. */
function SecurityBadge({ skill, variant = "soft" }: { skill: Skill; variant?: "soft" | "dot" }) {
  const security = skillSecurity(skill.security_status);
  if (!security) return null;
  return (
    <Tip label={security.about}>
      <span className="relative z-10 inline-flex">
        <StatusBadge status={skill.security_status ?? ""} label={security.label} tone={security.tone} variant={variant} />
      </span>
    </Tip>
  );
}

/** A skill as a card: what it teaches, where it came from, who uses it. */
function SkillCard({
  skill,
  agents,
  agentsLoading,
  menu,
  onOpen,
  className,
  style,
}: {
  skill: Skill;
  agents: AgentRecord[] | undefined;
  agentsLoading: boolean;
  menu: React.ReactNode;
  onOpen: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const origin = skillOrigin(skill);
  // One whole line in a person's words; the skill's own description is in its panel.
  const description = skillSummary(skill.description);
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
        <EntityAvatar icon={skillIcon(`${skill.name} ${skillTitle(skill)}`)} size="lg" />
        <div className="relative z-10 -mt-1 -mr-2 opacity-0 transition-quick group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-[[aria-expanded=true]]:opacity-100">
          {menu}
        </div>
      </div>
      <h3 className="mt-3.5 text-h3 text-fg">
        {/* The stretched button makes the whole card the click target. */}
        <button
          type="button"
          onClick={onOpen}
          className="block max-w-full truncate rounded-sm text-left after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none"
          title={skillTitle(skill) === skill.name ? skill.name : `${skillTitle(skill)} (${skill.name})`}
        >
          {skillTitle(skill)}
        </button>
      </h3>
      <p className="mt-1 line-clamp-3 min-h-[2.5rem] text-small text-fg-muted">{description || "No description yet."}</p>
      <div className="mt-4 flex h-[22px] flex-wrap items-center gap-x-1.5 gap-y-2 overflow-hidden">
        <Tip label={origin.detail ?? `Source: ${origin.label}`}>
          <span className="relative z-10 inline-flex min-w-0">
            <Chip>{origin.label}</Chip>
          </span>
        </Tip>
        <SecurityBadge skill={skill} />
        {skill.latest_version != null && (
          <Chip tone="outline" mono>
            v{skill.latest_version}
          </Chip>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 pt-5 text-xs">
        <span className="relative z-10 min-w-0">
          <UsedBy agents={agents} loading={agentsLoading} />
        </span>
        <span className="shrink-0 text-fg-subtle">
          Added <RelativeTime value={skill.created_at} />
        </span>
      </div>
    </article>
  );
}

/**
 * Skills — the playbooks installed in this workspace. A gallery by
 * default (a skill is something you recognise), with a List view for
 * scanning. Opening a skill shows it in a side panel; new skills come
 * from the catalog or a .zip upload.
 */
export function SkillsList() {
  const { api } = useApi();
  const navigate = useNavigate();
  const usage = useResourceUsage();

  const [source, setSource] = useState<SourceValue>("any");
  const [search, setSearch] = useState("");
  const [view, setViewState] = useState<ViewValue>(readView);
  const setView = (v: ViewValue) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // storage unavailable: the choice just will not persist
    }
  };

  // `source` goes to the server (the hosted runtime filters on it).
  const skillsParams = useMemo(() => (source !== "any" ? { source } : {}), [source]);
  const { data: skillsRes, isLoading: loading, error, refetch } = useApiQuery<{ data: Skill[] }>(
    "/v1/skills",
    skillsParams,
  );
  const all = useMemo(() => skillsRes?.data ?? [], [skillsRes]);

  // /v1/skills returns the whole list in one response (it is not paged),
  // so narrowing it here is exact, not a guess about unseen pages. The
  // source is also matched locally because one runtime ignores the param.
  const skills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((s) => {
      if (source !== "any" && skillOrigin(s).kind !== source) return false;
      if (!q) return true;
      return (
        skillTitle(s).toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        (s.source ?? "").toLowerCase().includes(q)
      );
    });
  }, [all, search, source]);

  const agentsFor = (s: Skill) => usage.skills.get(s.id) ?? usage.skills.get(s.name);

  // Panel, upload, delete
  const [open, setOpen] = useState<Skill | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Skill | null>(null);

  const [showUpload, setShowUpload] = useState(false);
  // A .zip upload needs a server that takes one; elsewhere skills come from the catalog.
  const canUpload = useServerFeature("skill_versions");
  const [title, setTitle] = useState("");
  const [zip, setZip] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const closeUpload = () => {
    if (uploading) return;
    setShowUpload(false);
    setTitle("");
    setZip(null);
    setUploadError("");
  };
  const upload = async () => {
    if (!zip) return;
    setUploadError("");
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", zip);
      // An empty title would override the server's fallback to the
      // SKILL.md name, so it is only sent when something was typed.
      if (title.trim()) fd.append("display_title", title.trim());
      await api("/v1/skills/upload", { method: "POST", body: fd, silentErrors: true });
      setShowUpload(false);
      setTitle("");
      setZip(null);
      void refetch();
    } catch (e) {
      setUploadError(errorMessage(e, "The upload failed"));
    } finally {
      setUploading(false);
    }
  };

  const actionsFor = (s: Skill): RowAction[] => [
    { label: "Copy skill id", icon: <CopyIcon />, onSelect: () => void copyText(s.id) },
    {
      label: "Delete",
      icon: <Trash2Icon />,
      destructive: true,
      // Built-in skills are not the workspace's to delete.
      disabled: s.source === "anthropic",
      onSelect: () => setConfirmDelete(s),
    },
  ];

  const columns = useMemo<ColumnDef<Skill>[]>(
    () => [
      {
        id: "name",
        accessorFn: (s) => skillTitle(s),
        header: "Skill",
        size: 470,
        enableHiding: false,
        cell: ({ row }) => (
          <ResourceIdentity
            icon={skillIcon(`${row.original.name} ${skillTitle(row.original)}`)}
            name={skillTitle(row.original)}
            secondary={skillSummary(row.original.description) || "No description"}
          />
        ),
      },
      {
        id: "source",
        header: "Source",
        size: 200,
        cell: ({ row }) => {
          const origin = skillOrigin(row.original);
          return (
            <span className="truncate text-fg-muted" title={origin.detail ?? origin.label}>
              {origin.label}
            </span>
          );
        },
      },
      {
        id: "security",
        header: "Security",
        size: 150,
        cell: ({ row }) =>
          skillSecurity(row.original.security_status) ? (
            <SecurityBadge skill={row.original} variant="dot" />
          ) : (
            <span className="text-fg-subtle">Not scanned</span>
          ),
      },
      {
        id: "used_by",
        header: "Used by",
        size: 200,
        cell: ({ row }) => <UsedBy agents={agentsFor(row.original)} loading={usage.isLoading} />,
      },
      {
        id: "created",
        accessorFn: (s) => s.created_at,
        header: "Added",
        size: 110,
        cell: ({ row }) => <RelativeTime value={row.original.created_at} className="text-fg-muted" />,
      },
      {
        id: "actions",
        header: "",
        size: 56,
        enableHiding: false,
        cell: ({ row }) => (
          <RowActionsMenu label={`Actions for ${skillTitle(row.original)}`} actions={actionsFor(row.original)} />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [usage],
  );

  const sourceDisplay = source === "any" ? undefined : SOURCE_OPTIONS.find((o) => o.value === source)?.label;
  const filtered = !!search.trim() || source !== "any";

  if (error && all.length === 0) {
    return (
      <ResourceListError title="Skills" subtitle={SUBTITLE} what="Skills" error={error} retry={() => void refetch()} />
    );
  }

  return (
    <DataTable<Skill>
      title="Skills"
      subtitle={SUBTITLE}
      headerActions={
        <>
          {canUpload && (
            <Button variant="outline" onClick={() => setShowUpload(true)}>
              <UploadIcon data-icon="inline-start" />
              Upload skill
            </Button>
          )}
          <Button onClick={() => navigate("/skills/catalog")}>Browse catalog</Button>
        </>
      }
      searchPlaceholder="Search skills"
      searchValue={search}
      onSearchChange={setSearch}
      filters={
        <FilterChip label="Source" active={source !== "any"} display={sourceDisplay} onClear={() => setSource("any")}>
          <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-52 gap-0 p-0">
            <FacetedFilter
              options={SOURCE_OPTIONS}
              value={source}
              onValueChange={(v) => setSource(v as SourceValue)}
              searchPlaceholder="Source"
            />
          </PopoverContent>
        </FilterChip>
      }
      summary={loading || skills.length === 0 ? undefined : `${skills.length} ${skills.length === 1 ? "skill" : "skills"}`}
      toolbarTrailing={
        <SegmentedControl<ViewValue>
          label="View"
          value={view}
          onChange={setView}
          iconOnly
          options={[
            { value: "grid", label: "Gallery", icon: LayoutGridIcon },
            { value: "list", label: "List", icon: Rows3Icon },
          ]}
        />
      }
      layout={view === "grid" ? "grid" : "table"}
      gridClassName={GALLERY_GRID}
      renderCard={(s, i) => (
        <SkillCard
          key={s.id}
          skill={s}
          agents={agentsFor(s)}
          agentsLoading={usage.isLoading}
          onOpen={() => setOpen(s)}
          className="stagger animate-rise-in"
          style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
          menu={<RowActionsMenu label={`Actions for ${skillTitle(s)}`} actions={actionsFor(s)} />}
        />
      )}
      data={skills}
      loading={loading}
      getRowId={(s) => s.id}
      onRowClick={setOpen}
      columns={columns}
      emptyKind="skill"
      emptyTitle={filtered ? "No skills match" : "No skills yet"}
      emptySubtitle={
        filtered
          ? "Try a different name, or clear the filters."
          : "A skill is a folder of instructions an agent loads when a task calls for it: a house style, a review checklist, how to build a spreadsheet. Start from the catalog."
      }
      filtered={filtered}
      emptyAction={
        filtered ? (
          <Button
            variant="outline"
            onClick={() => {
              setSearch("");
              setSource("any");
            }}
          >
            Clear filters
          </Button>
        ) : (
          <>
            <Button asChild>
              <Link to="/skills/catalog">Browse catalog</Link>
            </Button>
            {canUpload && (
              <Button variant="ghost" onClick={() => setShowUpload(true)}>
                Upload a skill
              </Button>
            )}
          </>
        )
      }
    >
      <SkillSheet
        skill={open}
        agents={open ? agentsFor(open) : undefined}
        agentsLoading={usage.isLoading}
        onClose={() => setOpen(null)}
        onChanged={() => void refetch()}
        onDelete={setConfirmDelete}
      />

      <Modal
        open={showUpload}
        onClose={closeUpload}
        title="Upload skill"
        subtitle="A skill folder packaged as a .zip, with SKILL.md at its root."
        maxWidth="max-w-xl"
        footer={
          <>
            <Button variant="ghost" onClick={closeUpload} disabled={uploading}>
              Cancel
            </Button>
            <Button onClick={() => void upload()} disabled={!zip} loading={uploading}>
              Upload skill
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          {uploadError && <Callout tone="danger">{uploadError}</Callout>}
          <SkillDropZone file={zip} onFile={setZip} onError={setUploadError} disabled={uploading} />
          <Field label="Display title" hint="Optional. Leave blank to use the name in SKILL.md.">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Release notes style"
              disabled={uploading}
              autoComplete="off"
            />
          </Field>
          <p className="text-xs text-fg-subtle">
            The zip can hold SKILL.md at the top level, or one folder that contains it, which is what{" "}
            <code className="rounded-sm bg-bg-soft px-1 py-0.5 font-mono text-micro-size text-fg-muted">
              zip -r my-skill.zip my-skill
            </code>{" "}
            produces.
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        destructive
        title={`Delete ${confirmDelete ? skillTitle(confirmDelete) : "skill"}?`}
        body={`The skill is removed from this workspace. ${(() => {
          const n = confirmDelete ? (agentsFor(confirmDelete)?.length ?? 0) : 0;
          return n > 0 ? `${n} ${n === 1 ? "agent uses" : "agents use"} it. ` : "";
        })()}This cannot be undone.`}
        confirmLabel="Delete skill"
        onConfirm={async () => {
          if (!confirmDelete) return;
          await api(`/v1/skills/${confirmDelete.id}`, { method: "DELETE" });
          setOpen(null);
          void refetch();
        }}
      />
    </DataTable>
  );
}
