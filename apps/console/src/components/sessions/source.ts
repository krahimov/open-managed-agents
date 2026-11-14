/**
 * Where a session was started from, and what can honestly be opened from
 * here. The rule: a link is labelled with what it opens. If the exact
 * address cannot be built from what the session carries, the page says
 * "Open Linear", not "Open in Linear", and gives the identifier to copy.
 */

export interface LinearSource {
  /** Linear's own id for the issue (a UUID on real sessions). */
  issueId?: string;
  /** The identifier people use: "SUP-482". */
  issueIdentifier?: string;
  workspaceId?: string | null;
  publicationId?: string;
}

export interface SlackSource {
  channelId?: string;
  threadTs?: string;
  /** Slack team id ("T…"). */
  workspaceId?: string;
  eventKind?: string;
  publicationId?: string;
}

/**
 * The address of a Slack thread or channel in Slack's web client, which
 * takes a team id, a channel id and a thread timestamp, all of which the
 * session records:
 *
 *   https://app.slack.com/client/{team}/{channel}/thread/{channel}-{thread_ts}
 *
 * (The permalink form needs the workspace's subdomain, which the API does
 * not return.) Null when even the channel cannot be addressed.
 */
export function slackLink(slack: SlackSource | null | undefined): { href: string; opens: "thread" | "channel" } | null {
  if (!slack?.workspaceId || !slack.channelId) return null;
  const base = `https://app.slack.com/client/${encodeURIComponent(slack.workspaceId)}/${encodeURIComponent(slack.channelId)}`;
  if (slack.threadTs && /^\d+\.\d+$/.test(slack.threadTs)) {
    return { href: `${base}/thread/${encodeURIComponent(slack.channelId)}-${slack.threadTs}`, opens: "thread" };
  }
  return { href: base, opens: "channel" };
}

/** "Slack direct message" · "Slack thread" · "Slack channel" · "Slack". */
export function slackNoun(slack: SlackSource): string {
  if (slack.channelId?.startsWith("D")) return "Slack direct message";
  if (slack.threadTs) return "Slack thread";
  return slack.channelId ? "Slack channel" : "Slack";
}

/**
 * An issue's address in Linear is linear.app/{workspace url key}/issue/{id}.
 * The session records Linear's workspace UUID, not its url key, so the
 * address has to be found, and there are three honest places to find it:
 *
 *   1. The session's own log already holds the issue's address: the pickup
 *      message a dispatch rule writes carries "**URL:** https://linear.app/…",
 *      and Linear's tools answer with addresses.
 *   2. The log holds the address of ANOTHER issue of the same workspace
 *      (the agent looked one up, or linked a duplicate). The url key is the
 *      same, and Linear opens linear.app/{key}/issue/{identifier} without
 *      the title part.
 *   3. The connected workspace the console can already read
 *      (GET /v1/integrations/linear/installations) records the url key as
 *      its workspace id. (A runtime that records Linear's UUID there gives
 *      nothing to build with, and is ignored.)
 *
 * When none of them answers, there is no address: the page says "Open
 * Linear" and gives the identifier to paste into Linear's search.
 */
export const LINEAR_HOME = "https://linear.app";

const LINEAR_ISSUE_URL = /https:\/\/linear\.app\/([a-z0-9][a-z0-9-]*)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[A-Za-z0-9._~%-]*)?/g;
const ONE_LINEAR_ISSUE_URL = new RegExp(LINEAR_ISSUE_URL.source);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a session's log says about where its Linear workspace lives. */
export interface LinearFound {
  /** The address of this very issue, as the log has it. */
  issueUrl?: string;
  /** The workspace's url key ("lumen"), from any issue address in the log. */
  urlKey?: string;
}

/**
 * Look through text (an opening message, tool results) for Linear issue
 * addresses. `identifier` is the issue this session is about ("SUP-482").
 */
export function findLinearAddress(texts: Iterable<string>, identifier?: string): LinearFound {
  const keys = new Map<string, number>();
  let issueUrl: string | undefined;
  const want = identifier?.toUpperCase();
  for (const text of texts) {
    if (!text.includes("linear.app/")) continue;
    for (const m of text.matchAll(LINEAR_ISSUE_URL)) {
      keys.set(m[1], (keys.get(m[1]) ?? 0) + 1);
      if (!issueUrl && want && m[2].toUpperCase() === want) issueUrl = m[0];
    }
  }
  // The key most often seen: one stray address of another workspace does not win.
  const common = [...keys.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (issueUrl) return { issueUrl, urlKey: ONE_LINEAR_ISSUE_URL.exec(issueUrl)?.[1] ?? common };
  return { urlKey: common };
}

/** A workspace id that is a url key ("lumen"), not Linear's UUID for the organisation. */
export function linearUrlKey(workspaceId: string | null | undefined): string | undefined {
  const id = workspaceId?.trim();
  if (!id || UUID.test(id) || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) return undefined;
  return id;
}

/**
 * The exact address of the issue a session was started from, or null when
 * it cannot be built from what the console can read.
 */
export function linearIssueLink(linear: LinearSource | null | undefined, found: LinearFound & { workspaceKey?: string }): string | null {
  if (!linear) return null;
  if (found.issueUrl) return found.issueUrl;
  const key = found.urlKey ?? found.workspaceKey;
  const ident = linear.issueIdentifier;
  if (!key || !ident || !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(ident)) return null;
  return `${LINEAR_HOME}/${key}/issue/${ident.toUpperCase()}`;
}

/** What GitHub started a session from, as the webhook recorded it. */
export interface GitHubSource {
  /** "owner/name" */
  repository?: string;
  itemKind?: string;
  itemNumber?: number | null;
  /** The address GitHub itself gave for the pull request or issue. */
  htmlUrl?: string | null;
}

/**
 * Where a GitHub session can be opened. GitHub's addresses are built from
 * exactly what the session records (owner/name, the kind of item and its
 * number), and the webhook usually sends the address itself.
 */
export function githubLink(gh: GitHubSource | null | undefined): { href: string; opens: "pull request" | "issue" | "repository"; label: string } | null {
  const repo = gh?.repository?.trim();
  if (!gh) return null;
  const n = typeof gh.itemNumber === "number" ? gh.itemNumber : null;
  const pull = /pull/i.test(gh.itemKind ?? "") || /\/pull\/\d+/.test(gh.htmlUrl ?? "");
  const label = repo ? (n != null ? `${repo}#${n}` : repo) : "GitHub";
  if (gh.htmlUrl && /^https:\/\/github\.com\//.test(gh.htmlUrl)) {
    return { href: gh.htmlUrl, opens: n != null || /\/(pull|issues)\/\d+/.test(gh.htmlUrl) ? (pull ? "pull request" : "issue") : "repository", label };
  }
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  if (n != null) return { href: `https://github.com/${repo}/${pull ? "pull" : "issues"}/${n}`, opens: pull ? "pull request" : "issue", label };
  return { href: `https://github.com/${repo}`, opens: "repository", label };
}

/**
 * Sessions started by a Linear webhook open with a message that names the
 * issue ("**Issue:** ENG-142"); the session's metadata often carries only
 * Linear's UUID. Read the identifier people use from that first message.
 */
export function linearIdentifierFromText(text: string): string | undefined {
  if (!/^# Linear\b/.test(text.trimStart())) return undefined;
  return /^\*\*Issue:\*\*\s+([A-Za-z][A-Za-z0-9]*-\d+)\b/m.exec(text)?.[1];
}
