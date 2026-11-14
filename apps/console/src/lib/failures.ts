/**
 * Reading a failure.
 *
 * Runtimes report failures as the provider wrote them: a status code, a
 * sentence, sometimes a JSON tail and a request id. A person needs three
 * things from that, in this order: what went wrong in plain words, what to
 * do next, and (only if they ask) the provider's exact response.
 *
 * The session's error card and the Operations queue both read failures
 * through this one function, so the same failure says the same thing in
 * both places.
 */
export interface FailureReading {
  /** The cause in plain words, when the failure is one we recognise. */
  cause?: string;
  /** What to do about it. Present whenever `cause` is. */
  next?: string;
  /** The provider's own first sentence, without the JSON tail or request id. */
  headline: string;
  /** The credentials were rejected: offer "Review model keys". */
  auth: boolean;
  /** Out of quota, rate limited or a billing stop: also a keys-and-billing matter. */
  quota: boolean;
  /** The full response, when it says more than the headline. Shown collapsed. */
  raw?: string;
}

const NO_REASON = "The runtime did not report a reason.";

export function readFailure(error: string | null | undefined): FailureReading {
  const raw = (error ?? "").trim();
  if (!raw) return { headline: NO_REASON, auth: false, quota: false };
  const head = raw
    .split(/\s\{"/)[0]
    .replace(/\s*\(request id:[^)]*\)\s*$/i, "")
    .trim();
  const headline = head.length > 180 ? `${head.slice(0, 179)}…` : head;
  const auth = /\b401\b|\b403\b|api[- ]key|authorization|authentication/i.test(raw);
  const quota = !auth && /\b429\b|quota|rate limit|billing/i.test(raw);
  const overloaded = !auth && !quota && /\b529\b|\b503\b|overloaded|unavailable/i.test(raw);
  const timeout = /timed? ?out|\b504\b|deadline/i.test(raw);
  const silent = /no output generated/i.test(raw);

  let cause: string | undefined;
  let next: string | undefined;
  if (auth) {
    cause = "The model provider rejected this workspace's key.";
    next = "Check the key for this model in Models, then retry.";
  } else if (quota) {
    cause = "The model provider account is out of quota, or is rate limiting this key.";
    next = "Check the plan and billing for this model's key with the provider, then retry.";
  } else if (overloaded) {
    cause = "The model provider was overloaded and did not answer.";
    next = "This usually clears by itself. Retry in a minute.";
  } else if (timeout) {
    cause = "The request ran out of time before the model answered.";
    next = "Retry. If it keeps happening, the turn may be asking for too much at once.";
  } else if (silent) {
    cause = "The model returned nothing for this turn.";
    next = "Retry. If it repeats, rephrase the last message.";
  }
  // With a plain-words cause the provider's sentence is no longer on the
  // card, so the raw response always has something to add.
  const more = cause ? raw : raw !== headline ? raw : undefined;
  return { cause, next, headline, auth, quota, raw: more };
}
