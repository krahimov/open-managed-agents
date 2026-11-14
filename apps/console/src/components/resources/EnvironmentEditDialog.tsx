import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PlusIcon, XIcon } from "lucide-react";

import { useApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { Callout } from "../Callout";
import { Field } from "../Field";
import { Modal } from "../Modal";
import { Select, SelectOption } from "../Select";
import { Tip } from "../Tip";
import {
  MANAGERS,
  SANDBOX_PROVIDERS,
  buildNetworking,
  buildSandboxConfig,
  metadataToRows,
  packagesToRows,
  rowsToMetadata,
  rowsToPackages,
  type EnvConfigBlock,
  type Environment,
  type Manager,
  type MetadataRow,
  type NetworkingConfig,
  type PackageRow,
  type SandboxConfig,
} from "./environment";
import { ChoiceCards, KeyValueRows, errorMessage } from "./ResourceBits";

export type EnvironmentEditTab = "details" | "sandbox" | "packages" | "network" | "metadata";

const NAME_MAX = 50;
const MONO = "font-mono text-small-size md:text-small-size";

/** A switch with its explanation: one setting inside the dialog. */
function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-small-size font-medium text-fg">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-fg-muted">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * Edit an environment. One dialog, one Save: the five tabs are views of
 * the same draft, and saving sends the whole record (PUT), exactly as
 * the original page did. Config fields the form does not model (memory
 * mounts, resources, a Dockerfile) are carried through untouched, and
 * legacy `gem` packages are preserved.
 *
 * `tab` picks the tab to open on, so each card's "Edit" lands on its own
 * section.
 */
export function EnvironmentEditDialog({
  env,
  open,
  tab: initialTab = "details",
  onClose,
  onSaved,
}: {
  env: Environment;
  open: boolean;
  tab?: EnvironmentEditTab;
  onClose: () => void;
  onSaved: (updated: Environment) => void;
}) {
  const { api } = useApi();
  const [tab, setTab] = useState<EnvironmentEditTab>(initialTab);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [networking, setNetworking] = useState<NetworkingConfig>({ type: "unrestricted" });
  const [allowedHostsText, setAllowedHostsText] = useState("");
  const [sandbox, setSandbox] = useState<SandboxConfig>({});
  const [bootstrapPackagesText, setBootstrapPackagesText] = useState("");
  const [maxFileBytesText, setMaxFileBytesText] = useState("");
  const [packageRows, setPackageRows] = useState<PackageRow[]>([]);
  const [metadataRows, setMetadataRows] = useState<MetadataRow[]>([]);

  // Seed the draft every time the dialog opens, so Cancel discards.
  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setError(null);
    setName(env.name);
    setDescription(env.description ?? "");
    const net: NetworkingConfig = env.config.networking ?? { type: "unrestricted" };
    setNetworking({
      type: net.type ?? "unrestricted",
      allow_mcp_servers: !!net.allow_mcp_servers,
      allow_package_managers: !!net.allow_package_managers,
      allowed_hosts: net.allowed_hosts ?? [],
    });
    setAllowedHostsText((net.allowed_hosts ?? []).join("\n"));
    const sb = env.config.sandbox ?? {};
    setSandbox(sb);
    setBootstrapPackagesText((sb.bootstrap_apt_packages ?? []).join(", "));
    setMaxFileBytesText(
      typeof sb.max_file_bytes === "number" && Number.isFinite(sb.max_file_bytes) ? String(sb.max_file_bytes) : "",
    );
    setPackageRows(packagesToRows(env.config.packages));
    setMetadataRows(metadataToRows(env.metadata));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, env.id]);

  const preservedGem = env.config.packages?.gem;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const config: EnvConfigBlock = {
        // Keep runtime fields the form does not edit (memory, resources, dockerfile).
        ...env.config,
        type: env.config.type,
        sandbox: buildSandboxConfig(sandbox, bootstrapPackagesText, maxFileBytesText),
        packages: rowsToPackages(packageRows, preservedGem),
        networking: buildNetworking(networking, allowedHostsText),
      };
      const updated = await api<Environment>(`/v1/environments/${env.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          config,
          // Not parsed by the PUT route yet; sent so the field is there once it is.
          metadata: rowsToMetadata(metadataRows),
        }),
        silentErrors: true,
      });
      toast.success("Environment saved");
      onSaved(updated);
      onClose();
    } catch (e) {
      setError(errorMessage(e, "The environment could not be saved"));
    } finally {
      setSaving(false);
    }
  };

  const setRow = (i: number, patch: Partial<PackageRow>) =>
    setPackageRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Modal
      open={open}
      onClose={() => !saving && onClose()}
      title="Edit environment"
      subtitle="Changes apply to sessions that start after you save."
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim()} loading={saving}>
            Save changes
          </Button>
        </>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as EnvironmentEditTab)} className="gap-5">
        <TabsList aria-label="Environment settings" className="w-full">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="sandbox">Sandbox</TabsTrigger>
          <TabsTrigger value="packages">Packages</TabsTrigger>
          <TabsTrigger value="network">Network</TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
        </TabsList>

        {error && <Callout tone="danger">{error}</Callout>}

        <TabsContent value="details" className="min-h-[340px] space-y-5">
          <Field label="Name" hint={`${name.length}/${NAME_MAX} characters`}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
              placeholder="Production sandbox"
              autoComplete="off"
            />
          </Field>
          <Field label="Description" hint="What this environment is for. Shown wherever someone picks an environment.">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="What is this environment for?"
            />
          </Field>
        </TabsContent>

        <TabsContent value="sandbox" className="min-h-[340px] space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Provider"
              hint={SANDBOX_PROVIDERS.find((p) => p.value === (sandbox.provider || "subprocess"))?.hint}
            >
              <Select
                value={sandbox.provider || "subprocess"}
                onValueChange={(v) => setSandbox((s) => ({ ...s, provider: v }))}
              >
                {SANDBOX_PROVIDERS.map((p) => (
                  <SelectOption key={p.value} value={p.value}>
                    {p.label}
                  </SelectOption>
                ))}
              </Select>
            </Field>
            <Field label="Image" hint="Container image the sandbox boots from.">
              <Input
                value={sandbox.image ?? ""}
                onChange={(e) => setSandbox((s) => ({ ...s, image: e.target.value }))}
                placeholder="node:22-bookworm"
                autoComplete="off"
                spellCheck={false}
                className={MONO}
              />
            </Field>
            <Field label="Working directory" hint="Where the agent starts. Defaults to /workspace.">
              <Input
                value={sandbox.workdir ?? ""}
                onChange={(e) => setSandbox((s) => ({ ...s, workdir: e.target.value }))}
                placeholder="/workspace"
                autoComplete="off"
                spellCheck={false}
                className={MONO}
              />
            </Field>
            <Field label="Largest file, in bytes" hint="Bigger files are skipped when files are synced in and out. Defaults to 536870912 (512 MB).">
              <Input
                type="number"
                min={1}
                value={maxFileBytesText}
                onChange={(e) => setMaxFileBytesText(e.target.value)}
                placeholder="536870912"
                className={MONO}
              />
            </Field>
          </div>
          <div className="divide-y divide-border rounded-lg bg-bg-soft px-3.5 py-3">
            <ToggleRow
              id="env-ephemeral"
              label="Ephemeral sandbox"
              description="Delete the sandbox as soon as it stops. Lasting state lives in the session, its outputs and memory stores."
              checked={sandbox.ephemeral ?? true}
              onChange={(v) => setSandbox((s) => ({ ...s, ephemeral: v }))}
            />
            <ToggleRow
              id="env-bootstrap-tools"
              label="Bootstrap coding tools"
              description="Install the apt packages below when the sandbox is created."
              checked={sandbox.bootstrap_tools ?? true}
              onChange={(v) => setSandbox((s) => ({ ...s, bootstrap_tools: v }))}
            />
          </div>
          <Field label="Bootstrap apt packages" hint="Separated by commas. Leave blank for the default set: Python, Git, curl, jq, ripgrep, build tools.">
            <Textarea
              value={bootstrapPackagesText}
              onChange={(e) => setBootstrapPackagesText(e.target.value)}
              rows={2}
              placeholder="python3, git, curl, jq, ripgrep"
              spellCheck={false}
              className={MONO}
            />
          </Field>
        </TabsContent>

        <TabsContent value="packages" className="min-h-[340px] space-y-4">
          <p className="text-small text-fg-muted">
            Installed when the sandbox is built. One row per package manager; separate packages with spaces and pin
            versions the way that manager does.
          </p>
          {packageRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-strong px-4 py-8 text-center">
              <p className="text-small-size font-medium text-fg">No packages</p>
              <p className="mt-0.5 text-xs text-fg-muted">The sandbox has only what its image ships with.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {packageRows.map((row, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="w-[104px] shrink-0">
                    <Select
                      value={row.manager}
                      onValueChange={(v) => setRow(i, { manager: v as Manager })}
                      aria-label={`Package manager, row ${i + 1}`}
                    >
                      {MANAGERS.map((m) => (
                        <SelectOption key={m} value={m}>
                          {m}
                        </SelectOption>
                      ))}
                    </Select>
                  </div>
                  <Textarea
                    value={row.packages}
                    onChange={(e) => setRow(i, { packages: e.target.value })}
                    placeholder={row.manager === "pip" ? "pandas numpy==2.0" : "package package@1.0.0"}
                    aria-label={`${row.manager} packages`}
                    rows={1}
                    spellCheck={false}
                    className={`min-h-9 flex-1 py-[7px] ${MONO}`}
                  />
                  <Tip label="Remove row">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${row.manager} row`}
                      onClick={() => setPackageRows((rows) => rows.filter((_, j) => j !== i))}
                    >
                      <XIcon />
                    </Button>
                  </Tip>
                </div>
              ))}
            </div>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2"
            onClick={() => setPackageRows((rows) => [...rows, { manager: "pip", packages: "" }])}
          >
            <PlusIcon data-icon="inline-start" />
            Add package manager
          </Button>
          {preservedGem && preservedGem.length > 0 && (
            <Callout tone="neutral">
              {preservedGem.length} legacy gem {preservedGem.length === 1 ? "package is" : "packages are"} kept as they
              are. They cannot be edited here because the base image has no Ruby yet.
            </Callout>
          )}
        </TabsContent>

        <TabsContent value="network" className="min-h-[340px] space-y-5">
          <div>
            <p className="mb-1.5 text-small leading-5 font-medium text-fg">Outbound access</p>
            <ChoiceCards<NetworkingConfig["type"]>
              label="Outbound access"
              value={networking.type}
              onChange={(type) => setNetworking({ ...networking, type })}
              options={[
                { value: "limited", label: "Limited", description: "Only the hosts you list can be reached." },
                { value: "unrestricted", label: "Unrestricted", description: "The sandbox can reach the open internet." },
              ]}
            />
          </div>
          {networking.type === "limited" && (
            <Field label="Allowed hosts" hint="One per line, or separated by commas.">
              <Textarea
                value={allowedHostsText}
                onChange={(e) => setAllowedHostsText(e.target.value)}
                rows={4}
                placeholder={"github.com\napi.github.com"}
                spellCheck={false}
                className={MONO}
              />
            </Field>
          )}
          <div className="divide-y divide-border rounded-lg bg-bg-soft px-3.5 py-3">
            <ToggleRow
              id="env-allow-mcp"
              label="Allow MCP server network access"
              description="Let the sandbox reach the MCP servers attached to an agent."
              checked={!!networking.allow_mcp_servers}
              onChange={(v) => setNetworking({ ...networking, allow_mcp_servers: v })}
            />
            <ToggleRow
              id="env-allow-pm"
              label="Allow package manager network access"
              description="Let the sandbox reach package registries, so installs work at run time."
              checked={!!networking.allow_package_managers}
              onChange={(v) => setNetworking({ ...networking, allow_package_managers: v })}
            />
          </div>
        </TabsContent>

        <TabsContent value="metadata" className="min-h-[340px] space-y-4">
          <p className="text-small text-fg-muted">
            Your own labels for this environment: a team, a cost centre, anything you filter by elsewhere.
          </p>
          <KeyValueRows
            rows={metadataRows}
            onChange={setMetadataRows}
            keyPlaceholder="team"
            valuePlaceholder="Value"
            addLabel="Add metadata"
            noun="metadata entry"
          />
        </TabsContent>
      </Tabs>
    </Modal>
  );
}
