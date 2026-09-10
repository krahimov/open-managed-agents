import { randomUUID } from 'node:crypto';
import { ModalClient, NotFoundError, type Sandbox } from 'modal';
import { DaytonaSandbox } from './daytona';
import type { DaytonaClient, DaytonaSandboxInstance, DaytonaProcess, DaytonaCreateParams } from './daytona-types';
import type { AgentMachineManager, MachineDriver } from '../machines/manager';
import { readS3MemoryBucket, type SandboxFactory, type SandboxFactoryEnv } from '../ports';

const q = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
const PROC_ROOT = '/var/lib/oma/modal-processes';
const PROFILE = '/var/lib/oma/browser/profile';

/** The legacy transport shape lets Modal use the same vault injection, resource
 * sync, process handles and generation checks as Daytona. No Daytona SDK is
 * loaded: all provider calls below use the official Modal JavaScript SDK. */
export class ModalComputer implements DaytonaSandboxInstance {
  readonly public = false;
  state = 'started';
  readonly id: string;
  readonly process: DaytonaProcess;
  readonly fs: DaytonaSandboxInstance['fs'];
  readonly computerUse: NonNullable<DaytonaSandboxInstance['computerUse']>;

  constructor(readonly sandbox: Sandbox, readonly labels: Record<string, string> = {}) {
    this.id = sandbox.sandboxId;
    this.fs = {
      uploadFile: async (bytes, path) => {
        await sandbox.filesystem.makeDirectory(path.slice(0, path.lastIndexOf('/')) || '/', { createParents: true });
        await sandbox.filesystem.writeBytes(bytes, path);
      },
      downloadFile: async path => Buffer.from(await sandbox.filesystem.readBytes(path)),
      createFolder: async (path, mode) => { await this.checked(`mkdir -p ${q(path)} && chmod ${q(mode)} ${q(path)}`); },
    };
    this.process = {
      executeCommand: (cmd, cwd, env, timeout) => this.execute(cmd, cwd, env, timeout),
      createSession: async id => { await this.checked(`mkdir -p ${q(this.procDir(id))}`); },
      executeSessionCommand: async (id, req) => {
        if (!req.runAsync) throw new Error('Modal process sessions require runAsync');
        const cmdId = randomUUID();
        const dir = this.procDir(id);
        // A detached guest supervisor owns completion and logs. Host restart
        // must not turn completed work into a permanently running process.
        const supervisor = `import subprocess,pathlib,os,sys\np=pathlib.Path(sys.argv[1]); cmd=sys.argv[2]\nwith (p/'stdout').open('wb') as out,(p/'stderr').open('wb') as err:\n child=subprocess.Popen(['sh','-c',cmd],stdout=out,stderr=err,start_new_session=True)\n (p/'pid').write_text(str(child.pid))\n (p/'boot').write_text(pathlib.Path('/proc/sys/kernel/random/boot_id').read_text())\n code=child.wait()\n (p/'exit.tmp').write_text(str(code if code>=0 else 128-code))\n os.replace(p/'exit.tmp',p/'exit')\n`;
        await this.fs.uploadFile(Buffer.from(supervisor), `${dir}/supervisor.py`);
        await this.fs.uploadFile(Buffer.from(cmdId), `${dir}/id`);
        const launcher = `import subprocess,sys\nsubprocess.Popen(['python3',sys.argv[1],sys.argv[2],sys.argv[3]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)\n`;
        await this.checked(`python3 -c ${q(launcher)} ${q(`${dir}/supervisor.py`)} ${q(dir)} ${q(req.command)}`);
        return { cmdId };
      },
      getSessionCommand: async (id, cmdId) => {
        const records = await this.inventory();
        const record = records.find(r => r.sessionId === id);
        if (!record || record.id !== cmdId) throw new Error('Modal process record not found');
        return { id: cmdId, command: '', ...(record.exitCode === null ? {} : { exitCode: record.exitCode }) };
      },
      getSessionCommandLogs: async (id) => {
        const dir = this.procDir(id);
        const stdout = await this.execute(`tail -c 1048576 ${q(`${dir}/stdout`)} 2>/dev/null || true`);
        const stderr = await this.execute(`tail -c 1048576 ${q(`${dir}/stderr`)} 2>/dev/null || true`);
        return { stdout: stdout.artifacts.stdout, stderr: stderr.artifacts.stdout };
      },
      listSessions: async () => (await this.inventory()).map(r => ({ sessionId: r.sessionId, commands: [{ id: r.id, ...(r.exitCode === null ? {} : { exitCode: r.exitCode }) }] })),
      deleteSession: async id => {
        // Handles kill the process group before deleting records. Refuse to
        // hide still-running work from the machine's stop guard.
        const record = (await this.inventory()).find(r => r.sessionId === id);
        if (record?.exitCode === null) throw new Error('Cannot remove a running Modal process');
        await this.checked(`rm -rf ${q(this.procDir(id))}`);
      },
    };
    this.computerUse = {
      start: async () => { await this.checked(MODAL_DESKTOP_START, 60); },
      screenshot: { takeFullScreen: async () => {
        const file = `/tmp/oma-screen-${randomUUID()}.png`;
        try {
          await this.checked(`DISPLAY=:99 scrot ${q(file)}`);
          return { screenshot: (await this.fs.downloadFile(file)).toString('base64') };
        } finally { await this.checked(`rm -f ${q(file)}`).catch(() => {}); }
      } },
      mouse: {
        click: async (x, y, button = 'left', double = false) => this.checked(`DISPLAY=:99 xdotool mousemove ${coordinate(x)} ${coordinate(y)} click --repeat ${double ? 2 : 1} --delay 100 ${button === 'right' ? 3 : button === 'middle' ? 2 : 1}`),
        scroll: async (x, y, direction, amount = 3) => this.checked(`DISPLAY=:99 xdotool mousemove ${coordinate(x)} ${coordinate(y)} click --repeat ${Math.max(1, Math.min(100, Math.floor(amount)))} ${direction === 'up' ? 4 : direction === 'down' ? 5 : direction === 'left' ? 6 : 7}`),
      },
      keyboard: {
        type: async text => this.checked(`DISPLAY=:99 xdotool type --clearmodifiers -- ${q(text)}`),
        press: async (key, modifiers = []) => this.checked(`DISPLAY=:99 xdotool key --clearmodifiers ${q([...modifiers, key].map(xKey).join('+'))}`),
      },
    };
  }

  private procDir(id: string): string {
    if (!/^oma-proc-[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid Modal process identity');
    return `${PROC_ROOT}/${id}`;
  }
  private async inventory(): Promise<Array<{ sessionId: string; id: string; exitCode: number | null }>> {
    const r = await this.checked(`python3 -c ${q(INVENTORY_SCRIPT)}`);
    return JSON.parse(r);
  }
  private async execute(command: string, cwd?: string, env?: Record<string, string>, timeoutSec = 120) {
    const p = await this.sandbox.exec(['sh', '-c', command], { workdir: cwd, env, timeoutMs: timeoutSec * 1000 });
    const [stdout, stderr, exitCode] = await Promise.all([p.stdout.readText(), p.stderr.readText(), p.wait()]);
    return { exitCode, result: stdout + stderr, artifacts: { stdout, stderr } };
  }
  async checked(command: string, timeoutSec = 30): Promise<string> {
    const r = await this.execute(command, undefined, undefined, timeoutSec);
    if (r.exitCode !== 0) throw new Error(`Modal computer command failed (${r.exitCode}): ${r.result.slice(-3000)}`);
    return r.artifacts.stdout;
  }
  async refreshData() { this.state = (await this.sandbox.poll()) === null ? 'started' : 'stopped'; }
  async start() { await this.refreshData(); if (this.state !== 'started') throw new Error('Modal computer must be restored from its checkpoint'); }
  async stop() { await this.sandbox.terminate({ wait: true }); this.state = 'stopped'; }
  async recover() { await this.start(); }
  async refreshActivity() { /* Orrery enforces idle stop; Modal's lifetime is fixed. */ }
  async setAutostopInterval(_minutes: number) { /* Never enable provider idle termination: it would skip checkpointing. */ }
  async setLabels(labels: Record<string, string>) { await this.sandbox.setTags(labels); return labels; }
  async getPreviewLink(port: number) {
    const credentials = await this.sandbox.createConnectToken({ port });
    return { ...credentials, headers: { Authorization: `Bearer ${credentials.token}` } };
  }
  async getSignedPreviewUrl(): Promise<never> { throw new Error('Modal computers require authenticated server-side connections'); }
}

const INVENTORY_SCRIPT = `import pathlib,json,os,time
root=pathlib.Path('${PROC_ROOT}'); rows=[]
boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text()
for p in root.glob('oma-proc-*'):
 if not (p/'id').exists(): continue
 code=None
 if (p/'exit').exists(): code=int((p/'exit').read_text())
 elif (p/'boot').exists() and (p/'boot').read_text()!=boot: code=137
 elif (p/'pid').exists():
  try:
   pid=int((p/'pid').read_text()); os.kill(pid,0)
   if pathlib.Path('/proc',str(pid),'stat').read_text().split(') ')[1].startswith('Z'): code=137
  except (ProcessLookupError,FileNotFoundError): code=137
 elif time.time()-p.stat().st_mtime>30: code=127
 rows.append(dict(sessionId=p.name,id=(p/'id').read_text(),exitCode=code))
print(json.dumps(rows))
`;

function coordinate(n: number): number {
  if (!Number.isFinite(n)) throw new Error('Invalid desktop coordinate');
  return Math.max(0, Math.min(16384, Math.floor(n)));
}
function xKey(key: string): string {
  const aliases: Record<string, string> = { ctrl: 'ctrl', control: 'ctrl', meta: 'super', cmd: 'super', command: 'super', enter: 'Return', return: 'Return', escape: 'Escape', esc: 'Escape', backspace: 'BackSpace', space: 'space', tab: 'Tab', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right' };
  return aliases[key.toLowerCase()] ?? key;
}

export const MODAL_DESKTOP_START = `set -eu
mkdir -p /var/lib/oma/desktop
export DISPLAY=:99
if ! xdpyinfo >/dev/null 2>&1; then
 rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
 nohup Xvfb :99 -screen 0 1280x800x24 -ac >/var/lib/oma/desktop/xvfb.log 2>&1 </dev/null &
 i=0; until xdpyinfo >/dev/null 2>&1; do i=$((i+1)); [ "$i" -lt 30 ] || exit 1; sleep 1; done
 nohup dbus-run-session -- startxfce4 >/var/lib/oma/desktop/xfce.log 2>&1 </dev/null &
fi
if ! pgrep -x x11vnc >/dev/null; then
 nohup x11vnc -display :99 -localhost -forever -shared -rfbport 5900 -nopw >/var/lib/oma/desktop/vnc.log 2>&1 </dev/null &
fi
if ! curl -fsS --max-time 2 http://127.0.0.1:6080/vnc.html >/dev/null; then
 nohup websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 >/var/lib/oma/desktop/websockify.log 2>&1 </dev/null &
fi
`;

export function createModalMachineDriver(env: SandboxFactoryEnv): MachineDriver {
  let promise: Promise<DaytonaClient> | undefined;
  let modal: ModalClient;
  const driver: MachineDriver = {
    client: () => promise ??= (async () => {
      if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) throw new Error('MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required');
      modal = new ModalClient({ tokenId: env.MODAL_TOKEN_ID, tokenSecret: env.MODAL_TOKEN_SECRET, environment: env.MODAL_ENVIRONMENT });
      const app = await modal.apps.fromName(env.MODAL_APP_NAME ?? 'orrery-computers', { createIfMissing: true });
      return {
        create: async (params: DaytonaCreateParams) => {
          const image = params.snapshot ? await modal.images.fromId(params.snapshot) : modal.images.fromRegistry(params.image ?? 'node:22-bookworm');
          const sandbox = await modal.sandboxes.create(app, image, {
            name: params.name, tags: params.labels,
            cpu: 1, cpuLimit: 1, memoryMiB: 4096, memoryLimitMiB: 4096,
            timeoutMs: 24 * 60 * 60 * 1000,
            experimentalOptions: { vm_runtime: true },
            // Only new VMs execute this. Disk snapshots contain stale locks.
            command: ['sh', '-c', `rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 ${PROFILE}/SingletonLock ${PROFILE}/SingletonSocket ${PROFILE}/SingletonCookie; exec sleep infinity`],
          });
          const box = new ModalComputer(sandbox, params.labels);
          return box;
        },
        get: async (id: string) => { const box = new ModalComputer(await modal.sandboxes.fromId(id)); await box.refreshData(); return box; },
        list: async (labels?: Record<string, string>) => {
          const items: ModalComputer[] = [];
          for await (const sb of modal.sandboxes.list({ appId: app.appId, tags: labels })) items.push(new ModalComputer(sb, await sb.getTags()));
          return { items };
        },
        delete: async (sb: DaytonaSandboxInstance) => { await sb.stop(); },
      };
    })().catch(err => { promise = undefined; throw err; }),
    isNotFound: error => error instanceof NotFoundError,
    checkpoint: async sb => {
      if (!(sb instanceof ModalComputer)) throw new Error('Modal checkpoint requires a Modal computer');
      // Browser.close flushes cookies; killing every Chromium process races
      // its network service and lost cookies in the live infrastructure trial.
      await sb.checked(CLOSE_BROWSER, 45);
      const snapshot = await sb.sandbox.snapshotFilesystem({ ttlMs: null, timeoutMs: 120_000 });
      return snapshot.imageId;
    },
    deleteCheckpoint: async id => { await driver.client(); await modal.images.delete(id); },
    dispose: () => { modal?.close(); promise = undefined; },
  };
  return driver;
}

export const CLOSE_BROWSER = `node -e ${q(`(async()=>{
 let response; try { response=await fetch('http://127.0.0.1:9222/json/version'); } catch { return; }
 if(!response.ok) throw Error('Cannot inspect browser before checkpoint');
 const data=await response.json();
 await new Promise((resolve,reject)=>{const ws=new WebSocket(data.webSocketDebuggerUrl);const timer=setTimeout(()=>{ws.close();reject(Error('Browser close timed out'))},10000);ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'Browser.close'}));ws.onclose=()=>{clearTimeout(timer);resolve()};ws.onerror=()=>{clearTimeout(timer);reject(Error('Browser close failed'))};});
 const fs=require('node:fs');for(let i=0;i<100;i++){try{fs.lstatSync('${PROFILE}/SingletonLock')}catch(e){if(e.code==='ENOENT')return;throw e}await new Promise(r=>setTimeout(r,100));}throw Error('Browser did not flush its profile');
})().catch(e=>{console.error(e.message);process.exit(1)})`)}
sync`;

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  if (env.SANDBOX_SCOPE !== 'agent' || !ctx.machines?.spec || ctx.machines.spec.provider !== 'modal') {
    throw new Error('Modal currently requires an agent-scoped computer with a Modal specification');
  }
  const manager = ctx.machines.manager as AgentMachineManager;
  const box = manager.provider({ tenantId: ctx.machines.tenantId, agentId: ctx.machines.agentId, sessionId: ctx.sessionId, spec: ctx.machines.spec });
  return new DaytonaSandbox({ box, sessionId: ctx.sessionId, workdir: ctx.machines.spec.workdir, memoryBucket: readS3MemoryBucket(env), maxFileBytes: ctx.machines.spec.maxFileBytes });
};
