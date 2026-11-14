import { useState } from "react";
import { Link } from "react-router";
import { BoxIcon, RefreshCwIcon } from "lucide-react";

import { VaultIcon } from "@/components/icons";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";

import { CheckRow, FormSection, GroupLabel, PickSelect, RowBox } from "../../../components/agents/controls";
import { TriggerFields, type TriggerRuleDraft } from "../../../components/agents/TriggerFields";
import { Disclosure } from "../../../components/Disclosure";
import { Callout, EmptyState, EntityAvatar, Field, StatusBadge } from "../../../components/kit";
import {
  providerLabel,
  uniqueStrings,
  type EnvironmentLite,
  type FormSetter,
  type FormState,
  type SandboxConfig,
  type SandboxStorageCheck,
  type VaultLite,
} from "./model";

// ── Sandbox ──────────────────────────────────────────────────────────────

const NETWORK_LABEL: Record<string, string> = {
  unrestricted: "Unrestricted",
  limited: "Limited to allowed hosts",
  none: "No network",
  default: "Default",
};

export function SandboxSection({
  form,
  setForm,
  environments,
  sandboxConfig,
}: {
  form: FormState;
  setForm: FormSetter;
  environments: EnvironmentLite[];
  sandboxConfig: SandboxConfig | null;
}) {
  const { api } = useApi();
  const selected = environments.find((env) => env.id === form.environmentId);
  const provider = sandboxConfig?.provider ?? "subprocess";
  const [checkingStorage, setCheckingStorage] = useState(false);
  const [storageCheck, setStorageCheck] = useState<SandboxStorageCheck | null>(null);
  const storageOk = storageCheck?.ok ?? sandboxConfig?.memory_s3_configured ?? false;
  const storageMessage = storageCheck
    ? storageCheck.ok
      ? `Verified in ${storageCheck.checks.s3_write_read_delete.duration_ms ?? 0} ms`
      : (storageCheck.checks.s3_write_read_delete.error ?? "The storage check failed")
    : sandboxConfig?.memory_s3_configured
      ? "Configured, not verified yet"
      : "Not configured. Files in a remote sandbox will not outlive it.";
  const runStorageCheck = async () => {
    setCheckingStorage(true);
    try {
      const result = await api<SandboxStorageCheck>("/v1/sandbox/storage-check", { method: "POST", body: "{}" });
      setStorageCheck(result);
      if (result.ok) {
        toast.success("Remote sandbox storage verified.");
      } else {
        toast.warning(result.checks.s3_write_read_delete.error ?? "Remote storage check failed.");
      }
    } catch {
      // useApi already surfaced the API error.
    } finally {
      setCheckingStorage(false);
    }
  };
  const net = selected?.config?.networking;

  return (
    <FormSection
      title="Sandbox"
      description="The environment new sessions start in: the machine image, packages and network rules."
      action={
        <Button variant="ghost" size="sm" asChild>
          <Link to="/environments">Manage environments</Link>
        </Button>
      }
    >
      {environments.length === 0 ? (
        <EmptyState
          variant="plain"
          size="sm"
          kind="env"
          title="No environments yet"
          body="Sessions will ask for an environment each time until this agent has a default."
          className="rounded-lg border border-dashed border-border-strong"
        />
      ) : (
        <Field label="Default environment">
          <PickSelect
            value={form.environmentId}
            onValueChange={(environmentId) => setForm({ ...form, environmentId })}
            placeholder="Choose an environment"
            options={environments.map((env) => ({
              value: env.id,
              label: env.name,
              hint: env.description ?? undefined,
              icon: BoxIcon,
            }))}
          />
        </Field>
      )}

      {selected && (
        <dl className="grid gap-x-6 gap-y-3 rounded-lg bg-bg-soft px-4 py-3.5 text-small sm:grid-cols-3">
          <div>
            <dt className="text-xs text-fg-subtle">Network</dt>
            <dd className="mt-0.5 font-medium text-fg">{NETWORK_LABEL[net?.type ?? "default"] ?? net?.type}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">MCP servers</dt>
            <dd className="mt-0.5 font-medium text-fg">{net?.allow_mcp_servers === false ? "Blocked" : "Allowed"}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Package managers</dt>
            <dd className="mt-0.5 font-medium text-fg">{net?.allow_package_managers === false ? "Blocked" : "Allowed"}</dd>
          </div>
        </dl>
      )}

      <div>
        <GroupLabel>This workspace's sandbox provider</GroupLabel>
        <RowBox>
          <div className="grid gap-x-6 gap-y-3 px-3.5 py-3 text-small sm:grid-cols-2">
            <div>
              <div className="text-xs text-fg-subtle">Provider</div>
              <div className="mt-0.5 font-medium text-fg">{providerLabel(provider)}</div>
            </div>
            <div className="min-w-0">
              <div className="text-xs text-fg-subtle">Image</div>
              <div className={cn("mt-0.5 truncate text-fg", sandboxConfig?.image ? "font-mono text-xs leading-5" : "font-medium")} title={sandboxConfig?.image ?? undefined}>
                {sandboxConfig?.image || "Provider default"}
              </div>
            </div>
          </div>
          <div className="flex items-start justify-between gap-4 border-t border-border px-3.5 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className="text-small-size font-medium text-fg">Persistent storage</span>
                <StatusBadge status={storageOk ? "ready" : "disabled"} label={storageOk ? "Ready" : "Not ready"} />
              </div>
              <p className="mt-0.5 text-xs text-fg-muted">{storageMessage}</p>
              {(sandboxConfig?.memory_s3_endpoint_host || sandboxConfig?.memory_s3_bucket) && (
                <p className="mt-1 font-mono text-xs break-all text-fg-subtle">
                  {sandboxConfig.memory_s3_bucket ?? "bucket not set"}
                  {sandboxConfig.memory_s3_endpoint_host ? ` @ ${sandboxConfig.memory_s3_endpoint_host}` : ""}
                  {sandboxConfig.memory_s3_region ? ` (${sandboxConfig.memory_s3_region})` : ""}
                </p>
              )}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void runStorageCheck()} disabled={checkingStorage} className="shrink-0">
              <RefreshCwIcon data-icon="inline-start" className={checkingStorage ? "animate-spin" : undefined} />
              {checkingStorage ? "Checking" : "Check storage"}
            </Button>
          </div>
        </RowBox>
      </div>

      {provider === "daytona" && !sandboxConfig?.daytona_api_key_configured && (
        <Callout tone="danger" title="Daytona is not connected">
          <code className="font-mono text-xs">DAYTONA_API_KEY</code> is not configured on this deployment, so sandboxes
          cannot start.
        </Callout>
      )}
    </FormSection>
  );
}

// ── Vaults ───────────────────────────────────────────────────────────────

export function VaultsSection({
  form,
  setForm,
  vaults,
}: {
  form: FormState;
  setForm: FormSetter;
  vaults: VaultLite[];
}) {
  const selectedVaults = new Set(form.defaultVaultIds);
  const setVaultIds = (ids: string[]) => {
    setForm({ ...form, defaultVaultIds: uniqueStrings(ids.map((id) => id.trim())) });
  };
  const toggleVault = (vaultId: string) => {
    setVaultIds(
      selectedVaults.has(vaultId)
        ? form.defaultVaultIds.filter((id) => id !== vaultId)
        : [...form.defaultVaultIds, vaultId],
    );
  };
  const listed = new Set(vaults.map((v) => v.id));
  const unlisted = form.defaultVaultIds.filter((id) => !listed.has(id));

  return (
    <FormSection
      title="Vaults"
      description="Credentials the agent can use. The vaults you select are attached to every new session."
      action={
        <Button variant="ghost" size="sm" asChild>
          <Link to="/vaults">Manage vaults</Link>
        </Button>
      }
    >
      {vaults.length === 0 ? (
        <EmptyState
          variant="plain"
          size="sm"
          kind="vault"
          title="No vaults yet"
          body="Create a vault to give agents API keys and app sign-ins without pasting secrets into prompts."
          className="rounded-lg border border-dashed border-border-strong"
        />
      ) : (
        <RowBox>
          {vaults.map((vault) => (
            <CheckRow
              key={vault.id}
              checked={selectedVaults.has(vault.id)}
              onCheckedChange={() => toggleVault(vault.id)}
              leading={<EntityAvatar icon={VaultIcon} size="sm" />}
              title={vault.name}
              trailing={selectedVaults.has(vault.id) ? <span className="text-xs text-fg-subtle">Attached</span> : undefined}
            />
          ))}
        </RowBox>
      )}

      <Disclosure
        title="Attach a vault by id"
        meta={unlisted.length > 0 ? `${unlisted.length} added` : undefined}
        defaultOpen={unlisted.length > 0}
      >
        <Field label="Vault ids" hint="Only for vaults that are not in the list above. Separate ids with commas.">
          <Input
            value={form.defaultVaultIds.join(", ")}
            onChange={(e) => setVaultIds(e.target.value.split(/[,\s]+/))}
            placeholder="vlt-…"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
      </Disclosure>
    </FormSection>
  );
}

// ── Triggers (the agent's first ambient rule) ────────────────────────────

/** The trigger fields the form keeps flat, as the shared draft shape. */
export function formToTriggerDraft(form: FormState): TriggerRuleDraft {
  return {
    name: form.ambientRuleName,
    description: form.ambientRuleDescription,
    enabled: form.ambientRuleActive,
    trigger: form.ambientTrigger,
    wakeMode: form.ambientWakeMode,
    decisionPreset: form.ambientDecisionPreset,
    budgetPreset: form.ambientBudgetPreset,
    nextWakeAt: form.ambientNextWakeAt,
  };
}

export function TriggersSection({ form, setForm }: { form: FormState; setForm: FormSetter }) {
  return (
    <FormSection
      title="Triggers"
      description="Let the agent start on its own: on a schedule, or when something happens in a connected app. You can add more later on its page."
    >
      <RowBox>
        <div className="flex items-center justify-between gap-6 px-3.5 py-3">
          <div className="min-w-0">
            <label htmlFor="agent-ambient-enabled" className="block text-small-size font-medium text-fg">
              Create a trigger with this agent
            </label>
            <p className="mt-0.5 text-xs text-fg-muted">Each time it fires, the agent starts a fresh session.</p>
          </div>
          <Switch
            id="agent-ambient-enabled"
            checked={form.ambientEnabled}
            onCheckedChange={(checked) => setForm({ ...form, ambientEnabled: checked })}
          />
        </div>
      </RowBox>

      {form.ambientEnabled && (
        <div className="animate-fade-in">
          <TriggerFields
            value={formToTriggerDraft(form)}
            namePlaceholder={`${form.name.trim() || "Agent"} heartbeat`}
            onChange={(draft) =>
              setForm({
                ...form,
                ambientRuleName: draft.name,
                ambientRuleDescription: draft.description,
                ambientRuleActive: draft.enabled,
                ambientTrigger: draft.trigger,
                ambientWakeMode: draft.wakeMode,
                ambientDecisionPreset: draft.decisionPreset,
                ambientBudgetPreset: draft.budgetPreset,
                ambientNextWakeAt: draft.nextWakeAt,
              })
            }
          />
        </div>
      )}
    </FormSection>
  );
}
