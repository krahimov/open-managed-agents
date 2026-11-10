/**
 * True when `url` points at our own /v1/oauth/* (or CF's /v1/oma/oauth/*)
 * routes. Chat Markdown is untrusted text — an agent can be prompt-injected
 * into writing "[Open the report](/v1/oauth/authorize?mcp_server_url=…)" —
 * and a click on it is a same-origin navigation. The server makes such a
 * start show a confirm page; the renderer additionally never makes one a
 * live link or image.
 */
export function isOwnOAuthUrl(url: string, origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (parsed.origin !== new URL(origin).origin) return false;
  let path = parsed.pathname;
  try {
    // %6Fauth etc. — the server router decodes before matching.
    path = decodeURIComponent(path);
  } catch {
    // Malformed escapes: match on the raw path.
  }
  return /^\/+v1\/+(?:oma\/+)?oauth(?:\/|$)/i.test(path);
}
