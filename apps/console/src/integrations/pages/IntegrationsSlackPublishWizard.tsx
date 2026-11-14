import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { IntegrationsApi } from "../api/client";
import type { A1FormStep, A1InstallLink } from "../api/types";
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
  wizardLink,
} from "../components/Wizard";
import { Callout } from "../../components/Callout";
import { Disclosure } from "../../components/Disclosure";
import { Field } from "../../components/Field";
import { SecretInput, TextInput } from "../../components/Input";
import { CopyList, CopyRow } from "../../components/settings/CopyField";
import { failureSentence } from "../../lib/failure-text";

const api = new IntegrationsApi();

interface AgentOption {
  id: string;
  name: string;
  created_at?: string;
}

interface EnvironmentOption {
  id: string;
  name: string;
  created_at?: string;
}

interface PublishWizardProps {
  loadAgents: () => Promise<AgentOption[]>;
  loadEnvironments: () => Promise<EnvironmentOption[]>;
}

type Step = "pick" | "a1-credentials" | "a1-install";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "pick", label: "Choose agent" },
  { id: "a1-credentials", label: "Create the app" },
  { id: "a1-install", label: "Install" },
];

const BOT_EVENTS = ["app_mention", "message.channels", "message.im", "message.groups", "message.mpim", "tokens_revoked", "app_uninstalled"];

export function IntegrationsSlackPublishWizard({ loadAgents, loadEnvironments }: PublishWizardProps) {
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
  // True while we hydrate from `?pub=` so we don't render the (empty) "pick"
  // step while we're still resolving the existing publication's state.
  const [hydrating, setHydrating] = useState<boolean>(Boolean(resumePubId));

  const [a1Form, setA1Form] = useState<A1FormStep | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [a1InstallLink, setA1InstallLink] = useState<A1InstallLink | null>(null);

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

  // Refresh-resume hydration. When the user lands with `?pub=<id>` (set by
  // a previous wizard run via replaceState) we re-issue a fresh formToken
  // server-side and re-derive the wizard step from the publication's
  // current status. Server is the source of truth — no sessionStorage.
  useEffect(() => {
    if (!resumePubId) return;
    let cancelled = false;
    void (async () => {
      try {
        const pub = await api.slack.getPublication(resumePubId);
        if (cancelled) return;
        // Already-live pubs belong on the list page, not the wizard.
        if (pub.status === "live") {
          window.location.href = "/integrations/slack";
          return;
        }
        if (pub.status === "unpublished" || pub.status === "needs_reauth") {
          // Drop the bad ?pub= so the wizard re-renders fresh.
          search.delete("pub");
          setSearch(search, { replace: true });
          setHydrating(false);
          return;
        }
        // Re-issue a fresh formToken for the existing shell. Server validates
        // ownership; we only re-render the wizard here.
        const form = await api.slack.reissueFormToken(resumePubId, returnUrl);
        if (cancelled) return;
        setA1Form(form);
        setAgentId(pub.agent_id);
        setEnvId(pub.environment_id);
        // The saved persona wins over the "default to the agent's name" effect.
        personaEditedRef.current = true;
        setPersonaName(pub.persona.name);
        if (pub.persona.avatarUrl) setPersonaAvatar(pub.persona.avatarUrl);
        // pending_setup / credentials_filled → step 2; awaiting_install → 3.
        // Slack's adapter elides credentials_filled (jumps to awaiting_install
        // on first setCredentials), so 'awaiting_install' is the install-step
        // signal. We always start on credentials so the user can re-paste —
        // the install link will be re-issued after submitCredentials.
        setStep("a1-credentials");
      } catch (err) {
        if (!cancelled) {
          // Resume failed (e.g. 404 / 409). Drop the bad ?pub= so the wizard
          // falls back to the fresh-pick path.
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
    // resumePubId pinned at first render — we don't want the URL replace
    // below to re-trigger this effect.
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

  const returnUrl = `${window.location.origin}/integrations/slack`;

  // Stamp the active publication id into the URL so a refresh resumes from
  // the same row instead of starting fresh. Pure URL state — no storage.
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
      const f = await api.slack.startA1({
        agentId,
        environmentId: envId,
        personaName,
        personaAvatarUrl: personaAvatar || null,
        returnUrl,
      });
      setA1Form(f);
      setStep("a1-credentials");
      if (f.publicationId) pinPublicationToUrl(f.publicationId);
    } catch (err) {
      setError(failureSentence(err));
    } finally {
      setWorking(false);
    }
  }

  async function submitA1Credentials() {
    if (!a1Form || !clientId || !clientSecret || !signingSecret) return;
    setError(null);
    setWorking(true);
    try {
      const link = await api.slack.submitCredentials({
        formToken: a1Form.formToken,
        clientId,
        clientSecret,
        signingSecret,
      });
      setA1InstallLink(link);
      setStep("a1-install");
      if (link.publicationId) pinPublicationToUrl(link.publicationId);
    } catch (err) {
      setError(failureSentence(err));
    } finally {
      setWorking(false);
    }
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const agentName = agents.find((a) => a.id === agentId)?.name ?? "";
  const envName = envs.find((e) => e.id === envId)?.name ?? "";
  const manifestUrl = a1Form?.manifestLaunchUrl;

  return (
    <WizardPage
      provider="slack"
      title="Publish an agent to Slack"
      subtitle="Make an agent a teammate in Slack: mentionable, in threads and direct messages."
      steps={STEPS.map((s) => s.label)}
      current={stepIndex}
      onStepClick={working ? undefined : (i) => setStep(STEPS[i].id)}
      banner={
        <>
          <InstallResult provider="slack" params={search} />
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
          description="Which agent to publish, where its sessions run, and how it appears in Slack."
          footer={
            <WizardFooter hint="About three minutes. You need to be a Slack admin." back={<CancelLink provider="slack" disabled={working} />}>
              <Button onClick={() => void startPublish()} loading={working} disabled={!agentId || !envId || !personaName.trim()}>
                Continue
                <ArrowRightIcon data-icon="inline-end" />
              </Button>
            </WizardFooter>
          }
        >
          <div className="space-y-5">
            <AgentPersonaFields
              provider="slack"
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
              provider="slack"
              name={personaName}
              avatarUrl={personaAvatar}
              agentId={agentId || undefined}
              caption="Replies in threads, joins channels it is invited to, answers direct messages."
            />
          </div>
        </WizardCard>
      )}

      {!hydrating && step === "a1-credentials" && a1Form && (
        <>
          <PublishingSummary
            personaName={personaName}
            avatarUrl={personaAvatar}
            agentId={agentId}
            agentName={agentName}
            envName={envName}
            onChange={() => setStep("pick")}
            disabled={working}
          />

          <WizardCard
            title="Create the Slack app"
            description={
              manifestUrl
                ? "Slack can configure the whole app from a manifest we prepared: name, scopes, events and redirect URLs."
                : "Create an app at api.slack.com, then point it at the URLs below."
            }
          >
            {manifestUrl ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <ExternalButton href={manifestUrl}>Create Slack app</ExternalButton>
                  <p className="min-w-0 flex-1 text-xs text-fg-subtle">
                    Opens api.slack.com in a new tab. Confirm there, then come back to this page.
                  </p>
                </div>
                <Disclosure title="Set it up by hand instead">
                  <ManualSetup form={a1Form} />
                </Disclosure>
              </div>
            ) : (
              <ManualSetup form={a1Form} />
            )}
          </WizardCard>

          <WizardCard
            title="Paste its credentials"
            description="Three values from the app's Basic Information page. The signing secret lets us verify every event Slack sends."
            footer={
              <WizardFooter
                hint="Secrets are stored encrypted and never shown again."
                back={
                  <Button variant="ghost" onClick={() => setStep("pick")} disabled={working}>
                    Back
                  </Button>
                }
              >
                <Button
                  onClick={() => void submitA1Credentials()}
                  loading={working}
                  disabled={!clientId || !clientSecret || !signingSecret}
                >
                  Continue
                  <ArrowRightIcon data-icon="inline-end" />
                </Button>
              </WizardFooter>
            }
          >
            <div className="space-y-5">
              <Callout
                tone="neutral"
                action={
                  <ExternalButton href="https://api.slack.com/apps" size="sm">
                    Open app settings
                  </ExternalButton>
                }
              >
                Press <span className="font-medium text-fg">Show</span> next to each secret on Slack's page to reveal it. Both
                secrets are 32-character hex strings, not the client ID and not the verification token.
              </Callout>
              <Field label="Client ID">
                <TextInput value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono" disabled={working} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Client secret">
                  <SecretInput value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} disabled={working} />
                </Field>
                <Field label="Signing secret">
                  <SecretInput value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} disabled={working} />
                </Field>
              </div>
            </div>
          </WizardCard>
        </>
      )}

      {!hydrating && step === "a1-install" && a1InstallLink && (
        <WizardCard
          title="Install the app in your workspace"
          description="The credentials check out. Approve the install in Slack and you are brought straight back here."
          footer={
            <WizardFooter
              hint="Installing needs a Slack admin."
              back={
                <Button variant="ghost" onClick={() => setStep("a1-credentials")}>
                  Back
                </Button>
              }
            >
              <Button asChild>
                <a href={a1InstallLink.url}>
                  Install in Slack
                  <ArrowRightIcon data-icon="inline-end" />
                </a>
              </Button>
            </WizardFooter>
          }
        >
          <div className="space-y-4">
            <PublishingSummary personaName={personaName} avatarUrl={personaAvatar} agentId={agentId} agentName={agentName} envName={envName} />
            <Disclosure title="Check the URLs Slack should now show">
              <CopyList>
                <CopyRow label="Redirect URL" value={a1InstallLink.callbackUrl} />
                <CopyRow label="Events request URL" value={a1InstallLink.webhookUrl} />
              </CopyList>
            </Disclosure>
          </div>
        </WizardCard>
      )}
    </WizardPage>
  );
}

/** The by-hand path: create the app from scratch and wire three URLs. */
function ManualSetup({ form }: { form: A1FormStep }) {
  return (
    <div className="space-y-3 text-small text-fg-muted">
      <p>
        Open{" "}
        <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className={wizardLink}>
          api.slack.com, Your Apps
        </a>
        , choose Create New App, then From scratch. Name it, pick your workspace, and use these values:
      </p>
      <CopyList>
        <CopyRow label="App name" value={form.suggestedAppName} />
        <CopyRow label="Redirect URL" value={form.callbackUrl} hint="Under OAuth and Permissions" />
        <CopyRow label="Events request URL" value={form.webhookUrl} hint="Under Event Subscriptions, after install" />
      </CopyList>
      <p>
        The events URL ends in <code className={wizardCode}>/__pending__</code> until the app is installed. After install, this
        page shows the real URL for your app: paste that one into Event Subscriptions and wait for Slack to mark it verified.
      </p>
      <div>
        <p className="mb-1.5">Subscribe to these bot events:</p>
        <div className="flex flex-wrap gap-1.5">
          {BOT_EVENTS.map((e) => (
            <code key={e} className={wizardCode}>
              {e}
            </code>
          ))}
        </div>
      </div>
      <Callout tone="warning" title="Turn on Slack MCP server access">
        On the app's Agents and AI Apps page. Without it, <code className={wizardCode}>mcp.slack.com</code> rejects the token and
        the agent falls back to slower shell commands for every Slack action.
      </Callout>
    </div>
  );
}
