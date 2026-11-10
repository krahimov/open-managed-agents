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

// Python for data work (pandas, bs4, ...). Kept OUT of spec.aptPackages:
// that list is part of the frozen machine config, and changing it would
// fail every existing computer with MachineConfigMismatchError. Runs on the
// snapshot path too, where python availability depends on the snapshot.
// Debian's python3 has no bare `python`, so link it when missing (a symlink,
// not `python-is-python3`, which does not exist before bullseye/focal).
//
// This runs inside acquire()'s machine lease on every wake, so it must stay
// well under LOCK_WAIT_MS (120 s): apt network waits are capped, the whole
// exec is capped at PYTHON_SETUP_TIMEOUT_SEC, and a failure is remembered in
// PYTHON_FAILED_MARKER so later wakes skip the install for
// PYTHON_RETRY_AFTER_SEC instead of blocking on an unreachable mirror again.
const PYTHON_READY_MARKER = "/var/lib/oma/python-ready";
const PYTHON_FAILED_MARKER = "/var/lib/oma/python-failed";
const PYTHON_RETRY_AFTER_SEC = 6 * 60 * 60;
const PYTHON_SETUP_TIMEOUT_SEC = 90;
const PYTHON_APT_PACKAGES = ["python3", "python3-pip", "python3-venv"];
const APT_NET_OPTS = "-o Acquire::Retries=0 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20";

/** Exported for tests. Exits non-zero on failure; the caller only warns. */
export function buildAgentComputerPythonScript(): string {
  const failed = quote(PYTHON_FAILED_MARKER);
  return [
    'as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }',
    `fail() { date +%s > ${failed} 2>/dev/null || true; exit "$1"; }`,
    `if [ -f ${quote(PYTHON_READY_MARKER)} ]; then exit 0; fi`,
    `if [ -f ${failed} ]; then`,
    `  last=$(cat ${failed} 2>/dev/null || echo 0)`,
    '  case "$last" in ""|*[!0-9]*) last=0 ;; esac',
    `  if [ $(( $(date +%s) - $last )) -lt ${PYTHON_RETRY_AFTER_SEC} ]; then exit 0; fi`,
    "fi",
    "if ! command -v python3 >/dev/null 2>&1 || ! python3 -m pip --version >/dev/null 2>&1; then",
    '  command -v apt-get >/dev/null 2>&1 || { echo "python3 is missing and apt-get is unavailable" >&2; fail 127; }',
    `  as_root env DEBIAN_FRONTEND=noninteractive apt-get ${APT_NET_OPTS} update -qq || fail 1`,
    `  as_root env DEBIAN_FRONTEND=noninteractive apt-get ${APT_NET_OPTS} install -y -qq --no-install-recommends ${PYTHON_APT_PACKAGES.join(" ")} || fail 1`,
    "fi",
    'command -v python >/dev/null 2>&1 || as_root ln -sf "$(command -v python3)" /usr/local/bin/python || fail 1',
    `rm -f ${failed}`,
    `touch ${quote(PYTHON_READY_MARKER)}`,
  ].join("\n");
}

/** Best-effort: a computer without Python is still a working computer. */
async function ensurePython(sb: DaytonaSandboxInstance): Promise<void> {
  try {
    const result = await sb.process.executeCommand(buildAgentComputerPythonScript(), undefined, undefined, PYTHON_SETUP_TIMEOUT_SEC);
    if (result.exitCode !== 0) {
      console.warn("[agent-computer] python setup failed; continuing without it", {
        sandboxId: sb.id, exitCode: result.exitCode, output: (result.result ?? "").slice(-1000),
      });
    }
  } catch (err) {
    console.warn("[agent-computer] python setup failed; continuing without it", { sandboxId: sb.id, error: String(err) });
  }
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
  await ensurePython(sb);
  if (spec.desktop) {
    if (!sb.computerUse) throw new Error("Daytona SDK does not support desktop control");
    console.info("[agent-computer] starting Daytona desktop", { sandboxId: sb.id });
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
    headers: { "x-daytona-preview-token": preview.token, "X-Daytona-Skip-Preview-Warning": "true" },
    generation,
    downloadsPath: `${workdir}/downloads`,
  };
}
