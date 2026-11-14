import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ArrowRightIcon, CheckIcon, RotateCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { IntegrationsApi } from "../api/client";
import type { GitHubA1FormStep, GitHubA1InstallLink } from "../api/types";
import {
  AgentPersonaFields,
  CancelLink,
  ExternalButton,
  PersonaPreview,
  WizardCard,
  WizardFooter,
  WizardPage,
  wizardCode,
} from "../components/Wizard";
import { BrandLoader } from "../../components/BrandLoader";
import { Callout } from "../../components/Callout";
import { IdChip } from "../../components/IdChip";
import { BRAND_NAME } from "../../lib/brand";
import { failureSentence } from "../../lib/failure-text";

const api = new IntegrationsApi();

interface Agent { id: string; name: string }
interface Environment { id: string; name: string }

interface Props {
  loadAgents: () => Promise<Agent[]>;
  loadEnvironments: () => Promise<Environment[]>;
}

type Phase = "config" | "registering" | "installing" | "done" | "error";

const STEPS: Array<{ key: Phase; label: string }> = [
  { key: "config", label: "Choose agent" },
  { key: "registering", label: "Register the app" },
  { key: "installing", label: "Install" },
  { key: "done", label: "Live" },
];

/** GitHub derives the bot login and the trigger label from the name like this. */
const botSlug = (name: string) => name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");

/**
 * Four-screen wizard with the manifest flow as default. Cuts the manual
 * "register App, download .pem, paste back 4 secrets" path down to one
 * button + one install click.
 *
 * Phases:
 *   config       → user picks agent + env + bot name and presses "Bind".
 *                  We POST start-a1 → backend INSERTs a github_publications
 *                  shell row (status='pending_setup', app_oma_id minted)
 *                  and returns formToken + manifestStartUrl + publicationId.
 *   registering  → we open manifestStartUrl in a popup. User confirms on
 *                  GitHub. GitHub redirects through our gateway which
 *                  exchanges the manifest code and PATCH'es credentials onto
 *                  the publication row.
 *   installing   → GitHub takes the user straight on to the install screen.
 *                  The gateway callback mints the installation token, creates
 *                  the vault and binds installation_id onto the publication.
 *                  We poll until publication.status === "live".
 *   done         → success, with a link to the installation.
 *
 * The publication-first flow means even a mid-flow failure leaves at most a
 * publication row in 'pending_setup' or 'credentials_filled' — never a ghost
 * installation/app pair. The user can resume it from the list page.
 */
export function IntegrationsGitHubBindWizard({ loadAgents, loadEnvironments }: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  const [envId, setEnvId] = useState<string>("");
  const [persona, setPersona] = useState<string>("");

  const [phase, setPhase] = useState<Phase>("config");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<GitHubA1FormStep | null>(null);
  const [installLink] = useState<GitHubA1InstallLink | null>(null);
  const [livePubId, setLivePubId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // Background poll handle. Single source of truth so cleanup-on-unmount and
  // cleanup-on-success can both reach in and stop it without leaking.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // If GitHub completed install and bounced back with
  // ?install=ok&publication_id=…, surface the "done" state directly.
  useEffect(() => {
    const installFlag = searchParams.get("install");
    const pubId = searchParams.get("publication_id");
    if (installFlag === "ok" && pubId) {
      setPhase("done");
      setLivePubId(pubId);
    }
  }, [searchParams]);

  useEffect(() => {
    void loadAgents().then(setAgents).catch(() => undefined);
    void loadEnvironments().catch(() => undefined);
  }, [loadAgents, loadEnvironments]);

  // Refresh-resume hydration. When the wizard renders with `?pub=<id>` (set
  // by replaceState below or by the pending-pub list page), re-issue a fresh
  // formToken against the existing shell row and pick up where we left off.
  // Server is the source of truth — no sessionStorage / localStorage.
  useEffect(() => {
    const resumePubId = searchParams.get("pub");
    if (!resumePubId) return;
    let cancelled = false;
    void (async () => {
      try {
        const pub = await api.github.getPublication(resumePubId);
        if (cancelled) return;
        if (pub.status === "live") {
          // Live pubs belong on the list page, not the wizard.
          setPhase("done");
          setLivePubId(pub.id);
          return;
        }
        if (pub.status === "unpublished" || pub.status === "needs_reauth") {
          searchParams.delete("pub");
          setSearchParams(searchParams, { replace: true });
          return;
        }
        // Re-issue the formToken so the manifestStartUrl works again.
        const r = await api.github.reissueFormToken(resumePubId);
        if (cancelled) return;
        setForm(r);
        setAgentId(pub.agent_id);
        setEnvId(pub.environment_id);
        // The saved bot name wins over the "default to the agent's name" effect.
        personaEditedRef.current = true;
        setPersona(pub.persona.name);
        // pending_setup → the manifest tab was closed before submitting, so
        //   show "registering" with the manifest URL ready.
        // credentials_filled / awaiting_install → the manifest finished and
        //   the install has not: resume the install poll.
        if (pub.status === "pending_setup") {
          setPhase("registering");
        } else {
          setPhase("installing");
          startInstallPoll(resumePubId);
        }
      } catch (err) {
        if (!cancelled) {
          searchParams.delete("pub");
          setSearchParams(searchParams, { replace: true });
          setError(failureSentence(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Resume runs once per wizard mount; don't re-trigger on unrelated URL
    // changes (we mutate search params via replaceState).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default the bot name to the chosen agent's name. Skip once the user has
  // edited the field — otherwise clearing the input would refill it.
  const personaEditedRef = useRef(false);
  useEffect(() => {
    if (personaEditedRef.current) return;
    if (agentId) {
      const a = agents.find((x) => x.id === agentId);
      if (a) setPersona(a.name);
    }
  }, [agentId, agents]);

  // Tear down any in-flight poll on unmount. Without this, navigating away
  // mid-flow leaves a setInterval firing fetches against a dead component.
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function startBind() {
    if (!agentId || !envId || !persona) {
      setError("Choose an agent, an environment and a bot name.");
      return;
    }
    setError(null);
    setPhase("registering");
    try {
      const r = await api.github.startA1({
        agentId,
        environmentId: envId,
        personaName: persona,
        returnUrl: `${window.location.origin}/integrations/github`,
      });
      setForm(r);
      // Pin publication id to URL so refresh resumes here without losing
      // wizard state. Server is source of truth — we just stash the id.
      pinPublicationToUrl(r.publicationId);
      // Open the manifest flow in a popup. The popup eventually navigates
      // to our gateway callback, which redirects on to the GitHub install.
      if (r.manifestStartUrl) {
        window.open(r.manifestStartUrl, "github-bind", "width=820,height=720");
      }
      // Optimistically advance to "installing": once the user has clicked
      // through the manifest flow, GitHub takes them straight into the
      // install screen. The poll below covers both phases until the
      // publication flips to live.
      setPhase("installing");
      startInstallPoll(r.publicationId);
    } catch (e) {
      setError(failureSentence(e));
      setPhase("error");
    }
  }

  /** Stamp the active publication id into ?pub= so refresh resumes here. */
  function pinPublicationToUrl(publicationId: string) {
    const url = new URL(window.location.href);
    if (url.searchParams.get("pub") === publicationId) return;
    url.searchParams.set("pub", publicationId);
    window.history.replaceState({}, "", url.toString());
  }

  // Poll every 5 seconds for the publication's status to flip to 'live'.
  // Hard cap at ~5 minutes (60 ticks) so abandoned tabs don't poll forever.
  function startInstallPoll(pubId: string) {
    stopPolling();
    let ticks = 0;
    const TICK_MS = 5_000;
    const MAX_TICKS = 60;
    pollRef.current = setInterval(async () => {
      ticks += 1;
      if (ticks > MAX_TICKS) {
        stopPolling();
        return;
      }
      try {
        const pub = await api.github.getPublication(pubId);
        if (pub.status === "live") {
          stopPolling();
          setPhase("done");
          setLivePubId(pub.id);
          return;
        }
      } catch {
        // Network blip — keep polling. We only stop on success or timeout.
      }
    }, TICK_MS);
  }

  // Manual check: the same lookup as the poll, run once.
  async function refresh() {
    if (!form) return;
    setChecking(true);
    try {
      const pub = await api.github.getPublication(form.publicationId);
      if (pub.status === "live") {
        stopPolling();
        setPhase("done");
        setLivePubId(pub.id);
        return;
      }
    } catch {
      // ignore — the user can keep waiting
    } finally {
      setChecking(false);
    }
  }

  const slug = botSlug(persona) || "your-bot";
  // An error keeps the indicator on the step that failed.
  const stepIndex = phase === "error" ? 0 : STEPS.findIndex((s) => s.key === phase);
  const waiting = phase === "registering" || phase === "installing";
  const reopenUrl = phase === "installing" && installLink?.url ? installLink.url : (form?.manifestStartUrl ?? null);

  return (
    <WizardPage
      provider="github"
      title="Bind an agent to GitHub"
      subtitle="Give an agent its own GitHub App: assign it, mention it, request its review."
      steps={STEPS.map((s) => s.label)}
      current={stepIndex}
      banner={
        phase === "error" ? (
          <Callout
            tone="danger"
            title="The GitHub App could not be registered"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPhase("config");
                  setError(null);
                }}
              >
                Try again
              </Button>
            }
          >
            {error}
          </Callout>
        ) : error ? (
          <Callout tone="danger" title="That did not go through">
            {error}
          </Callout>
        ) : null
      }
    >
      {phase === "config" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void startBind();
          }}
        >
          <WizardCard
            title="Choose the agent"
            description="Which agent to bind, where its sessions run, and what its bot is called on GitHub."
            footer={
              <WizardFooter
                hint="Opens GitHub in a new window: create the app there, then install it."
                back={<CancelLink provider="github" />}
              >
                <Button type="submit" disabled={!agentId || !envId || !persona.trim()}>
                  Bind on GitHub
                  <ArrowRightIcon data-icon="inline-end" />
                </Button>
              </WizardFooter>
            }
          >
            <div className="space-y-5">
              <AgentPersonaFields
                provider="github"
                agentId={agentId}
                onAgent={setAgentId}
                envId={envId}
                onEnv={setEnvId}
                personaName={persona}
                onPersonaName={(v) => {
                  personaEditedRef.current = true;
                  setPersona(v);
                }}
                personaLabel="Bot name"
                personaHint="GitHub creates the bot user from this name. Defaults to the agent's name."
              />
              <PersonaPreview
                provider="github"
                name={persona}
                agentId={agentId || undefined}
                caption={
                  <span className="font-mono">
                    @{slug}[bot]
                  </span>
                }
              />
              <div>
                <p className="mb-2 text-xs font-medium text-fg-subtle">How people will reach this bot</p>
                <dl className="divide-y divide-border overflow-hidden rounded-lg border border-border text-small">
                  <Reach term="Label">
                    Add the <code className={wizardCode}>{slug}</code> label to an issue or pull request. The bot follows what
                    happens on labelled items: edits, new comments, new commits and reviews.
                  </Reach>
                  <Reach term="Mention">
                    Write <code className={wizardCode}>@{slug}[bot]</code> in an issue, pull request or comment. GitHub does not
                    autocomplete bot accounts, so type it in full.
                  </Reach>
                  <Reach term="Stop">
                    Remove the label to stop it following that thread. {BRAND_NAME} creates the label on install and does not
                    recreate it if you delete it.
                  </Reach>
                </dl>
              </div>
            </div>
          </WizardCard>
        </form>
      )}

      {waiting && (
        <WizardCard>
          <div className="flex flex-col items-center px-4 py-8 text-center" role="status" aria-live="polite">
            <BrandLoader size="lg" label="Waiting for GitHub" />
            <h2 className="mt-5 text-h2 text-fg">
              {phase === "registering"
                ? form
                  ? `Create ${form.suggestedAppName} on GitHub`
                  : "Preparing the GitHub App"
                : "Install it on your organization"}
            </h2>
            <p className="mt-1.5 max-w-[46ch] text-small text-fg-muted">
              {form
                ? "Switch to the GitHub window to confirm. This page checks every few seconds and moves on by itself when GitHub is done."
                : "Reserving the app's name and preparing its manifest."}
            </p>
            {form && (
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                {reopenUrl && (
                  <ExternalButton href={reopenUrl} target="github-bind">
                    Reopen the GitHub window
                  </ExternalButton>
                )}
                <Button variant="ghost" onClick={() => void refresh()} loading={checking}>
                  {!checking && <RotateCwIcon data-icon="inline-start" />}
                  Check now
                </Button>
              </div>
            )}
          </div>
        </WizardCard>
      )}

      {phase === "done" && (
        <WizardCard>
          <div className="flex flex-col items-center px-4 py-8 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-success-subtle text-success">
              <CheckIcon className="size-6 stroke-[2.25]" />
            </span>
            <h2 className="mt-5 text-h2 text-fg">The bot is live on GitHub</h2>
            <p className="mt-1.5 max-w-[46ch] text-small text-fg-muted">
              Assign it an issue or mention it in a comment. The first reply after binding can take a few seconds longer while
              its environment starts.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <Button onClick={() => navigate("/integrations/github")}>View installation</Button>
              {livePubId && <IdChip id={livePubId} label="Copy publication id" />}
            </div>
          </div>
        </WizardCard>
      )}
    </WizardPage>
  );
}

function Reach({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 px-3.5 py-2.5">
      <dt className="w-20 shrink-0 font-medium text-fg">{term}</dt>
      <dd className="min-w-0 flex-1 text-fg-muted">{children}</dd>
    </div>
  );
}
