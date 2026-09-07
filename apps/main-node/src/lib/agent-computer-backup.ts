import type { SandboxExecutor } from '@open-managed-agents/sandbox';
import type { DaytonaSandboxInstance } from '@open-managed-agents/sandbox/adapters/daytona-types';

/** Platform-owned file access for workspace backups, independent of sessions. */
export function computerBackupExecutor(sb: DaytonaSandboxInstance): SandboxExecutor {
  return {
    async exec(command, timeout) {
      const result = await sb.process.executeCommand(command, '/workspace', {}, Math.ceil((timeout ?? 120000) / 1000));
      return result.result + (result.exitCode ? `\n[exit ${result.exitCode}]` : '');
    },
    async readFile(path) { return (await sb.fs.downloadFile(path)).toString('utf8'); },
    async readFileBytes(path) { return sb.fs.downloadFile(path); },
    async writeFile(path, content) { await sb.fs.uploadFile(Buffer.from(content), path); return path; },
    async writeFileBytes(path, bytes) { await sb.fs.uploadFile(Buffer.from(bytes), path); return path; },
  };
}
