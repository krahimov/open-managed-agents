// The fetch behind web_fetch: a URL the model chose, requested from the API
// server's own network. It must never reach a private destination, on the
// first hop or after a redirect.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { createPublicFetch, PublicFetchBlockedError, PublicFetchTooLargeError } from "../src/lib/public-fetch.js";

// One local server stands in for both a public site and an internal one.
// The resolver below gives them different addresses; the test's `isPrivate`
// calls only the second one private.
let server: http.Server;
let port = 0;
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.headers.host} ${req.url}`);
    const url = req.url ?? "/";
    if (url === "/page") return void res.writeHead(200, { "content-type": "text/html" }).end("<h1>public</h1>");
    if (url === "/secret") return void res.writeHead(200).end("INTERNAL-SECRET");
    if (url === "/to-page") return void res.writeHead(302, { location: "/page" }).end();
    if (url === "/to-internal") return void res.writeHead(302, { location: `http://internal.test:${port}/secret` }).end();
    if (url === "/to-metadata") return void res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (url === "/to-other") return void res.writeHead(302, { location: `http://other.test:${port}/page` }).end();
    if (url === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
    if (url === "/gzip") {
      return void res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" }).end(zlib.gzipSync("zipped body"));
    }
    if (url === "/big") return void res.writeHead(200).end("x".repeat(5000));
    if (url === "/headers") return void res.writeHead(200).end(JSON.stringify(req.headers));
    if (url === "/to-headers") return void res.writeHead(302, { location: `http://other.test:${port}/headers` }).end();
    if (url === "/bad-gzip") return void res.writeHead(200, { "content-encoding": "gzip" }).end("not gzip at all");
    res.writeHead(404).end("no");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const INTERNAL = "127.0.0.9";
const fetcher = (extra: Parameters<typeof createPublicFetch>[0] = {}) =>
  createPublicFetch({
    resolve: (hostname, callback) => {
      const address = hostname === "internal.test" ? INTERNAL : hostname.endsWith(".test") ? "127.0.0.1" : null;
      if (!address) return callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), []);
      callback(null, [{ address, family: 4 }]);
    },
    isPrivate: (ip) => ip === INTERNAL || ip === "169.254.169.254",
    ...extra,
  });

describe("createPublicFetch", () => {
  it("fetches a public page and follows a redirect to another public page", async () => {
    const res = await fetcher()(`http://public.test:${port}/to-page`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>public</h1>");
    expect(res.url).toBe(`http://public.test:${port}/page`);
    expect(res.headers.get("content-type")).toBe("text/html");
  });

  it("refuses a hostname that resolves to a private address, before any request is sent", async () => {
    hits.length = 0;
    await expect(fetcher()(`http://internal.test:${port}/secret`)).rejects.toThrow(/private or reserved address/);
    expect(hits).toEqual([]);
  });

  it("refuses a redirect to a private destination, by name or by address", async () => {
    hits.length = 0;
    await expect(fetcher()(`http://public.test:${port}/to-internal`)).rejects.toMatchObject({
      name: "PublicFetchBlockedError",
      code: "private_address",
    });
    await expect(fetcher()(`http://public.test:${port}/to-metadata`)).rejects.toBeInstanceOf(PublicFetchBlockedError);
    // Only the two public hops were ever requested.
    expect(hits.map((h) => h.split(" ")[1])).toEqual(["/to-internal", "/to-metadata"]);
  });

  it("with the real address rules: no loopback, private ranges, link-local metadata, or other schemes", async () => {
    const real = createPublicFetch();
    for (const url of [
      `http://127.0.0.1:${port}/secret`,
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fd00::1]/",
      `http://localhost:${port}/secret`,
    ]) {
      await expect(real(url), url).rejects.toBeInstanceOf(PublicFetchBlockedError);
    }
    await expect(real("file:///etc/passwd")).rejects.toThrow(/only http and https/);
    await expect(real("not a url")).rejects.toThrow(/invalid URL/);
  });

  it("applies the caller's host rule to every hop, so a redirect cannot leave the allowed hosts", async () => {
    const hostAllowed = (host: string) => host === "public.test";
    expect((await fetcher()(`http://public.test:${port}/to-page`, { hostAllowed })).status).toBe(200);
    await expect(fetcher()(`http://public.test:${port}/to-other`, { hostAllowed })).rejects.toMatchObject({
      message: expect.stringMatching(/other\.test is not allowed/),
      code: "host_not_allowed",
    });
    await expect(fetcher()(`http://other.test:${port}/page`, { hostAllowed })).rejects.toThrow(/not allowed/);
  });

  it("gives the caller's host rule the host as URL.hostname spells it, brackets and all", async () => {
    const seen: string[] = [];
    const hostAllowed = (host: string) => (seen.push(host), false);
    await expect(createPublicFetch()("http://[2001:db8::1]/", { hostAllowed })).rejects.toMatchObject({ code: "host_not_allowed" });
    expect(seen).toEqual([new URL("http://[2001:db8::1]/").hostname]);
  });

  it("sends only the page-reading headers, to every hop", async () => {
    const res = await fetcher()(`http://public.test:${port}/to-headers`, {
      headers: { "User-Agent": "OMA-Agent/1.0", Accept: "text/html", Authorization: "Bearer secret", Cookie: "s=1" },
    });
    const sent = (await res.json()) as Record<string, string>;
    expect(sent["user-agent"]).toBe("OMA-Agent/1.0");
    expect(sent.accept).toBe("text/html");
    expect(sent.authorization).toBeUndefined();
    expect(sent.cookie).toBeUndefined();
  });

  it("stops a redirect loop and decodes gzip", async () => {
    await expect(fetcher()(`http://public.test:${port}/loop`)).rejects.toThrow(/too many redirects/);
    expect(await (await fetcher()(`http://public.test:${port}/gzip`)).text()).toBe("zipped body");
  });

  it("a page over the size limit is an error, never a document cut short and passed off as whole", async () => {
    await expect(fetcher({ maxBytes: 100 })(`http://public.test:${port}/big`)).rejects.toBeInstanceOf(PublicFetchTooLargeError);
    expect((await (await fetcher({ maxBytes: 5000 })(`http://public.test:${port}/big`)).text()).length).toBe(5000);
  });

  it("a body that does not decode, or a cancelled request, rejects instead of hanging", async () => {
    await expect(fetcher()(`http://public.test:${port}/bad-gzip`)).rejects.toThrow();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(fetcher()(`http://public.test:${port}/page`, { signal: cancelled.signal })).rejects.toThrow();
  });

  it("allowPrivate (local development) lifts the address checks only", async () => {
    const dev = createPublicFetch({ allowPrivate: true });
    expect(await (await dev(`http://127.0.0.1:${port}/secret`)).text()).toBe("INTERNAL-SECRET");
    await expect(dev("file:///etc/passwd")).rejects.toThrow(/only http and https/);
  });
});

// The wiring: on Node, web_fetch downloads with the guarded fetch and never
// with the global one.
describe("web_fetch downloads through the guarded fetch", () => {
  const agent = {
    id: "agent_wf", name: "wf", model: "claude-sonnet-4-6", system: "",
    tools: [{ type: "agent_toolset_20260401" }], version: 1, created_at: new Date().toISOString(),
  } as never;
  const toMarkdown = async (files: Array<{ name: string; blob: Blob }>) =>
    Promise.all(files.map(async (f) => ({ name: f.name, format: "markdown", data: `MD:${await f.blob.text()}` })));
  const opts = { toolCallId: "t1", messages: [] } as never;

  it("passes the environment's allowed hosts along, so redirects are held to them too", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("global fetch must not be used"));
    const sandboxCommands: string[] = [];
    const sandbox = { exec: async (cmd: string) => { sandboxCommands.push(cmd); return "exit=0\nraw"; }, readFile: async () => "", writeFile: async () => "ok" } as never;
    const seen: Array<{ url: string; hostAllowed?: (h: string) => boolean }> = [];
    const webFetch = vi.fn(async (url: string, init: { hostAllowed?: (h: string) => boolean }) => {
      seen.push({ url, hostAllowed: init.hostAllowed });
      return new Response("<p>hello</p>", { status: 200, headers: { "content-type": "text/html" } });
    });
    try {
      const { buildTools } = await import("@open-managed-agents/agent/harness/tools");
      const tools = await buildTools(agent, sandbox, {
        toMarkdown: toMarkdown as never,
        webFetch,
        environmentConfig: { networking: { type: "limited", allowed_hosts: ["docs.example.com"] } },
      });
      const out = await (tools.web_fetch as any).execute({ url: "https://docs.example.com/a" }, opts);
      expect(JSON.stringify(out)).toContain("MD:<p>hello</p>");
      expect(seen[0].url).toBe("https://docs.example.com/a");
      expect(seen[0].hostAllowed!("docs.example.com")).toBe(true);
      expect(seen[0].hostAllowed!("api.docs.example.com")).toBe(true);
      expect(seen[0].hostAllowed!("internal.railway.internal")).toBe(false);
      expect(globalFetch).not.toHaveBeenCalled();
      expect(sandboxCommands).toEqual([]);
    } finally {
      globalFetch.mockRestore();
    }
  });

  const run = async (
    url: string,
    opts2: { remote: boolean; webFetch: any; environmentConfig?: any; abortSignal?: AbortSignal },
  ) => {
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("global fetch must not be used"));
    const sandboxCommands: string[] = [];
    const sandbox = {
      exec: async (cmd: string) => { sandboxCommands.push(cmd); return "exit=0\nfrom the sandbox"; },
      readFile: async () => "", writeFile: async () => "ok",
      // Only a sandbox with a network of its own (Daytona) reports this.
      ...(opts2.remote ? { sandboxCapabilities: () => ({ scope: "session" }) } : {}),
    } as never;
    try {
      const { buildTools } = await import("@open-managed-agents/agent/harness/tools");
      const tools = await buildTools(agent, sandbox, {
        toMarkdown: toMarkdown as never, webFetch: opts2.webFetch, environmentConfig: opts2.environmentConfig,
      });
      const settled = await (tools.web_fetch as any)
        .execute({ url }, { ...(opts as object), abortSignal: opts2.abortSignal })
        .then((value: unknown) => ({ value: JSON.stringify(value) }), (error: Error) => ({ error }));
      expect(globalFetch).not.toHaveBeenCalled();
      return { ...settled, sandboxCommands } as { value?: string; error?: Error; sandboxCommands: string[] };
    } finally {
      globalFetch.mockRestore();
    }
  };

  it("a private address is not fetched from this process; a sandbox with its own network may try it", async () => {
    const out = await run("http://169.254.169.254/latest/meta-data/", { remote: true, webFetch: createPublicFetch() });
    expect(out.value).toContain("from the sandbox");
    expect(out.sandboxCommands).toHaveLength(1);
    expect(out.sandboxCommands[0]).toContain("curl");
  });

  it("…but a local-subprocess sandbox shares this host's network, so there the refusal is final", async () => {
    const out = await run("http://169.254.169.254/latest/meta-data/", { remote: false, webFetch: createPublicFetch() });
    expect(out.value).toContain("private or reserved address");
    expect(out.sandboxCommands).toEqual([]);
  });

  it("a redirect out of the environment's allowed hosts is final everywhere: curl would just follow it", async () => {
    const out = await run(`http://public.test:${port}/to-other`, {
      remote: true,
      webFetch: fetcher(),
      environmentConfig: { networking: { type: "limited", allowed_hosts: ["public.test"] } },
    });
    expect(out.value).toContain("other.test is not allowed");
    expect(out.sandboxCommands).toEqual([]);
  });

  it("a page over the size limit falls back to the sandbox, which returns only its head", async () => {
    const out = await run(`http://public.test:${port}/big`, { remote: true, webFetch: fetcher({ maxBytes: 100 }) });
    expect(out.value).toContain("from the sandbox");
    expect(out.sandboxCommands[0]).toContain("head -c");
  });

  it("a cancelled call stops: no download is finished and no fallback is started", async () => {
    const cancel = new AbortController();
    let sawSignal: AbortSignal | undefined;
    const webFetch = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        sawSignal = init.signal;
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(() => cancel.abort(), 10);
      });
    const out = await run(`http://public.test:${port}/page`, { remote: true, webFetch, abortSignal: cancel.signal });
    expect(sawSignal?.aborted).toBe(true);
    expect(out.error).toBeInstanceOf(Error);
    expect(out.sandboxCommands).toEqual([]);
  });
});
