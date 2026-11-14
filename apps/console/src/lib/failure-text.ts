/**
 * A failure, in words a person can read.
 *
 * Servers answer failures with whatever they have: a sentence
 * ("Insufficient balance."), a bare token ("unavailable",
 * "internal_error"), a status line ("Bad Gateway"), or nothing. Browsers
 * add their own ("Failed to fetch"). None of the short ones may reach the
 * screen as they are, and none may be glued to the end of our own sentence
 * ("Failed to fetch You can still write it by hand below.").
 *
 *   failureSentence(err)            always one or two whole sentences
 *   withReason("It was not saved", err)
 *                                   our sentence, a full stop, then the reason
 *
 * A server message that already reads as a sentence is kept in the
 * server's words (given a capital and a full stop when it lacks them). A
 * bare token is quoted inside a sentence that says what kind of failure it
 * was, read from the HTTP status.
 */

/** Messages a browser gives a request that never reached the server. */
const NETWORK = /^(failed to fetch|load failed|network ?error.*|networkerror when attempting to fetch resource\.?|fetch failed|the internet connection appears to be offline\.?)$/i;

const UNREACHABLE = "The server could not be reached. Check your connection and try again.";

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (typeof error === "string") return error.trim();
  return "";
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/** HTTP reason phrases: labels, however many words they run to. */
const STATUS_LINE =
  /^(bad request|unauthorized|payment required|forbidden|not found|method not allowed|request timeout|conflict|gone|unprocessable (entity|content)|too many requests|internal server error|not implemented|bad gateway|service unavailable|gateway time-?out)\.?$/i;

/** True when the text is something we can show as the server wrote it. */
function readsAsSentence(text: string): boolean {
  // "The vault is archived" and "Insufficient balance." are sentences;
  // "invalid_request_error", "HTTP 500", "Bad Gateway" and "upstream
  // unavailable" are labels.
  if (STATUS_LINE.test(text) || /^http\s+\d+$/i.test(text) || !/\s/.test(text)) return false;
  return text.split(/\s+/).length >= 3 || /[.!?]$/.test(text);
}

function finish(text: string): string {
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?…)]$/.test(capital) ? capital : `${capital}.`;
}

/** The server's own short word for it, for quoting: nothing when it said nothing useful. */
function token(text: string): string {
  return !text || /^http\s+\d+$/i.test(text) ? "" : ` (“${text}”)`;
}

export function failureSentence(error: unknown, status: number | undefined = statusOf(error)): string {
  const text = messageOf(error);
  if (NETWORK.test(text) || (error instanceof TypeError && status === undefined)) return UNREACHABLE;
  if (text && readsAsSentence(text)) return finish(text);
  if (status === undefined) return text ? `Something went wrong${token(text)}.` : "Something went wrong.";
  if (status === 401) return "You are signed out. Sign in and try again.";
  if (status === 403) return `You do not have access to that${token(text)}.`;
  if (status === 404) return "That could not be found. It may have been deleted.";
  if (status === 408 || status === 504) return "The server took too long to answer. Try again in a moment.";
  if (status === 429) return "Too many requests at once. Wait a moment and try again.";
  if (status === 501) return "This server does not support that.";
  if (status >= 500) return `The server had a problem${token(text)}. Try again in a moment.`;
  return `The request was refused${token(text)}.`;
}

/** Our sentence, then why: "The rubric could not be drafted. The server had a problem (“unavailable”). Try again in a moment." */
export function withReason(lead: string, error: unknown): string {
  return `${finish(lead.trim())} ${failureSentence(error)}`;
}
