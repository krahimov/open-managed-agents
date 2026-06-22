export function withSessionProxyContext(
  proxyUrl: string,
  opts?: { tenantId: string; sessionId: string },
): string {
  if (!opts?.tenantId || !opts.sessionId) return proxyUrl;
  try {
    const url = new URL(proxyUrl);
    url.username = "oma";
    url.password = Buffer.from(`${opts.tenantId}|${opts.sessionId}`, "utf8").toString("base64url");
    return url.toString();
  } catch {
    return proxyUrl;
  }
}
