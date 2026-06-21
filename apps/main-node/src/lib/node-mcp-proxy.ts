export const SENSITIVE_UPSTREAM_AUTH_HEADERS = ["authorization", "x-api-key"] as const;

export type NodeMcpProxyTarget = {
  upstreamUrl: string;
  upstreamToken: string;
  upstreamAuthHeader?: { name: string; value: string };
  /** URL declared on the agent snapshot; may differ when a vault credential rewrites upstreamUrl. */
  declaredServerUrl?: string;
};

export function buildNodeMcpForwardUrl(
  target: Pick<NodeMcpProxyTarget, "upstreamUrl" | "declaredServerUrl">,
  incomingUrl?: string,
): string {
  const upstream = new URL(target.upstreamUrl);
  if (!incomingUrl) return upstream.toString();

  let incoming: URL;
  let declared: URL;
  try {
    incoming = new URL(incomingUrl);
    declared = new URL(target.declaredServerUrl || target.upstreamUrl);
  } catch {
    return upstream.toString();
  }

  upstream.search = incoming.search;

  const declaredPath = normalizePath(declared.pathname);
  const incomingPath = normalizePath(incoming.pathname);
  const upstreamPath = normalizePath(upstream.pathname);

  if (incomingPath === declaredPath) return upstream.toString();

  const declaredPrefix = declaredPath === "/" ? "" : declaredPath;
  if (declaredPrefix && incomingPath.startsWith(`${declaredPrefix}/`)) {
    const suffix = incomingPath.slice(declaredPrefix.length);
    upstream.pathname = `${upstreamPath === "/" ? "" : upstreamPath}${suffix}`;
    return upstream.toString();
  }

  if (!target.declaredServerUrl || target.declaredServerUrl === target.upstreamUrl) {
    upstream.pathname = incomingPath;
  }
  return upstream.toString();
}

export async function forwardNodeMcpRequest(
  target: NodeMcpProxyTarget,
  incomingUrl: string | undefined,
  method: string,
  inboundHeaders: Headers,
  body: BodyInit | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const upstreamHeaders = new Headers(inboundHeaders);
  for (const header of SENSITIVE_UPSTREAM_AUTH_HEADERS) upstreamHeaders.delete(header);
  const authHeader = target.upstreamAuthHeader ?? {
    name: "authorization",
    value: `Bearer ${target.upstreamToken}`,
  };
  upstreamHeaders.set(authHeader.name, authHeader.value);
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("connection");
  upstreamHeaders.delete("content-length");
  upstreamHeaders.delete("x-forwarded-for");
  upstreamHeaders.delete("x-forwarded-proto");
  upstreamHeaders.delete("x-real-ip");

  return fetcher(new Request(buildNodeMcpForwardUrl(target, incomingUrl), {
    method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
  }));
}

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}
