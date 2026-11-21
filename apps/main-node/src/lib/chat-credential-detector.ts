/**
 * Conservative check for inbound chat text that looks like a pasted credential.
 * Pure and synchronous: no I/O, no logging. A hit keeps the text out of the
 * session and out of durable channel storage (see channel-onboarding.ts).
 *
 * Evidence, in order:
 *  1. URLs: a password in the userinfo (`https://user:token@host`) or a
 *     credential in the query/fragment (`?api_key=…`, `#access_token=…`).
 *     URL paths are never evidence.
 *  2. Well-known credential syntaxes, matched on their syntax alone after
 *     URLs, e-mail addresses and platform IDs are removed (`sk-…`,
 *     `sk_live_…`, `ghp_…`, `Bearer <token>`, `Authorization:` values, PEM
 *     private keys, JWTs, …).
 *  3. A generic fallback: a long random-looking token. Only this fallback
 *     requires mixed letters and digits, and it ignores readable
 *     identifiers (camelCase / snake_case words with a few numbers).
 *
 * Link codes (`/start <code>`, `ORRERY <code>`) are not credentials unless
 * they match a known syntax.
 */

// Platform IDs (packages/shared/src/id.ts) and channel request IDs.
const PLATFORM_ID = /\b(?:agent|sess|env|vlt|cred|memstore|mem|memver|file|sesrsc|sevt|mdl|evrun|ambrule|grant|amch|amev|acreq|outc)[-_][A-Za-z0-9_-]+/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_LIKE = /\b(?:https?|wss?|ftp):\/\/[^\s<>"']+/gi;
const OTHER_URI = /\b(?:sms|tel|mailto):[^\s<>"']+/gi;
const EMAIL = /\b[^\s@<>"'/:]+@[^\s@<>"']+\.[A-Za-z]{2,}\b/g;
const LINK_CODE = /^\s*(?:\/start(?:@\w+)?\s+|ORRERY\s+)[A-Za-z0-9_-]{32}\s*$/;

/** Explicit syntaxes. Each must have an unbroken body, so `sk-learn-for-beginners`
 *  or `Bearer token-based-auth` (hyphenated words) do not qualify. */
const KNOWN: RegExp[] = [
  /(?<![\w-])sk-(?:(?:proj|ant|svcacct|admin|or|live|test)-(?:[a-z0-9]+-)?)?[A-Za-z0-9_]{20,}[A-Za-z0-9_-]*/, // OpenAI / Anthropic / OpenRouter style
  /(?<![\w-])[rsp]k_(?:live|test)_[A-Za-z0-9]{10,}/, // Stripe
  /(?<![\w-])gh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /(?<![\w-])github_pat_[A-Za-z0-9_]{22,}/, // GitHub fine-grained PAT
  /(?<![\w-])glpat-[A-Za-z0-9_-]{20,}/, // GitLab PAT
  /(?<![\w-])xox[abpre]-[A-Za-z0-9-]{10,}/, // Slack
  /(?<![\w-])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/, // AWS access key ID
  /(?<![\w-])AIza[0-9A-Za-z_-]{30,}/, // Google API key
  /(?<![\w-])(?:npm|hf|re|sg|pplx|gsk|xai)_[A-Za-z0-9_]{20,}/, // npm, Hugging Face, Resend, SendGrid-style, Perplexity, Groq, xAI
  /\bBearer\s+[A-Za-z0-9._~+/]{16,}[A-Za-z0-9._~+/-]*=*/i, // bearer token value
  // Header line; same unbroken-body rule as bare Bearer (`Bearer token-based-authentication` is prose).
  /\bAuthorization\s*:\s*(?:(?:Basic|Bearer|Token|Bot|Digest)\s+)?[A-Za-z0-9._~+/=-]*[A-Za-z0-9._~+/=]{16,}/i,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/, // PEM private key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
];
// Secret words in other languages: French, Spanish, German, Portuguese, Chinese, Arabic.
const FOREIGN_SECRET = "mot\\s+de\\s+passe|cl[ée](?:\\s+(?:d['’]?\\s*)?api|\\s+secr[èe]te)?|jeton|contrase[ñn]a|clave(?:\\s+(?:de\\s+)?api|\\s+secreta)?|llave|passwort|kennwort|api-schl[üu]ssel|schl[üu]ssel|zugangsschl[üu]ssel|senha|chave(?:\\s+(?:de\\s+)?api|\\s+secreta)?";
const CJK_ARABIC_SECRET = "密钥|秘钥|密匙|密码|密碼|令牌|口令|مفتاح|كلمة\\s*(?:ال)?مرور|كلمة\\s*السر|رمز";
const KEYWORD = new RegExp(`\\b(?:api[\\s_-]?key|key|keys|token|tokens|secret|secrets|password|passwd|passphrase|credential|credentials|bearer|${FOREIGN_SECRET})\\b|${CJK_ARABIC_SECRET}`, "i");
/** Words that make "key" a non-secret compound (`idempotency key`, `primary key`, …). */
const KEY_COMPOUND = /(?:idempotency|cache|caching|primary|sort|sorting|partition|foreign|composite|unique|surrogate|natural|hash|lookup|dedup|dedupe|deduplication|map|object|row|index|public|registry|translation|i18n|license|licence|music|piano|answer|house|car|door)[\s_-]+$/i;
/** Secret words that introduce a value directly (`api key: X`, `password = X`, `my token is X`). */
const INTRODUCER = new RegExp(
  "(?<![A-Za-z0-9])(api[\\s_-]?key|apikey|access[\\s_-]?key(?:[\\s_-]?id)?|secret(?:[\\s_-]?(?:access[\\s_-]?)?key)?|client[\\s_-]?secret|private[\\s_-]?key|"
  + "(?:access|auth|api|bearer|refresh|bot)?[\\s_-]?token|password|passwd|pwd|passphrase|credentials?|bearer|key|" + FOREIGN_SECRET + ")"
  + "(?:\\s*[:=]\\s*|\\s+(?:is|est|es|ist|é)\\s*[:=]?\\s*)"
  + "[\"'`“‘]?([A-Za-z0-9/+=_.-]{16,})",
  "gi");
const CJK_ARABIC_INTRODUCER = new RegExp(`(?:${CJK_ARABIC_SECRET})[\\u0600-\\u06FF]{0,3}\\s*(?:是|为|為|：|:|=|هو|هي)?\\s*["'“]?([A-Za-z0-9/+=_.-]{16,})`, "g");
const SECRET_PARAM = /^(?:api[_-]?key|apikey|key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|auth[_-]?token|secret|client[_-]?secret|password|passwd|pwd|sig|signature|x-api-key)$/i;

function entropy(token: string): number {
  const counts = new Map<string, number>();
  for (const c of token) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / token.length) * Math.log2(n / token.length);
  return bits;
}

/** `customerAccount2024BillingRegion2025`, `release_2024_q3_notes`, `PROJ-1234-backend`:
 *  made of word-sized runs. A random token breaks into many 1–2 character runs. */
function readable(token: string): boolean {
  const runs = token.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
  if (!runs.length) return true;
  const short = runs.filter(r => r.length <= 2).length;
  return token.length / runs.length >= 4 && short / runs.length <= 0.34;
}

function randomLooking(token: string, minLength: number, minEntropy: number): boolean {
  if (token.length < minLength) return false;
  if ((token.match(/[A-Za-z]/g) ?? []).length < 2 || (token.match(/\d/g) ?? []).length < 2) return false;
  const segments = token.split(/[-_=+]+/).filter(Boolean);
  if (!segments.some(s => /[A-Za-z]/.test(s) && /\d/.test(s))) return false;
  if (readable(token)) return false;
  return entropy(token) >= minEntropy;
}

const known = (text: string) => KNOWN.some(re => re.test(text));

/** True when the text contains an explicitly supported credential syntax.
 *  Runs on the raw text, before any link-code handling. */
export function knownCredentialFormat(text: string): boolean {
  if (!text) return false;
  return urlCarriesCredential(text) || known(strip(text));
}

function strip(text: string) {
  return text.replace(URL_LIKE, " ").replace(OTHER_URI, " ").replace(EMAIL, " ").replace(PLATFORM_ID, " ").replace(UUID, " ");
}

function urlCarriesCredential(text: string): boolean {
  for (const raw of text.match(URL_LIKE) ?? []) {
    let url: URL;
    try { url = new URL(raw.replace(/[).,;!?]+$/, "")); } catch { continue; }
    if (url.password) return true;
    const params = [...url.searchParams.entries(), ...new URLSearchParams(url.hash.replace(/^#/, "")).entries()];
    for (const [name, value] of params) {
      if (known(value)) return true;
      // Policy: a secret-named parameter with a 16+ character value is a bearer secret
      // (API keys, reset and magic links), whatever its alphabet.
      if (SECRET_PARAM.test(name) && value.length >= 16) return true;
    }
  }
  return false;
}

/** A secret word directly introducing one unbroken 16+ character value from the
 *  base64/hex/UUID alphabets counts regardless of the random-looking heuristics. */
function introducedSecret(text: string): boolean {
  const plain = text.replace(URL_LIKE, " ").replace(OTHER_URI, " ").replace(EMAIL, " ");
  const isValue = (raw: string) => {
    const value = raw.replace(/[.,;:!?]+$/, "");
    if (value.length < 16) return false;
    PLATFORM_ID.lastIndex = 0;
    const id = value.match(PLATFORM_ID);
    return !(id && id[0] === value);
  };
  for (const m of plain.matchAll(INTRODUCER)) {
    const word = m[1].toLowerCase();
    const before = plain.slice(0, m.index);
    // Bare "key" needs an explicit `:`/`=`/"is" and must not be a compound like "cache key".
    if (word === "key" && (KEY_COMPOUND.test(before) || !/^key(?:\s*[:=]|\s+(?:is)\b)/i.test(m[0]))) continue;
    if (isValue(m[2])) return true;
  }
  for (const m of plain.matchAll(CJK_ARABIC_INTRODUCER)) if (isValue(m[1])) return true;
  return false;
}

export function looksLikeCredential(text: string): boolean {
  if (!text) return false;
  if (knownCredentialFormat(text)) return true;
  if (LINK_CODE.test(text)) return false;
  if (introducedSecret(text)) return true;
  const rest = strip(text);
  const tokens = rest.match(/[A-Za-z0-9_+=-]+/g) ?? [];
  const lone = tokens.length === 1 && rest.trim() === tokens[0];
  const nearby = KEYWORD.test(rest);
  return tokens.some(t => {
    // Pure hex (commit SHAs, checksums) counts only next to a keyword.
    const hex = /^[0-9a-f]+$/i.test(t);
    if (lone && !nearby) return !hex && randomLooking(t, 24, 3.5);
    if (nearby) return randomLooking(t, 20, hex ? 3.0 : 3.5);
    return !hex && randomLooking(t, 32, 4.0) && /[A-Z]/.test(t) && /[a-z]/.test(t);
  });
}

/** Reply when inbound text looked like a credential. The pasted text is never echoed. */
export function credentialRejectedText(link: string | null, inlineLink = true): string {
  const head = "That message looked like a key or password, so it was not sent to your agent and was not saved. Keys are not accepted in chat. Your messaging provider may already have a copy, so rotate (revoke and replace) that key.";
  if (!link) return `${head} When your agent asks for a key, it sends a secure one-time link where you can paste it.`;
  // The link goes last, so no punctuation sticks to it when the client auto-links it.
  return `${head} Your agent is waiting for a key. Paste the new key in the secure one-time page; it works once and expires in 15 minutes.${inlineLink ? `\n${link}` : ""}`;
}
