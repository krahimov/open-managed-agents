import type { ComponentType } from "react";

import { cn } from "@/lib/utils";

import { GitHubIcon, LinearIcon, SlackIcon } from "../../components/icons";
import type { AvatarSize } from "../../components/AgentAvatar";
import type { PublicationStatus } from "./StatusPill";

/**
 * The three places an agent can be published as a teammate. Everything
 * that differs between them in the list, workspace and wizard pages (names,
 * routes, verbs, copy) is declared here once, so the three sets of pages
 * stay one design.
 */
export type ProviderId = "slack" | "github" | "linear";

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  icon: ComponentType<{ className?: string }>;
  /** List page. */
  listPath: string;
  /** Wizard that publishes (or binds) an agent. */
  publishPath: string;
  installationPath: (id: string) => string;
  /** The primary action: "Publish agent", "Bind agent". */
  publishLabel: string;
  /** What a connected account is called on that product. */
  workspaceNoun: string;
  /** One sentence under the page title. */
  tagline: string;
  /** First-run explainer: the three things the wizard will ask for. */
  steps: Array<{ title: string; body: string }>;
  /** What a half-finished publication is waiting for. */
  nextStep: (status: PublicationStatus) => string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  slack: {
    id: "slack",
    name: "Slack",
    icon: SlackIcon,
    listPath: "/integrations/slack",
    publishPath: "/integrations/slack/publish",
    installationPath: (id) => `/integrations/slack/installations/${id}`,
    publishLabel: "Publish agent",
    workspaceNoun: "workspace",
    tagline: "Publish agents as teammates in Slack: mention them, message them, get replies in threads.",
    steps: [
      { title: "Choose an agent", body: "Pick the agent, where it runs, and the name people will see in Slack." },
      { title: "Create its Slack app", body: "One click from a manifest we prepare. Then paste three values back here." },
      { title: "Install it", body: "Approve the app in your Slack workspace. The agent is live when you return." },
    ],
    nextStep: (s) => (s === "pending_setup" ? "Next: add the Slack app's credentials" : "Next: install the app in Slack"),
  },
  github: {
    id: "github",
    name: "GitHub",
    icon: GitHubIcon,
    listPath: "/integrations/github",
    publishPath: "/integrations/github/bind",
    installationPath: (id) => `/integrations/github/installations/${id}`,
    publishLabel: "Bind agent",
    workspaceNoun: "organization",
    tagline: "Agents with their own GitHub identity: assign them issues, request reviews, mention them.",
    steps: [
      { title: "Choose an agent", body: "Pick the agent, where it runs, and the bot name people will see on GitHub." },
      { title: "Register a GitHub App", body: "GitHub creates the app from a manifest. One confirmation, nothing to copy." },
      { title: "Install it", body: "Choose the organization and repositories the bot may work in." },
    ],
    nextStep: (s) => (s === "pending_setup" ? "Next: register the GitHub App" : "Next: install the app on your organization"),
  },
  linear: {
    id: "linear",
    name: "Linear",
    icon: LinearIcon,
    listPath: "/integrations/linear",
    publishPath: "/integrations/linear/publish",
    installationPath: (id) => `/integrations/linear/installations/${id}`,
    publishLabel: "Publish agent",
    workspaceNoun: "workspace",
    tagline: "Publish agents as teammates in Linear: assign them issues and mention them.",
    steps: [
      { title: "Choose an agent", body: "Pick the agent, where it runs, and the name people will see in Linear." },
      { title: "Create its OAuth app", body: "Copy the values we give you into Linear, then paste three credentials back." },
      { title: "Install it", body: "Approve the app in your Linear workspace. The agent is live when you return." },
    ],
    nextStep: (s) => (s === "pending_setup" ? "Next: add the OAuth app's credentials" : "Next: install the app in Linear"),
  },
};

const TILE: Record<AvatarSize, { box: string; icon: string }> = {
  xs: { box: "size-5 rounded-[6px]", icon: "size-3" },
  sm: { box: "size-6 rounded-[7px]", icon: "size-3.5" },
  md: { box: "size-8 rounded-[10px]", icon: "size-4" },
  lg: { box: "size-10 rounded-[12px]", icon: "size-5" },
  xl: { box: "size-14 rounded-[16px]", icon: "size-7" },
  "2xl": { box: "size-[72px] rounded-[20px]", icon: "size-9" },
};

/**
 * A provider's brand mark on a white squircle tile: the same shape as
 * every other avatar in the console, with the mark in ink. The marks are
 * the single-colour glyphs from components/icons.tsx; they are not
 * recoloured per provider.
 */
export function ProviderMark({
  provider,
  size = "md",
  className,
}: {
  provider: ProviderId;
  size?: AvatarSize;
  className?: string;
}) {
  const Icon = PROVIDERS[provider].icon;
  const t = TILE[size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-border bg-bg-surface text-fg shadow-[var(--shadow-xs)] dark:bg-bg-soft",
        t.box,
        className,
      )}
    >
      <Icon className={t.icon} />
    </span>
  );
}
