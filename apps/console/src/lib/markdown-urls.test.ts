import { expect, it } from "vitest";
import { isOwnOAuthUrl } from "./markdown-urls";

const origin = "https://orrery.example";

it("flags links and images that would start an OAuth flow on our origin", () => {
  for (const url of [
    "/v1/oauth/authorize?mcp_server_url=https://evil.example/mcp&new_vault_name=r",
    "https://orrery.example/v1/oauth/authorize?x=1",
    "//orrery.example/v1/oauth/authorize",
    "/v1/oma/oauth/authorize",
    "/V1/OAuth/authorize",
    "/v1/%6Fauth/authorize",
    "/v1//oauth/authorize",
    "\\v1\\oauth\\authorize",
    "v1/oauth/authorize",
    "/v1/oauth",
  ]) {
    expect(isOwnOAuthUrl(url, origin), url).toBe(true);
  }
});

it("leaves ordinary links alone", () => {
  for (const url of [
    "https://github.com/login/oauth/authorize",
    "https://other.example/v1/oauth/authorize",
    "/v1/sessions/s1",
    "/v1/oauthx",
    "/sessions/s1?next=/v1/oauth/authorize",
    "sandbox:/mnt/session/outputs/report.md",
    "report.md",
  ]) {
    expect(isOwnOAuthUrl(url, origin), url).toBe(false);
  }
});
