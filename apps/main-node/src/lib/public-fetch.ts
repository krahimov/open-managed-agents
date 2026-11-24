// A fetch for URLs a model chose (the web_fetch tool), made from THIS
// process. An agent's session tools mostly run on its sandbox, but web_fetch
// downloads the page here so the markdown converter can read it. Left
// unguarded, a prompt-injected agent could read anything this server can
// reach and the public internet cannot: the private network next to the
// database, the cloud metadata address, localhost.
//
// So every hop is checked:
//   - http(s) only;
//   - an IP-literal host must be a public address;
//   - a hostname is resolved by a guarded lookup at CONNECT time, and the
//     connection is refused if any address it resolves to is private or
//     reserved (checking before connecting is not enough: the name could
//     resolve differently a moment later);
//   - redirects are followed by hand, and each one is checked the same way,
//     including the caller's own host rule (an environment's allowed hosts).
//
// WEBHOOKS_ALLOW_PRIVATE=1 is the local-dev escape hatch, as for the other
// user-supplied URLs (webhooks.ts publicUrlAllowed).

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { isPrivateOrReservedIp } from "@open-managed-agents/shared";

/** Why a fetch was not made. Read by the web_fetch tool (by `code`, across
 *  the package boundary) to decide whether another route may be tried. */
export type PublicFetchRefusal = "invalid_url" | "scheme" | "host_not_allowed" | "private_address";

export class PublicFetchBlockedError extends Error {
  constructor(
    message: string,
    readonly code: PublicFetchRefusal,
  ) {
    super(message);
    this.name = "PublicFetchBlockedError";
  }
}

/** The page is larger than this fetch keeps. Never a silently cut document. */
export class PublicFetchTooLargeError extends Error {
  readonly code = "too_large";
  constructor(maxBytes: number) {
    super(`the response is larger than ${maxBytes} bytes`);
    this.name = "PublicFetchTooLargeError";
  }
}

/** Request headers a caller may set. They are sent to every hop, so nothing
 *  that identifies or authorises the caller to one origin belongs here. */
const FORWARDED_HEADERS = new Set(["accept", "accept-language", "user-agent"]);

export interface PublicFetchInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** The caller's own rule for which hosts may be read, applied to every
   *  hop. A redirect to a host it refuses is not followed. Given
   *  `URL.hostname` as is (an IPv6 literal keeps its brackets), so the
   *  caller's rule sees the same spelling here as when it checks a URL
   *  itself. */
  hostAllowed?: (hostname: string) => boolean;
}

export type PublicFetch = (url: string, init?: PublicFetchInit) => Promise<Response>;

type Resolve = (
  hostname: string,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface PublicFetchOptions {
  /** Skip the private-address checks (local development). */
  allowPrivate?: boolean;
  maxRedirects?: number;
  /** Largest (decoded) body accepted; a larger one is an error. */
  maxBytes?: number;
  /** Test seams. */
  resolve?: Resolve;
  isPrivate?: (ip: string) => boolean;
}

const systemResolve: Resolve = (hostname, callback) =>
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => callback(err, addresses ?? []));

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export function createPublicFetch(options: PublicFetchOptions = {}): PublicFetch {
  const allowPrivate = options.allowPrivate ?? false;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
  const resolve = options.resolve ?? systemResolve;
  const isPrivate = options.isPrivate ?? isPrivateOrReservedIp;

  // `lookup` for the socket: what it returns is what gets dialled, so this
  // is where a name that resolves to a private address is stopped.
  const guardedLookup = ((
    hostname: string,
    lookupOptions: { all?: boolean } | number | undefined,
    callback: (...args: unknown[]) => void,
  ) => {
    resolve(hostname, (err, addresses) => {
      if (err) return callback(err);
      if (addresses.length === 0) return callback(new Error(`no addresses for ${hostname}`));
      const bad = allowPrivate ? undefined : addresses.find((a) => isPrivate(a.address));
      if (bad) {
        return callback(
          new PublicFetchBlockedError(
            `${hostname} resolves to a private or reserved address (${bad.address})`,
            "private_address",
          ),
        );
      }
      if (typeof lookupOptions === "object" && lookupOptions?.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  }) as unknown as LookupFunction;

  const checkHop = (url: URL, init: PublicFetchInit | undefined) => {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new PublicFetchBlockedError(`only http and https URLs can be fetched (${url.protocol})`, "scheme");
    }
    if (init?.hostAllowed && !init.hostAllowed(url.hostname)) {
      throw new PublicFetchBlockedError(`host ${url.hostname} is not allowed in this environment`, "host_not_allowed");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && isIP(host) && isPrivate(host)) {
      throw new PublicFetchBlockedError(`${host} is a private or reserved address`, "private_address");
    }
  };

  const requestOnce = (url: URL, init: PublicFetchInit | undefined) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolveResponse, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const req = transport.request(
        url.toString(),
        {
          method: "GET",
          headers: {
            "accept-encoding": "gzip, deflate, br",
            ...Object.fromEntries(
              Object.entries(init?.headers ?? {}).filter(([name]) => FORWARDED_HEADERS.has(name.toLowerCase())),
            ),
          },
          lookup: guardedLookup,
          signal: init?.signal,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          // A redirect's body is never read: drop the connection with it.
          if (status >= 300 && status < 400 && res.headers.location) {
            res.destroy();
            return resolveResponse({ status, headers: res.headers, body: Buffer.alloc(0) });
          }
          const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
          const decoded =
            encoding === "gzip" || encoding === "x-gzip"
              ? res.pipe(zlib.createGunzip())
              : encoding === "deflate"
                ? res.pipe(zlib.createInflate())
                : encoding === "br"
                  ? res.pipe(zlib.createBrotliDecompress())
                  : res;
          const chunks: Buffer[] = [];
          let size = 0;
          let done = false;
          // Any failure tears down both the response and its decoder.
          const failWith = (err: Error) => {
            if (done) return;
            done = true;
            res.destroy();
            if (decoded !== res) decoded.destroy();
            req.destroy();
            reject(err);
          };
          decoded.on("data", (chunk: Buffer) => {
            if (done) return;
            size += chunk.length;
            if (size > maxBytes) return failWith(new PublicFetchTooLargeError(maxBytes));
            chunks.push(chunk);
          });
          decoded.on("end", () => {
            if (done) return;
            done = true;
            resolveResponse({ status, headers: res.headers, body: Buffer.concat(chunks) });
          });
          decoded.on("error", failWith);
          res.on("error", failWith);
        },
      );
      req.on("error", reject);
      req.end();
    });

  return async (rawUrl, init) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new PublicFetchBlockedError("invalid URL", "invalid_url");
    }
    for (let hop = 0; ; hop++) {
      checkHop(url, init);
      const res = await requestOnce(url, init);
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= maxRedirects) throw new Error(`too many redirects (${maxRedirects})`);
        url = new URL(location, url);
        continue;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        // The body below is already decoded and may be cut short.
        if (value === undefined || name === "content-encoding" || name === "content-length") continue;
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
      }
      const status = res.status >= 200 && res.status <= 599 ? res.status : 502;
      const response = new Response(NULL_BODY_STATUS.has(status) ? null : new Uint8Array(res.body), { status, headers });
      Object.defineProperty(response, "url", { value: url.toString() });
      return response;
    }
  };
}
