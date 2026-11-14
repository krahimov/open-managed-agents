import type { ReactNode } from "react";
import { Link } from "react-router";
import { ExternalLinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { inlineLink } from "@/lib/links";

import { AgentAvatar } from "../../components/AgentAvatar";
import { Chip } from "../../components/Badge";
import { BrandLoader } from "../../components/BrandLoader";
import { Combobox } from "../../components/Combobox";
import { DetailHeader } from "../../components/DetailHeader";
import { Field } from "../../components/Field";
import { TextInput } from "../../components/Input";
import { Page } from "../../components/Page";
import { Steps } from "../../components/Steps";
import { PersonaAvatar } from "./IntegrationList";
export { InstallResult } from "./InstallResult";
import { PROVIDERS, ProviderMark, type ProviderId } from "./providers";

/**
 * The publish / bind wizards for Slack, GitHub and Linear share one frame:
 * a narrow page, the provider's mark and a plain-language title, the step
 * indicator, then one card per decision with Back and Continue at the
 * bottom right. State is kept when moving between steps.
 *
 *   <WizardPage provider="slack" title="Publish an agent to Slack" subtitle="…" steps={[…]} current={1}>
 *     <WizardCard title="Paste its credentials" description="…"
 *                 footer={<WizardFooter back={<Button variant="ghost">Back</Button>}><Button>Continue</Button></WizardFooter>}>
 *       …fields…
 *     </WizardCard>
 *   </WizardPage>
 */
export function WizardPage({
  provider,
  title,
  subtitle,
  steps,
  current,
  onStepClick,
  banner,
  children,
}: {
  provider: ProviderId;
  title: string;
  subtitle: string;
  /** Omit for a single-form page (no progress to show). */
  steps?: string[];
  current?: number;
  onStepClick?: (index: number) => void;
  /** Notices above the step card: resume, install result, errors. */
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Page width="narrow">
      <DetailHeader avatar={<ProviderMark provider={provider} size="xl" />} title={title} description={subtitle} />
      {steps && <Steps steps={steps} current={current ?? 0} onStepClick={onStepClick} className="mb-5 flex-wrap gap-y-2" />}
      <div className="space-y-4">
        {banner}
        {children}
      </div>
    </Page>
  );
}

export function WizardCard({
  title,
  description,
  children,
  footer,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("surface animate-rise-in overflow-hidden rounded-xl", className)}>
      <div className="p-6">
        {title && <h2 className="text-h2 text-fg">{title}</h2>}
        {description && <p className="mt-1 text-small text-fg-muted">{description}</p>}
        <div className={cn((title || description) && "mt-5")}>{children}</div>
      </div>
      {footer}
    </section>
  );
}

/** The card's action row: a quiet hint on the left, Back and the primary on the right. */
export function WizardFooter({ hint, back, children }: { hint?: ReactNode; back?: ReactNode; children?: ReactNode }) {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg-inset/60 px-6 py-4">
      <p className="min-w-0 text-xs text-fg-subtle">{hint}</p>
      <div className="flex shrink-0 items-center gap-2">
        {back}
        {children}
      </div>
    </footer>
  );
}

/** A link that leaves the console, drawn as a button. */
export function ExternalButton({
  href,
  children,
  variant = "outline",
  size = "default",
  target = "_blank",
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm" | "lg";
  /** Window name. Defaults to a new tab. */
  target?: string;
  className?: string;
}) {
  return (
    <Button variant={variant} size={size} asChild className={className}>
      <a href={href} target={target} rel="noreferrer">
        {children}
        <ExternalLinkIcon data-icon="inline-end" />
      </a>
    </Button>
  );
}

export const wizardLink = inlineLink;
export const wizardCode = "rounded-sm bg-bg-soft px-1 py-0.5 font-mono text-xs text-fg";

// ── Step one, shared: which agent, where it runs, how it appears ─────────

interface AgentOption {
  id: string;
  name: string;
  _oma?: { default_environment_id?: string | null };
  metadata?: { default_environment_id?: unknown };
}

/**
 * Agent, environment and persona fields. Choosing an agent fills the
 * environment with the agent's default (when it has one and none is chosen
 * yet), so the common case is one pick.
 */
export function AgentPersonaFields({
  provider,
  agentId,
  onAgent,
  envId,
  onEnv,
  personaName,
  onPersonaName,
  personaAvatar,
  onPersonaAvatar,
  personaLabel = "Persona name",
  personaHint,
  disabled,
}: {
  provider: ProviderId;
  agentId: string;
  onAgent: (id: string) => void;
  envId: string;
  onEnv: (id: string) => void;
  personaName: string;
  onPersonaName: (v: string) => void;
  /** Omit both to hide the avatar field (GitHub, Linear API key install). */
  personaAvatar?: string;
  onPersonaAvatar?: (v: string) => void;
  personaLabel?: string;
  personaHint?: ReactNode;
  disabled?: boolean;
}) {
  const meta = PROVIDERS[provider];
  const withAvatar = onPersonaAvatar !== undefined;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Agent">
          <Combobox<AgentOption>
            value={agentId}
            onValueChange={(v, item) => {
              onAgent(v);
              const fallback = item?._oma?.default_environment_id ?? item?.metadata?.default_environment_id;
              if (!envId && typeof fallback === "string" && fallback) onEnv(fallback);
            }}
            endpoint="/v1/agents"
            getValue={(a) => a.id}
            getLabel={(a) => (
              <span className="flex min-w-0 items-center gap-2">
                <AgentAvatar name={a.name} id={a.id} size="xs" />
                <span className="truncate">{a.name}</span>
              </span>
            )}
            getTextLabel={(a) => a.name}
            placeholder="Choose an agent"
            disabled={disabled}
          />
        </Field>
        <Field label="Environment">
          <Combobox<{ id: string; name: string }>
            value={envId}
            onValueChange={(v) => onEnv(v)}
            endpoint="/v1/environments"
            getValue={(e) => e.id}
            getLabel={(e) => <span className="truncate">{e.name}</span>}
            getTextLabel={(e) => e.name}
            placeholder="Choose an environment"
            disabled={disabled}
          />
        </Field>
      </div>

      <div className={cn("grid gap-4", withAvatar && "sm:grid-cols-2")}>
        <Field label={personaLabel} hint={personaHint ?? `The name people see in ${meta.name}. Defaults to the agent's name.`}>
          <TextInput
            value={personaName}
            onChange={(e) => onPersonaName(e.target.value)}
            placeholder="Triage, Coder, Release notes"
            disabled={disabled}
          />
        </Field>
        {withAvatar && (
          <Field label="Avatar URL (optional)" hint="A square image works best.">
            <TextInput
              value={personaAvatar ?? ""}
              onChange={(e) => onPersonaAvatar?.(e.target.value)}
              placeholder="https://"
              disabled={disabled}
            />
          </Field>
        )}
      </div>
    </div>
  );
}

/** How the agent will look on the other product, updated as the fields change. */
export function PersonaPreview({
  provider,
  name,
  avatarUrl,
  agentId,
  caption,
}: {
  provider: ProviderId;
  name: string;
  avatarUrl?: string | null;
  agentId?: string;
  caption: ReactNode;
}) {
  const meta = PROVIDERS[provider];
  const shown = name.trim() || "Your agent";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-inset px-3.5 py-3">
      <PersonaAvatar persona={{ name: shown, avatarUrl: avatarUrl?.trim() || null }} agentId={agentId} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2">
          <span className={cn("truncate text-sm font-semibold", name.trim() ? "text-fg" : "text-fg-subtle")}>{shown}</span>
          <Chip>{provider === "github" ? "Bot" : "App"}</Chip>
        </p>
        <p className="truncate text-xs text-fg-subtle">{caption}</p>
      </div>
      <span className="hidden shrink-0 items-center gap-1.5 text-xs text-fg-subtle sm:flex">
        <meta.icon className="size-3.5" />
        Preview in {meta.name}
      </span>
    </div>
  );
}

/** "Publishing X as Y in Z" with a way back to step one. */
export function PublishingSummary({
  personaName,
  avatarUrl,
  agentId,
  agentName,
  envName,
  onChange,
  disabled,
}: {
  personaName: string;
  avatarUrl?: string | null;
  agentId?: string;
  agentName: string;
  envName: string;
  onChange?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-bg-soft py-2 pr-2 pl-3.5">
      <PersonaAvatar persona={{ name: personaName || agentName, avatarUrl: avatarUrl || null }} agentId={agentId} size="sm" />
      <p className="min-w-0 flex-1 truncate text-small text-fg-muted">
        Publishing <span className="font-medium text-fg">{personaName || agentName}</span>
        {agentName && agentName !== personaName && <> for agent {agentName}</>}
        {envName && <>, running in {envName}</>}
      </p>
      {onChange && (
        <Button variant="ghost" size="xs" onClick={onChange} disabled={disabled}>
          Change
        </Button>
      )}
    </div>
  );
}

/** Shown while a half-finished install is being picked up again. */
export function ResumingCard() {
  return (
    <WizardCard>
      <div className="flex items-center gap-3 text-small text-fg-muted">
        <BrandLoader label="Resuming" />
        Picking up where the install stopped
      </div>
    </WizardCard>
  );
}

/** "Cancel" back to the provider's list page. */
export function CancelLink({ provider, disabled }: { provider: ProviderId; disabled?: boolean }) {
  if (disabled) {
    return (
      <Button variant="ghost" disabled>
        Cancel
      </Button>
    );
  }
  return (
    <Button variant="ghost" asChild>
      <Link to={PROVIDERS[provider].listPath}>Cancel</Link>
    </Button>
  );
}
