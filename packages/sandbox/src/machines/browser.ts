import { createHash } from "node:crypto";
import type { DaytonaSandboxInstance } from "../adapters/daytona-types";
import type { SandboxBrowserEndpoint } from "../ports";
import type { AgentMachineSpec } from "./ports";

export const AGENT_BROWSER_PORT = 9222;
export const AGENT_BROWSER_PREVIEW_PORT = 9223;
const BROWSER_DIR = "/var/lib/oma/browser";
const START_SCRIPT = `${BROWSER_DIR}/start.sh`;

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Chromium only accepts a loopback Host header. Daytona's preview keeps
// the public hostname, so a local proxy rewrites it for HTTP and websocket
// handshakes. Authentication remains at Daytona's PRIVATE preview edge.
// Never use a signed URL or make the sandbox public for this service.
export const AGENT_BROWSER_PROXY_SCRIPT = String.raw`
const http = require('node:http');
const upstreamPort = Number(process.env.OMA_CDP_PORT || 9222);
const listenPort = Number(process.env.OMA_CDP_PROXY_PORT || 9223);
function options(req) {
  const headers = { ...req.headers, host: '127.0.0.1:' + upstreamPort };
  delete headers.origin;
  delete headers['x-daytona-preview-token'];
  delete headers.authorization;
  return { hostname: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers };
}
const server = http.createServer((req, res) => {
  const upstream = http.request(options(req), (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  const upstream = http.request(options(req));
  upstream.on('upgrade', (response, remote, remoteHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      Object.entries(response.headers).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    remote.on('error', () => socket.destroy());
    socket.on('error', () => remote.destroy());
    socket.on('close', () => remote.destroy());
    remote.on('close', () => socket.destroy());
    socket.pipe(remote).pipe(socket);
  });
  upstream.on('response', (response) => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  upstream.end();
});
server.listen(listenPort, '0.0.0.0');
`;

/** Exported for shell syntax checks and a real local Chromium smoke test. */
export function buildAgentBrowserStartScript(desktop = false): string {
  return [
    "#!/bin/sh",
    "set -eu",
    ...(desktop ? ['display_socket="$(find /tmp/.X11-unix -name "X*" -type s | head -n 1)"', '[ -n "$display_socket" ] || { echo "Daytona desktop display is not ready" >&2; exit 1; }', 'export DISPLAY=":${display_socket##*/X}"'] : []),
    `mkdir -p ${quote(BROWSER_DIR)}`,
    // flock serializes concurrent sessions connecting after a stop/start.
    `exec 9>${quote(`${BROWSER_DIR}/start.lock`)}`,
    "flock -w 45 9",
    `if ! curl -fsS --max-time 2 http://127.0.0.1:${AGENT_BROWSER_PORT}/json/version >/dev/null 2>&1; then`,
    '  browser_bin="$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)"',
    '  if [ -z "$browser_bin" ]; then echo "Chromium is not installed in the agent computer" >&2; exit 127; fi',
    `  nohup "$browser_bin" ${desktop ? "--start-maximized" : "--headless=new"} --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-renderer-backgrounding --remote-debugging-address=127.0.0.1 --remote-debugging-port=${AGENT_BROWSER_PORT} --user-data-dir=${quote(`${BROWSER_DIR}/profile`)} --restore-last-session about:blank >${quote(`${BROWSER_DIR}/chromium.log`)} 2>&1 </dev/null 9>&- &`,
    "fi",
    // The proxy can survive a Chromium crash; checking its upstream would
    // wrongly launch a duplicate proxy while Chromium is still starting.
    `if ! node -e 'const s=require("node:net").connect(${AGENT_BROWSER_PREVIEW_PORT}, "127.0.0.1"); s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));s.setTimeout(2000,()=>process.exit(1));'; then`,
    `  nohup node ${quote(`${BROWSER_DIR}/proxy.cjs`)} >${quote(`${BROWSER_DIR}/proxy.log`)} 2>&1 </dev/null 9>&- &`,
    "fi",
    "attempt=0",
    `until curl -fsS --max-time 2 http://127.0.0.1:${AGENT_BROWSER_PREVIEW_PORT}/json/version >/dev/null 2>&1; do`,
    "  attempt=$((attempt + 1))",
    `  if [ "$attempt" -ge 40 ]; then tail -n 30 ${quote(`${BROWSER_DIR}/chromium.log`)} ${quote(`${BROWSER_DIR}/proxy.log`)} >&2; exit 1; fi`,
    "  sleep 1",
    "done",
    "",
  ].join("\n");
}

async function execute(sb: DaytonaSandboxInstance, command: string, timeoutSec: number): Promise<string> {
  const result = await sb.process.executeCommand(command, undefined, undefined, timeoutSec);
  if (result.exitCode !== 0) {
    throw new Error(`Agent computer bootstrap failed (exit ${result.exitCode}): ${result.result.slice(-4000)}`);
  }
  return result.artifacts?.stdout ?? result.result;
}

/** Install tools once, but run the browser startup check on EVERY restart. */
export async function bootstrapAgentComputer(sb: DaytonaSandboxInstance, spec: AgentMachineSpec): Promise<void> {
  if (spec.browser && (sb as DaytonaSandboxInstance & { public?: boolean }).public === true) {
    throw new Error("Agent computer browser requires a private Daytona sandbox");
  }
  const packages = [...new Set([
    ...(spec.bootstrapTools ? spec.aptPackages : []),
    ...(spec.browser ? ["chromium", "nodejs", "curl", "ca-certificates", "util-linux", "fonts-liberation"] : []),
    ...(spec.desktop && spec.provider === "modal" ? ["scrot", "websockify", "x11-utils"] : []),
    ...(spec.desktop ? ["xvfb", "xfce4", "xfce4-terminal", "x11vnc", "novnc", "dbus-x11", "xauth", "xdotool"] : []),
  ])];
  // The marker is outside /workspace, so workspace restores cannot falsely
  // mark tools as installed in a newly created machine.
  const hash = createHash("sha256").update(JSON.stringify(packages)).digest("hex").slice(0, 16);
  const marker = `/var/lib/oma/tools-${hash}`;
  // Native snapshots execute toolbox commands as `daytona`, even when the
  // sandbox API reports user=root. Give that user the app-owned directories.
  const directories = [spec.workdir, '/var/lib/oma', '/mnt/sessions', '/mnt/memory', '/mnt/session'].map(quote).join(' ');
  const prepare = [
    'set -eu',
    'as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }',
    `as_root mkdir -p ${directories}`,
    `as_root chown "$(id -u):$(id -g)" ${directories}`,
  ];
  const commands = [...prepare];
  if (packages.length) {
    commands.push(
      `if [ ! -f ${quote(marker)} ]; then`,
      '  command -v apt-get >/dev/null || { echo "Agent computer bootstrap requires a Debian-compatible image or a prebuilt snapshot" >&2; exit 127; }',
      "  as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq",
      `  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${packages.map(quote).join(" ")}`,
      `  touch ${quote(marker)}`,
      "fi",
    );
  }
  // Native snapshots already contain desktop packages. Custom images install
  // the documented dependencies before calling Daytona's process supervisor.
  if (spec.snapshot && !spec.bootstrapTools) {
    await execute(sb, prepare.join('\n'), 30);
  } else {
    await execute(sb, commands.join("\n"), 600);
  }
  if (spec.desktop) {
    if (!sb.computerUse) throw new Error("Daytona SDK does not support desktop control");
    console.info("[agent-computer] starting desktop", { sandboxId: sb.id });
    await sb.computerUse.start();
  }
  if (!spec.browser) return;
  await execute(sb, `mkdir -p ${quote(BROWSER_DIR)} ${quote(`${spec.workdir}/downloads`)}`, 30);
  await sb.fs.uploadFile(Buffer.from(AGENT_BROWSER_PROXY_SCRIPT), `${BROWSER_DIR}/proxy.cjs`);
  await sb.fs.uploadFile(Buffer.from(buildAgentBrowserStartScript(spec.desktop === true)), START_SCRIPT);
  await execute(sb, `sh ${quote(START_SCRIPT)}`, 90);
}

/** Resolve fresh preview auth and websocket path after restart/recreation. */
export async function resolveAgentComputerBrowser(sb: DaytonaSandboxInstance, generation: number, workdir = "/workspace"): Promise<SandboxBrowserEndpoint> {
  if ((sb as DaytonaSandboxInstance & { public?: boolean }).public === true) {
    throw new Error("Agent computer browser requires a private Daytona sandbox");
  }
  await execute(sb, `sh ${quote(START_SCRIPT)}`, 90);
  const raw = await execute(sb, `curl -fsS --max-time 5 http://127.0.0.1:${AGENT_BROWSER_PORT}/json/version`, 10);
  let localUrl: URL;
  try {
    localUrl = new URL((JSON.parse(raw) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
    if (!/^wss?:$/.test(localUrl.protocol) || !/^\/devtools\/browser\/[^/]+$/.test(localUrl.pathname)) throw new Error("invalid CDP path");
  } catch {
    throw new Error("Agent computer Chromium returned an invalid CDP endpoint");
  }
  const preview = await sb.getPreviewLink(AGENT_BROWSER_PREVIEW_PORT);
  if (!preview.token) throw new Error("Daytona browser preview is missing its authentication token");
  const base = new URL(preview.url);
  if (base.protocol !== "https:") throw new Error("Daytona browser preview must use HTTPS");
  const ws = new URL(localUrl.pathname, base);
  ws.protocol = "wss:";
  return {
    httpUrl: base.href.replace(/\/$/, ""),
    wsUrl: ws.href,
    headers: preview.headers ?? { "x-daytona-preview-token": preview.token, "X-Daytona-Skip-Preview-Warning": "true" },
    generation,
    downloadsPath: `${workdir}/downloads`,
  };
}
