import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { CopyIcon, CpuIcon, PencilIcon, Trash2Icon } from "lucide-react";
import type { ModelCard } from "@open-managed-agents/api-types";

import { useApi } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { countWords, formatCompact, formatCost, toDate } from "../lib/format";
import { describeModel, type ModelProvider } from "../lib/models";
import { useApiQuery, useInfiniteApiQuery } from "../lib/useApiQuery";
import { EntityAvatar } from "../components/AgentAvatar";
import { Chip } from "../components/Badge";
import { BrandLoader } from "../components/BrandLoader";
import { Callout } from "../components/Callout";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, RowLink, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { Field } from "../components/Field";
import { CreatedFilterChip, FilterChip } from "../components/FilterChip";
import { SecretInput } from "../components/Input";
import { LocalCombobox } from "../components/LocalCombobox";
import { Modal } from "../components/Modal";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu, type RowAction } from "../components/RowActionsMenu";
import { Skeleton } from "../components/Skeleton";
import { Tip } from "../components/Tip";
import { OverflowTip } from "../components/OverflowTip";
import { PROVIDER_MARKS } from "../components/resources/provider-marks";
import { ChoiceCards, KeyValueRows, MaskedSecret, errorMessage } from "../components/resources/ResourceBits";
import { ResourceListError } from "../components/resources/ResourceListError";
import { UsedBy, useResourceUsage } from "../components/resources/usage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PopoverContent } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { withReason } from "../lib/failure-text";

// Provider enum: mirrors the whitelist on the server (model-cards GET
// handler). Anything outside these four is rejected with a 400 there, so
// the filter options and the form's choice cards must stay in sync.
const PROVIDERS = [
  { value: "ant", label: "Anthropic", desc: "Claude models, direct from Anthropic" },
  { value: "oai", label: "OpenAI", desc: "GPT models, direct from OpenAI" },
  { value: "ant-compatible", label: "Anthropic-compatible", desc: "A proxy or gateway that speaks the Anthropic API" },
  { value: "oai-compatible", label: "OpenAI-compatible", desc: "DeepSeek, Groq, Together, Ollama and others" },
] as const;

type ProviderValue = (typeof PROVIDERS)[number]["value"];

const PROVIDER_FILTER_OPTIONS: { value: ProviderValue | "any"; label: string }[] = [
  { value: "any", label: "All" },
  ...PROVIDERS.map((p) => ({ value: p.value, label: p.label })),
];

const OFFICIAL_PROVIDERS = new Set<string>(["ant", "oai"]);

const providerName = (p: string) => PROVIDERS.find((x) => x.value === p)?.label || p || "Custom";

/** Whose model a card is: its provider when it is a first-party one, else the family its model id belongs to. */
function providerOfCard(card: Pick<ModelCard, "provider" | "model">): ModelProvider {
  if (card.provider === "ant") return "anthropic";
  if (card.provider === "oai") return "openai";
  return describeModel(card.model).provider;
}

/**
 * The leading mark of a model row: the provider's own mark (Anthropic,
 * OpenAI, Google), so a list of models can be told apart by who serves
 * them at a glance. A model behind a gateway we cannot place keeps the
 * generic chip.
 */
function ProviderTile({ card }: { card: Pick<ModelCard, "provider" | "model"> }) {
  const mark = PROVIDER_MARKS[providerOfCard(card)];
  if (!mark) return <EntityAvatar icon={CpuIcon} size="md" />;
  return (
    <EntityAvatar size="md" className="text-fg">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-[52%]">
        <path d={mark} />
      </svg>
    </EntityAvatar>
  );
}

function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const SUBTITLE = "The models your agents can run on, each with the provider key that pays for it.";

const INITIAL_FORM = {
  provider: "ant" as ProviderValue,
  model_id: "",
  model: "",
  api_key: "",
  base_url: "",
  is_default: false,
  custom_headers: [{ key: "", value: "" }] as Array<{ key: string; value: string }>,
};

interface UsageReport {
  range?: { since: number; until: number };
  models?: Array<{ model: string; provider: string; cost_usd: number; tokens: number }>;
}

/**
 * Models — provider keys, as the models agents can pick. One row per
 * model: who serves it, which key pays for it (masked), which agents run
 * on it and what it has cost lately. Rows open the edit dialog.
 */
export function ModelCardsList() {
  const { api } = useApi();
  const usage = useResourceUsage();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ModelCard | null>(null);
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ModelCard | null>(null);

  // Server-driven filter state.
  const [provider, setProvider] = useState<ProviderValue | "any">("any");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  const cardsParams = useMemo(
    () => ({
      ...(provider !== "any" ? { provider } : {}),
      ...(created.after !== undefined ? { created_after: new Date(created.after).toISOString() } : {}),
      ...(created.before !== undefined ? { created_before: new Date(created.before).toISOString() } : {}),
      ...(search ? { q: search } : {}),
    }),
    [provider, created.after, created.before, search],
  );

  const {
    items: cards,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh,
    error,
  } = useInfiniteApiQuery<ModelCard>("/v1/model_cards", { limit: 20, params: cardsParams });

  // Recent spend per model, from the same report the Usage page reads.
  const { data: report, isLoading: usageLoading } = useApiQuery<UsageReport>("/v1/usage");
  const spendByModel = useMemo(() => {
    const map = new Map<string, { cost: number; tokens: number }>();
    for (const m of report?.models ?? []) map.set(m.model, { cost: m.cost_usd, tokens: m.tokens });
    return map;
  }, [report]);
  const rangeDays = report?.range ? Math.max(1, Math.round((report.range.until - report.range.since) / 86_400_000)) : 30;

  // Fetch the provider's model list with the key the person just typed.
  const fetchModels = useCallback(
    async (prov: string, apiKey: string) => {
      if (!OFFICIAL_PROVIDERS.has(prov) || !apiKey || apiKey.length < 8) {
        setAvailableModels([]);
        return;
      }
      setModelsLoading(true);
      try {
        const result = await api<{ data: Array<{ id: string; name: string }> }>("/v1/models/list", {
          method: "POST",
          body: JSON.stringify({ provider: prov, api_key: apiKey }),
          silentErrors: true,
        });
        setAvailableModels(result.data);
      } catch {
        setAvailableModels([]);
      } finally {
        setModelsLoading(false);
      }
    },
    [api],
  );

  const openCreate = () => {
    setEditing(null);
    setForm({ ...INITIAL_FORM, custom_headers: [{ key: "", value: "" }] });
    setAvailableModels([]);
    setFormError("");
    setShowForm(true);
  };

  const startEdit = (card: ModelCard) => {
    const hdrs = card.custom_headers
      ? Object.entries(card.custom_headers).map(([key, value]) => ({ key, value }))
      : [];
    if (hdrs.length === 0) hdrs.push({ key: "", value: "" });
    setForm({
      // Older rows may carry a provider outside the current enum; the
      // choice cards then show none selected.
      provider: card.provider as ProviderValue,
      model_id: card.model_id,
      model: card.model,
      api_key: "",
      base_url: card.base_url || "",
      is_default: card.is_default || false,
      custom_headers: hdrs,
    });
    setAvailableModels([]);
    setEditing(card);
    setFormError("");
    setShowForm(true);
  };

  const closeForm = () => {
    if (saving) return;
    setShowForm(false);
    setFormError("");
  };

  const official = OFFICIAL_PROVIDERS.has(form.provider);
  const canSave = !!form.model_id.trim() && (!!editing || !!form.api_key);

  const save = async () => {
    setFormError("");
    if (!canSave) {
      setFormError("A model ID and an API key are required.");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        provider: form.provider,
        model_id: form.model_id.trim(),
        // The wire model defaults to the handle: the common case is "the
        // handle IS the model string". A distinct value is only needed for
        // an alias (handle "claude-prod" → wire "claude-sonnet-4-6").
        model: form.model.trim() || form.model_id.trim(),
        api_key: form.api_key,
        is_default: form.is_default,
      };
      if (form.base_url) payload.base_url = form.base_url;
      const hdrs: Record<string, string> = {};
      for (const h of form.custom_headers) {
        if (h.key && h.value) hdrs[h.key] = h.value;
      }
      if (Object.keys(hdrs).length > 0) payload.custom_headers = hdrs;
      if (editing) {
        if (!form.api_key) delete payload.api_key;
        await api(`/v1/model_cards/${editing.id}`, {
          method: "POST",
          body: JSON.stringify(payload),
          silentErrors: true,
        });
        toast.success("Model saved");
      } else {
        // Create returns the card plus a probe of the key, so a broken
        // key / base URL / model id is reported now, not on the first turn.
        const result = await api<{ probe?: { ok: boolean | null; message?: string; reason?: string } }>(
          "/v1/model_cards",
          { method: "POST", body: JSON.stringify(payload), silentErrors: true },
        );
        const probe = result.probe;
        if (probe?.ok === true) {
          toast.success(`Model added. The ${providerName(form.provider)} key was verified.`);
        } else if (probe?.ok === false) {
          toast.warning(
            probe.message
              ? `Model saved, but the key did not work: ${probe.message}`
              : "Model saved, but the key did not work. Check the API key, base URL and model id.",
          );
        } else {
          toast.success("Model added");
        }
      }
      setShowForm(false);
      refresh();
    } catch (e) {
      setFormError(withReason("The model could not be saved", e));
    } finally {
      setSaving(false);
    }
  };

  const actionsFor = (c: ModelCard): RowAction[] => [
    { label: "Edit", icon: <PencilIcon />, onSelect: () => startEdit(c) },
    { label: "Copy model id", icon: <CopyIcon />, onSelect: () => void copyText(c.model_id) },
    { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setConfirmDelete(c) },
  ];

  const columns = useMemo<ColumnDef<ModelCard>[]>(
    () => [
      {
        id: "model_id",
        accessorKey: "model_id",
        header: "Model",
        size: 310,
        minSize: 230,
        enableHiding: false,
        enableSorting: true,
        cell: ({ row }) => {
          const c = row.original;
          const info = describeModel(c.model_id);
          const friendly = info.label !== c.model_id;
          // The id agents ask for, and the model it sends when the two differ.
          const secondary =
            (friendly ? c.model_id : c.model !== c.model_id ? `sends ${c.model}` : providerName(c.provider)) +
            (friendly && c.model !== c.model_id ? ` → ${c.model}` : "");
          return (
            <div className="flex min-w-0 items-center gap-3">
              <ProviderTile card={c} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <RowLink full={c.model_id} className={friendly ? "font-medium text-fg" : "font-mono text-xs font-medium text-fg"}>
                    {info.label}
                  </RowLink>
                  {c.is_default && (
                    <Tip label="Agents created without a model use this one">
                      <span className="inline-flex shrink-0">
                        <Chip>Default</Chip>
                      </span>
                    </Tip>
                  )}
                </div>
                <div className="flex min-w-0">
                  <OverflowTip label={secondary} focusable>
                    <div className="min-w-0 truncate rounded-sm font-mono text-micro-size text-fg-subtle">{secondary}</div>
                  </OverflowTip>
                </div>
              </div>
            </div>
          );
        },
      },
      {
        id: "provider",
        accessorKey: "provider",
        header: "Provider",
        size: 170,
        cell: ({ row }) => {
          const c = row.original;
          const host = hostOf(c.base_url);
          return (
            <div className="min-w-0 leading-tight">
              <div className="truncate text-fg">{providerName(c.provider)}</div>
              {host && (
                <div className="truncate font-mono text-micro-size text-fg-subtle" title={c.base_url}>
                  {host}
                </div>
              )}
            </div>
          );
        },
      },
      {
        id: "api_key",
        accessorFn: (c) => c.api_key_preview ?? "",
        header: "API key",
        size: 150,
        // Its last characters only tell two keys apart; the edit dialog shows them too.
        meta: { hideBelow: 1000 },
        cell: ({ row }) => <MaskedSecret preview={row.original.api_key_preview} />,
      },
      {
        id: "used_by",
        header: "Used by",
        size: 250,
        cell: ({ row }) => <UsedBy agents={usage.models.get(row.original.model_id)} loading={usage.isLoading} />,
      },
      {
        id: "spend",
        accessorFn: (c) => (spendByModel.get(c.model) ?? spendByModel.get(c.model_id))?.cost,
        header: `Last ${rangeDays} days`,
        size: 150,
        enableSorting: true,
        sortDescFirst: true,
        meta: { hideBelow: 720, align: "right", label: "Recent spend" },
        cell: ({ row }) => {
          if (usageLoading) return <Skeleton className="ml-auto h-3.5 w-14" rounded="sm" />;
          const s = spendByModel.get(row.original.model) ?? spendByModel.get(row.original.model_id);
          if (!s) return <span className="text-fg-subtle">No usage</span>;
          return (
            <div className="min-w-0 leading-tight">
              <div className="truncate text-fg">{formatCost(s.cost)}</div>
              <div className="truncate text-xs text-fg-subtle">{formatCompact(s.tokens)} tokens</div>
            </div>
          );
        },
      },
      {
        id: "created",
        accessorFn: (c) => toDate(c.created_at)?.getTime(),
        header: "Added",
        size: 116,
        enableSorting: true,
        sortDescFirst: true,
        cell: ({ row }) => <RelativeTime value={row.original.created_at} className="text-fg-muted" />,
      },
      {
        id: "actions",
        header: "",
        size: 56,
        enableHiding: false,
        cell: ({ row }) => (
          <RowActionsMenu label={`Actions for ${row.original.model_id}`} actions={actionsFor(row.original)} />
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [usage, spendByModel, usageLoading, rangeDays],
  );

  const providerDisplay =
    provider === "any" ? undefined : PROVIDER_FILTER_OPTIONS.find((o) => o.value === provider)?.label;
  const filtered = !!search || provider !== "any" || created.after !== undefined || created.before !== undefined;
  const clearFilters = () => {
    setSearch("");
    setProvider("any");
    setCreated({});
  };

  if (error && cards.length === 0) {
    return <ResourceListError title="Models" subtitle={SUBTITLE} what="Models" error={error} retry={refresh} />;
  }

  return (
    <DataTable<ModelCard>
      title="Models"
      subtitle={SUBTITLE}
      createLabel="+ New model"
      onCreate={openCreate}
      searchPlaceholder="Search models"
      searchValue={search}
      onSearchChange={setSearch}
      filters={
        <>
          <FilterChip
            label="Provider"
            active={provider !== "any"}
            display={providerDisplay}
            onClear={() => setProvider("any")}
          >
            <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-60 gap-0 p-0">
              <FacetedFilter
                options={PROVIDER_FILTER_OPTIONS}
                value={provider}
                onValueChange={(v) => setProvider(v as ProviderValue | "any")}
                searchPlaceholder="Provider"
              />
            </PopoverContent>
          </FilterChip>
          <CreatedFilterChip value={created} onChange={setCreated} />
        </>
      }
      summary={
        loading || cards.length === 0
          ? undefined
          : countWords(cards.length, hasMore, "model")
      }
      data={cards}
      loading={loading}
      onRowClick={startEdit}
      getRowId={(c) => c.id}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      columns={columns}
      emptyKind="model_card"
      emptyTitle={filtered ? "No models match" : "No models yet"}
      emptySubtitle={
        filtered
          ? "Try a different name, or widen the filters."
          : "Add a model with your own provider key and agents can run on it. Until you do, agents fall back to the key configured on the server."
      }
      filtered={filtered}
      emptyAction={
        filtered ? (
          <Button variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : (
          <Button onClick={openCreate}>New model</Button>
        )
      }
    >
      <Modal
        open={showForm}
        onClose={closeForm}
        title={editing ? "Edit model" : "New model"}
        subtitle={
          editing
            ? "Change how this model is served. Agents keep referring to it by its model ID."
            : "Connect a provider key and give the model a handle your agents can use."
        }
        maxWidth="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={closeForm} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={!canSave} loading={saving}>
              {editing ? "Save model" : "Add model"}
            </Button>
          </>
        }
      >
        <form autoComplete="off" onSubmit={(e) => e.preventDefault()} className="space-y-5">
          {formError && <Callout tone="danger">{formError}</Callout>}

          <div>
            <p id="modelcard-provider-label" className="mb-1.5 text-small leading-5 font-medium text-fg">
              API format
            </p>
            <ChoiceCards<ProviderValue>
              label="API format"
              value={PROVIDERS.some((p) => p.value === form.provider) ? form.provider : null}
              onChange={(p) => {
                setForm({ ...form, provider: p, model: "", base_url: "" });
                setAvailableModels([]);
              }}
              options={PROVIDERS.map((p) => ({ value: p.value, label: p.label, description: p.desc }))}
            />
          </div>

          <Field
            label="Model ID"
            hint="The handle agents reference. It must be unique in this workspace."
          >
            <Input
              value={form.model_id}
              onChange={(e) => setForm({ ...form, model_id: e.target.value })}
              placeholder={form.provider.startsWith("oai") ? "gpt-5.5" : "claude-sonnet-4-6"}
              autoComplete="off"
              data-1p-ignore
              className="font-mono text-small-size md:text-small-size"
            />
          </Field>

          <div>
            <SecretInput
              label="API key"
              hint={
                editing ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    Current key <MaskedSecret preview={editing.api_key_preview} /> Leave blank to keep it.
                  </span>
                ) : (
                  "Stored encrypted. After you save, only the last four characters are ever shown."
                )
              }
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder={editing ? "Paste a new key to replace the current one" : "sk-..."}
              name="model-api-key-field"
              onBlur={() => {
                if (official && form.api_key) void fetchModels(form.provider, form.api_key);
              }}
            />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <label htmlFor="modelcard-wire-model" className="text-small leading-5 font-medium text-fg">
                Wire model
              </label>
              {official && modelsLoading && (
                <span className="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
                  <BrandLoader size="sm" label="Loading models" /> Loading models
                </span>
              )}
            </div>
            <LocalCombobox<{ id: string; name: string }>
              id="modelcard-wire-model"
              value={form.model}
              onChange={(text) => setForm({ ...form, model: text })}
              onPick={(m) => setForm({ ...form, model: m.id })}
              options={availableModels}
              filter={(m, q) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)}
              getKey={(m) => m.id}
              renderItem={(m) => (
                <div className="flex min-w-0 items-baseline gap-2 px-3 py-2">
                  <span className="truncate text-sm text-fg">{m.name !== m.id ? m.name : m.id}</span>
                  {m.name !== m.id && <span className="truncate font-mono text-xs text-fg-subtle">{m.id}</span>}
                </div>
              )}
              placeholder={
                form.model_id ||
                (official
                  ? form.provider === "ant"
                    ? "claude-sonnet-4-6"
                    : "gpt-5.5"
                  : "deepseek-chat, llama-3.1-70b")
              }
              emptyHint={
                official
                  ? "Enter a valid API key above to list the provider's models, or type a model name."
                  : "Type the model name your provider expects."
              }
            />
            <p className="mt-1.5 text-xs text-fg-subtle">
              The model name sent to the provider. Leave blank to send the model ID.
            </p>
          </div>

          {!official && (
            <Field label="Base URL" hint="The endpoint that speaks this API format.">
              <Input
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder={form.provider === "ant-compatible" ? "https://your-proxy.com/v1" : "https://api.deepseek.com/v1"}
                autoComplete="off"
                className="font-mono text-small-size md:text-small-size"
              />
            </Field>
          )}

          {!official && (
            <div>
              <p className="mb-1.5 text-small leading-5 font-medium text-fg">
                Custom headers <span className="font-normal text-fg-subtle">(optional)</span>
              </p>
              <KeyValueRows
                rows={form.custom_headers}
                onChange={(rows) => setForm({ ...form, custom_headers: rows })}
                keyPlaceholder="Header-Name"
                valuePlaceholder="value"
                addLabel="Add header"
                noun="header"
                minRows={1}
              />
            </div>
          )}

          <div className="flex items-center justify-between gap-6 rounded-lg bg-bg-soft px-3.5 py-3">
            <div className="min-w-0">
              <label htmlFor="modelcard-default" className="block text-small-size font-medium text-fg">
                Default model
              </label>
              <p className="mt-0.5 text-xs text-fg-muted">
                Agents created without a model use this one. Only one model is the default.
              </p>
            </div>
            <Switch
              id="modelcard-default"
              checked={form.is_default}
              onCheckedChange={(v) => setForm({ ...form, is_default: v })}
            />
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        destructive
        title={`Delete ${confirmDelete?.model_id ?? "model"}?`}
        body={`The model and its stored key are removed. ${(() => {
          const n = confirmDelete ? (usage.models.get(confirmDelete.model_id)?.length ?? 0) : 0;
          return n > 0 ? `${n} ${n === 1 ? "agent references" : "agents reference"} this model ID. ` : "";
        })()}This cannot be undone.`}
        confirmLabel="Delete model"
        onConfirm={async () => {
          if (!confirmDelete) return;
          await api(`/v1/model_cards/${confirmDelete.id}`, { method: "DELETE" });
          refresh();
        }}
      />
    </DataTable>
  );
}
