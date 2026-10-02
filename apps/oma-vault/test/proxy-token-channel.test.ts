// Verifies the transport the signed session token rides on: mockttp strips
// Proxy-Authorization before handlers see a request (and for HTTPS it's only
// on the CONNECT), so the token travels as mockttp "socket metadata" and
// surfaces as req.tags. This test drives a real mockttp proxy the same way
// curl does with HTTP(S)_PROXY=http://metadata:<pw>@host:port.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import tls from "node:tls";
import { getLocal, generateCACertificate, type Mockttp } from "mockttp";
import {
  deriveProxyTokenKey,
  extractProxyTokenFromTags,
  proxyAuthCredentials,
  signProxyToken,
  verifyProxyToken,
} from "@open-managed-agents/vault-forward/proxy-token";

const key = deriveProxyTokenKey("test-root-secret");
let proxy: Mockttp;
let caCert: string;
const seen: string[][] = [];

beforeAll(async () => {
  const ca = await generateCACertificate({ subject: { commonName: "test CA" } });
  caCert = ca.cert;
  proxy = getLocal({ https: { cert: ca.cert, key: ca.key }, recordTraffic: false });
  await proxy.forAnyRequest().thenCallback((req) => {
    seen.push(req.tags);
    const extracted = extractProxyTokenFromTags(req.tags);
    const verified = extracted.kind === "token" ? verifyProxyToken(key, extracted.token) : null;
    return {
      statusCode: 200,
      json: { session: verified && verified.ok ? verified.identity.sessionId : null },
    };
  });
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
});

function proxyAuthHeader(token: string): string {
  const { username, password } = proxyAuthCredentials(token);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("proxy token transport through mockttp", () => {
  it("plain-http absolute-form requests expose the token via req.tags", async () => {
    const token = signProxyToken(key, { tenantId: "tn_a", sessionId: "sess_http" });
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        method: "GET",
        path: "http://example.invalid/x",
        headers: { host: "example.invalid", "proxy-authorization": proxyAuthHeader(token) },
      });
      req.on("response", (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(b));
      });
      req.on("error", reject);
      req.end();
    });
    expect(JSON.parse(body)).toEqual({ session: "sess_http" });
  });

  it("HTTPS CONNECT tunnels carry the token to every tunnelled request", async () => {
    const token = signProxyToken(key, { tenantId: "tn_a", sessionId: "sess_tls" });
    const body = await new Promise<string>((resolve, reject) => {
      const connectReq = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        method: "CONNECT",
        path: "example.invalid:443",
        headers: { "proxy-authorization": proxyAuthHeader(token) },
      });
      connectReq.on("connect", (_res, socket) => {
        const secure = tls.connect({ socket, servername: "example.invalid", ca: caCert }, () => {
          secure.write("GET /y HTTP/1.1\r\nHost: example.invalid\r\nConnection: close\r\n\r\n");
        });
        let raw = "";
        secure.on("data", (c) => (raw += c.toString()));
        secure.on("end", () => resolve(raw.slice(raw.indexOf("\r\n\r\n") + 4)));
        secure.on("error", reject);
      });
      connectReq.on("error", reject);
      connectReq.end();
    });
    expect(body).toContain(`"session":"sess_tls"`);
  });

  it("an unsigned legacy base64 identity is not accepted", async () => {
    const forged = Buffer.from("tn_a|sess_victim").toString("base64url");
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        method: "GET",
        path: "http://example.invalid/z",
        headers: {
          host: "example.invalid",
          "proxy-authorization": `Basic ${Buffer.from(`oma:${forged}`).toString("base64")}`,
        },
      });
      req.on("response", (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(b));
      });
      req.on("error", reject);
      req.end();
    });
    expect(JSON.parse(body)).toEqual({ session: null });
  });
});
