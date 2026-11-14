/**
 * Which agent the starter opens on when nothing was asked for and the
 * person has not chosen one (a chosen agent is `draftStore.recipient` and
 * always wins, before this is asked).
 *
 * The default is the agent used most in the recent sessions. That is only
 * known once the sessions were read: while they load, or when the read
 * failed, every agent counts zero and "most used" would be whichever was
 * created last, so Home would open on Data Quality Monitor one minute and
 * on "Incident commander 2" the next, with its chips, and say nothing. So
 * the default worked out the last time the sessions could be read is kept
 * (in this browser) and used until they can be read again.
 */

export interface DefaultCandidate {
  id: string;
  created_at: string;
  archived_at?: string | null;
}

export function defaultAgent<A extends DefaultCandidate>({
  agents,
  usage,
  remembered,
}: {
  agents: A[];
  /** Sessions per agent, or null while that is not known (loading, or the read failed). */
  usage: Map<string, number> | null;
  /** The default worked out the last time usage was known. */
  remembered: string | null;
}): A | undefined {
  const active = agents.filter((a) => !a.archived_at);
  if (!usage) {
    const kept = remembered ? active.find((a) => a.id === remembered) : undefined;
    if (kept) return kept;
  }
  let best: A | undefined;
  let bestCount = -1;
  for (const a of active) {
    const count = usage?.get(a.id) ?? 0;
    if (count > bestCount || (count === bestCount && best && a.created_at > best.created_at)) {
      best = a;
      bestCount = count;
    }
  }
  return best;
}

const KEY = "oma.home.defaultAgent";

export const rememberedDefault = {
  get(): string | null {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(agentId: string): void {
    try {
      if (localStorage.getItem(KEY) !== agentId) localStorage.setItem(KEY, agentId);
    } catch {
      /* storage unavailable: the default is worked out again next time */
    }
  },
};
