import { getClerkBearerToken } from "./clerk-auth";

/**
 * Open the MCP OAuth popup for `/v1/oauth/authorize?<params>`.
 *
 * /authorize only starts a flow straight away when it carries a one-time
 * `oauth_confirm` token (anything else, including same-origin links, gets a
 * confirm page — see packages/http-routes/src/oauth-initiator.ts). The popup
 * opens synchronously (popup blockers), then the token is minted with a
 * fetch and the popup is pointed at the authorize URL carrying it. If the
 * mint fails the popup still goes to /authorize and the user sees the
 * confirm page instead of a dead window.
 *
 * Returns the popup, or null when the browser blocked it.
 */
export function openOAuthPopup(
  params: URLSearchParams,
  name: string,
  features = "width=600,height=700,popup=yes",
): Window | null {
  const popup = window.open("", name, features);
  if (!popup) return null;
  const query = params.toString();
  void (async () => {
    let url = `/v1/oauth/authorize?${query}`;
    try {
      const token = await mintStartToken(query);
      if (token) url += `&oauth_confirm=${encodeURIComponent(token)}`;
    } catch {
      // Fall through to the confirm page.
    }
    if (!popup.closed) popup.location.href = url;
  })();
  return popup;
}

async function mintStartToken(query: string): Promise<string | null> {
  const clerkToken = await getClerkBearerToken();
  const res = await fetch("/v1/oauth/start-token", {
    method: "POST",
    credentials: "include",
    // No x-active-tenant on purpose: the popup's navigation can't send it,
    // so the token must be minted under the tenant that navigation resolves.
    headers: {
      "content-type": "application/json",
      ...(clerkToken ? { authorization: `Bearer ${clerkToken}` } : {}),
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  return typeof body?.token === "string" ? body.token : null;
}
