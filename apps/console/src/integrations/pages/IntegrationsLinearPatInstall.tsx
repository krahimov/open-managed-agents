import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";

import { IntegrationsApi } from "../api/client";
import { AgentPersonaFields, CancelLink, WizardCard, WizardFooter, WizardPage, wizardLink } from "../components/Wizard";
import { Callout } from "../../components/Callout";
import { Field } from "../../components/Field";
import { SecretInput } from "../../components/Input";
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

interface Props {
  loadAgents: () => Promise<AgentOption[]>;
  loadEnvironments: () => Promise<EnvironmentOption[]>;
}

/**
 * Install Linear with a personal API key: paste the key, pick agent and
 * environment, done. No OAuth app to register.
 *
 * Trade-offs against the OAuth-app install:
 *   - the agent acts as the key's owner (their name on every comment)
 *   - no agent session panel in Linear (it cannot open one for a non-app user)
 *   - autopilot sweeps only: no realtime webhook trigger
 * For a single-user setup or a small private workspace this is the fast path.
 */
export function IntegrationsLinearPatInstall({ loadAgents, loadEnvironments }: Props) {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState("");
  const [envId, setEnvId] = useState("");
  const [personaName, setPersonaName] = useState("");
  const [pat, setPat] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [a] = await Promise.all([loadAgents(), loadEnvironments()]);
        setAgents(a);
      } catch (err) {
        setError(failureSentence(err));
      }
    })();
  }, [loadAgents, loadEnvironments]);

  // Default persona to the agent's name. Skip once the user has edited the
  // field — otherwise clearing the input would refill it from the effect's
  // personaName dep, making the field feel un-clearable.
  const personaEditedRef = useRef(false);
  useEffect(() => {
    if (personaEditedRef.current) return;
    if (agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (agent) setPersonaName(agent.name);
    }
  }, [agentId, agents]);

  const complete = !!agentId && !!envId && !!personaName.trim() && !!pat.trim();

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!complete) {
      setError("Choose an agent and an environment, name the persona, and paste the API key.");
      return;
    }
    setWorking(true);
    try {
      await api.installPersonalToken({
        agentId,
        environmentId: envId,
        personaName: personaName.trim(),
        personaAvatarUrl: null,
        patToken: pat.trim(),
      });
      // Back to the list, where the new workspace appears and autopilot
      // rules can be set up.
      navigate(`/integrations/linear`);
    } catch (err) {
      setError(failureSentence(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <WizardPage
      provider="linear"
      title="Install Linear with an API key"
      subtitle="One personal API key instead of an OAuth app. Best for a small private workspace."
      banner={
        error && (
          <Callout tone="danger" title="Linear was not installed">
            {error}
          </Callout>
        )
      }
    >
      <form onSubmit={(e) => void handleSubmit(e)} autoComplete="off">
        <WizardCard
          title="Connect an agent"
          description="Which agent works in Linear, where its sessions run, and the key it acts with."
          footer={
            <WizardFooter hint="The key is checked with Linear before anything is saved." back={<CancelLink provider="linear" disabled={working} />}>
              <Button type="submit" loading={working} disabled={!complete}>
                Install in Linear
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
              personaLabel="Persona display name"
              personaHint="How the agent is named here. In Linear its actions carry the key owner's name."
              disabled={working}
            />
            <Field
              label="Linear personal API key"
              hint="Create one in Linear under Settings, Security and access, Personal API keys. It is stored encrypted in your workspace vault and never handed to the agent directly."
            >
              <SecretInput value={pat} onChange={(e) => setPat(e.target.value)} placeholder="lin_api_" disabled={working} />
            </Field>
            <Callout tone="neutral" title="What you give up compared with publishing">
              The agent acts as the key's owner rather than as its own teammate, Linear cannot open an agent session panel for
              it, and it picks up work through autopilot sweeps instead of the moment it is assigned.{" "}
              <Link className={wizardLink} to="/integrations/linear/publish">
                Publish with full identity instead
              </Link>
            </Callout>
          </div>
        </WizardCard>
      </form>
    </WizardPage>
  );
}
