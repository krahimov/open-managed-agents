import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { IntegrationsApi } from "../api/client";
import type { LinearPublicationInstallLink, LinearPublicationShell } from "../api/types";
import {
  AgentPersonaFields,
  CancelLink,
  ExternalButton,
  InstallResult,
  PersonaPreview,
  PublishingSummary,
  ResumingCard,
  WizardCard,
  WizardFooter,
  WizardPage,
  wizardCode,
} from "../components/Wizard";
import { Callout } from "../../components/Callout";
import { Disclosure } from "../../components/Disclosure";
import { Field } from "../../components/Field";
import { SecretInput, TextInput } from "../../components/Input";
import { CopyList, CopyRow } from "../../components/settings/CopyField";
import { BRAND_NAME } from "../../lib/brand";
import { failureSentence } from "../../lib/failure-text";

const api = new IntegrationsApi();

interface AgentOption {
  id: string;
  name: string;
}

interface EnvironmentOption {
  id: string;
  name: string;
}

interface PublishWizardProps {
  loadAgents: () => Promise<AgentOption[]>;
  loadEnvironments: () => Promise<EnvironmentOption[]>;
}

type Step = "pick" | "credentials" | "install";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "pick", label: "Choose agent" },
  { id: "credentials", label: "Create the app" },
  { id: "install", label: "Install" },
];

/**
 * Publication-first wizard. Three discrete steps, each touching exactly
 * one anchor row server-side:
 *
 *   1. POST  /v1/integrations/linear/publications      → creates pending pub
 *   2. PATCH /v1/integrations/linear/publications/:id/credentials
 *                                                       → fills + advances
 *   3. <a href={install_url}>                           → OAuth callback
 *                                                         binds installation
 *
 * If the user closes the tab mid-flow, the pub stays in pending_setup /
 * awaiting_install and the wizard can resume from `?pub=...` (re-using the
 * same callback URL they already pasted into Linear).
 */
export function IntegrationsLinearPublishWizard({ loadAgents, loadEnvironments }: PublishWizardProps) {
  const [search, setSearch] = useSearchParams();
  const preselectedAgent = search.get("agent_id") ?? "";
  const resumePubId = search.get("pub");

  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [envs, setEnvs] = useState<EnvironmentOption[]>([]);
  const [agentId, setAgentId] = useState(preselectedAgent);
  const [envId, setEnvId] = useState("");
  const [personaName, setPersonaName] = useState("");
  const [personaAvatar, setPersonaAvatar] = useState("");

  const [step, setStep] = useState<Step>("pick");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while we hydrate from `?pub=`; suppresses the empty pick step.
  const [hydrating, setHydrating] = useState<boolean>(Boolean(resumePubId));

  const [shell, setShell] = useState<LinearPublicationShell | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [installLink, setInstallLink] = useState<LinearPublicationInstallLink | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [a, e] = await Promise.all([loadAgents(), loadEnvironments()]);
        setAgents(a);
        setEnvs(e);
      } catch (err) {
        setError(failureSentence(err));
      }
    })();
  }, [loadAgents, loadEnvironments]);

  // Refresh-resume hydration. When the wizard renders with `?pub=<id>` set
  // by replaceState below or the pending-pub list page, re-derive the shell
  // payload and pre-fill the form. Linear keys directly off the publicationId
  // (no formToken JWT), so this is just a re-fetch of the existing row plus
  // a re-build of the callback/webhook URLs.
  useEffect(() => {
    if (!resumePubId) return;
    let cancelled = false;
    void (async () => {
      try {
        const pub = await api.linear.getPublication(resumePubId);
        if (cancelled) return;
        if (pub.status === "live") {
          window.location.href = "/integrations/linear";
          return;
        }
        if (pub.status === "unpublished" || pub.status === "needs_reauth") {
          search.delete("pub");
          setSearch(search, { replace: true });
          setHydrating(false);
          return;
        }
        const re = await api.linear.reissueFormToken(resumePubId);
        if (cancelled) return;
        setShell(re);
        setAgentId(pub.agent_id);
        setEnvId(pub.environment_id);
        // The saved persona wins over the "default to the agent's name" effect.
        personaEditedRef.current = true;
        setPersonaName(pub.persona.name);
        if (pub.persona.avatarUrl) setPersonaAvatar(pub.persona.avatarUrl);
        // Always render the credentials step on resume so the user can
        // re-paste; the install link is re-issued by submitCredentials.
        setStep("credentials");
      } catch (err) {
        if (!cancelled) {
          search.delete("pub");
          setSearch(search, { replace: true });
          setError(failureSentence(err));
        }
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Resume runs once per wizard mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default persona name to the chosen agent's name. Skip once the user has
  // edited the field — otherwise clearing the input would refill it from the
  // effect's personaName dep, making the field feel un-clearable.
  const personaEditedRef = useRef(false);
  useEffect(() => {
    if (personaEditedRef.current) return;
    if (agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (agent) setPersonaName(agent.name);
    }
  }, [agentId, agents]);

  const returnUrl = `${window.location.origin}/integrations/linear`;

  /** Stamp ?pub=<id> into the URL so a refresh resumes the wizard. */
  function pinPublicationToUrl(publicationId: string) {
    const url = new URL(window.location.href);
    if (url.searchParams.get("pub") === publicationId) return;
    url.searchParams.set("pub", publicationId);
    window.history.replaceState({}, "", url.toString());
  }

  async function startPublish() {
    if (!agentId || !envId || !personaName) {
      setError("Choose an agent, an environment and a persona name first.");
      return;
    }
    setError(null);
    setWorking(true);
    try {
      const s = await api.linear.createPublication({
        agentId,
        environmentId: envId,
        personaName,
        personaAvatarUrl: personaAvatar || null,
        returnUrl,
      });
      setShell(s);
      setStep("credentials");
      pinPublicationToUrl(s.publication_id);
    } catch (err) {
      setError(failureSentence(err));
    } finally {
      setWorking(false);
    }
  }

  async function submitCredentials() {
    if (!shell || !clientId || !clientSecret || !webhookSecret) return;
    setError(null);
    setWorking(true);
    try {
      const link = await api.linear.submitCredentialsForPublication(shell.publication_id, {
        clientId,
        clientSecret,
        webhookSecret,
        returnUrl,
      });
      setInstallLink(link);
      setStep("install");
      pinPublicationToUrl(link.publication_id);
    } catch (err) {
      setError(failureSentence(err));
    } finally {
      setWorking(false);
    }
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const agentName = agents.find((a) => a.id === agentId)?.name ?? "";
  const envName = envs.find((e) => e.id === envId)?.name ?? "";

  return (
    <WizardPage
      provider="linear"
      title="Publish an agent to Linear"
      subtitle="Make an agent a teammate in Linear: in the assignee menu and in @mentions."
      steps={STEPS.map((s) => s.label)}
      current={stepIndex}
      banner={
        <>
          <InstallResult provider="linear" params={search} />
          {error && (
            <Callout tone="danger" title="That did not go through">
              {error}
            </Callout>
          )}
        </>
      }
    >
      {hydrating && <ResumingCard />}

      {!hydrating && step === "pick" && (
        <WizardCard
          title="Choose the agent"
          description="Which agent to publish, where its sessions run, and how it appears in Linear."
          footer={
            <WizardFooter
              hint="About three minutes. You need to be a Linear admin."
              back={<CancelLink provider="linear" disabled={working} />}
            >
              <Button onClick={() => void startPublish()} loading={working} disabled={!agentId || !envId || !personaName.trim()}>
                Continue
                <ArrowRightIcon data-icon="inline-end" />
              </Button>
            </WizardFooter>
          }
        >
          <div className="space-y-5">
            <AgentPersonaFields
              provider="linear"
              agentId={agentId}
              onAgent={setAgentId}
              envId={envId}
              onEnv={setEnvId}
              personaName={personaName}
              onPersonaName={(v) => {
                personaEditedRef.current = true;
                setPersonaName(v);
              }}
              personaAvatar={personaAvatar}
              onPersonaAvatar={setPersonaAvatar}
              disabled={working}
            />
            <PersonaPreview
              provider="linear"
              name={personaName}
              avatarUrl={personaAvatar}
              agentId={agentId || undefined}
              caption="Shows in the assignee menu, autocompletes in @mentions, posts its progress on the issue."
            />
          </div>
        </WizardCard>
      )}

      {!hydrating && step === "credentials" && shell && (
        <>
          <PublishingSummary personaName={personaName} avatarUrl={personaAvatar} agentId={agentId} agentName={agentName} envName={envName} />

          <WizardCard
            title="Create a Linear OAuth app"
            description="In Linear, register a new application and copy these values into its form."
          >
            <div className="space-y-4">
              <ExternalButton href="https://linear.app/settings/api/applications/new">Open Linear's new application form</ExternalButton>
              <CopyList>
                <CopyRow label="Application name" value={shell.suggested_app_name} />
                <CopyRow label="Developer name" value={shell.suggested_app_name} />
                <CopyRow label="Developer URL" value={window.location.origin} />
                <CopyRow label="Description" value={`${BRAND_NAME}-managed agent: ${shell.suggested_app_name}.`} />
                <CopyRow label="Callback URLs" value={shell.callback_url} />
                <CopyRow label="Webhook URL" value={shell.webhook_url} />
              </CopyList>
              <div>
                <p className="mb-2 text-xs font-medium text-fg-subtle">Set the rest of the form like this</p>
                <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border text-small">
                  <FormSetting name="Webhooks" value="On">
                    Paste the webhook URL and subscribe to <code className={wizardCode}>App user notifications</code> and{" "}
                    <code className={wizardCode}>Agent session events</code>. Linear shows the signing secret once you save.
                  </FormSetting>
                  <FormSetting name="Public" value="Off">
                    Public is for marketplace listings. This app is private to your workspace.
                  </FormSetting>
                  <FormSetting name="Client credentials" value="Off">
                    {BRAND_NAME} uses the standard authorization-code flow.
                  </FormSetting>
                  <FormSetting name="GitHub username" value="Empty">
                    Only used when the app is also bound to a GitHub App.
                  </FormSetting>
                </dl>
              </div>
            </div>
          </WizardCard>

          <WizardCard
            title="Paste its credentials"
            description="From the application you just created. The webhook signing secret is on the same page, under Webhooks."
            footer={
              <WizardFooter hint="Secrets are stored encrypted and never shown again.">
                <Button
                  onClick={() => void submitCredentials()}
                  loading={working}
                  disabled={!clientId || !clientSecret || !webhookSecret}
                >
                  Continue
                  <ArrowRightIcon data-icon="inline-end" />
                </Button>
              </WizardFooter>
            }
          >
            <div className="space-y-5">
              <Field label="Client ID">
                <TextInput value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono" disabled={working} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Client secret">
                  <SecretInput value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} disabled={working} />
                </Field>
                <Field label="Webhook signing secret" hint="Starts with lin_wh_">
                  <SecretInput
                    value={webhookSecret}
                    onChange={(e) => setWebhookSecret(e.target.value)}
                    placeholder="lin_wh_"
                    disabled={working}
                  />
                </Field>
              </div>
            </div>
          </WizardCard>
        </>
      )}

      {!hydrating && step === "install" && installLink && (
        <WizardCard
          title="Install the app in your workspace"
          description="Your credentials are stored. Approve the install in Linear and you are brought straight back here."
          footer={
            <WizardFooter hint="Installing needs a Linear admin.">
              <Button asChild>
                <a href={installLink.install_url}>
                  Install in Linear
                  <ArrowRightIcon data-icon="inline-end" />
                </a>
              </Button>
            </WizardFooter>
          }
        >
          <div className="space-y-4">
            <PublishingSummary personaName={personaName} avatarUrl={personaAvatar} agentId={agentId} agentName={agentName} envName={envName} />
            <Disclosure title="Check the URLs Linear should now show">
              <CopyList>
                <CopyRow label="Callback URL" value={installLink.callback_url} />
                <CopyRow label="Webhook URL" value={installLink.webhook_url} />
              </CopyList>
            </Disclosure>
          </div>
        </WizardCard>
      )}
    </WizardPage>
  );
}

/** One switch on Linear's form: what to set it to, and why. */
function FormSetting({ name, value, children }: { name: string; value: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 px-3.5 py-2.5">
      <dt className="w-32 shrink-0 sm:w-40">
        <span className="block font-medium text-fg">{name}</span>
        <span className="text-xs text-fg-subtle">{value}</span>
      </dt>
      <dd className="min-w-0 flex-1 text-fg-muted">{children}</dd>
    </div>
  );
}
