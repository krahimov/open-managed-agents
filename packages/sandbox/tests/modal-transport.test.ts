import { describe, expect, it, vi } from 'vitest';
import type { Sandbox } from 'modal';
import { ModalComputer, CLOSE_BROWSER, MODAL_DESKTOP_START } from '../src/adapters/modal';
import { execFileSync } from 'node:child_process';

describe('Modal transport', () => {
  it('uses byte-first uploads and makes parent directories', async () => {
    const makeDirectory = vi.fn(async () => {}), writeBytes = vi.fn(async () => {});
    const box = new ModalComputer({ sandboxId: 'sb-test', filesystem: { makeDirectory, writeBytes } } as unknown as Sandbox);
    const bytes = Buffer.from([0,255,128,42]);
    await box.fs.uploadFile(bytes, '/workspace/a/b.bin');
    expect(makeDirectory).toHaveBeenCalledWith('/workspace/a', { createParents: true });
    expect(writeBytes).toHaveBeenCalledWith(bytes, '/workspace/a/b.bin');
  });
  it('keeps authentication in server-side headers rather than browser URLs', async () => {
    const createConnectToken = vi.fn(async () => ({ url: 'https://test.modal.host', token: 'private' }));
    const box = new ModalComputer({ sandboxId: 'sb-test', createConnectToken } as unknown as Sandbox);
    const preview = await box.getPreviewLink(6080);
    expect(createConnectToken).toHaveBeenCalledWith({ port: 6080 });
    expect(preview.headers).toEqual({ Authorization: 'Bearer private' });
    expect(preview.url).not.toContain('private');
    await expect(box.getSignedPreviewUrl()).rejects.toThrow('authenticated');
  });
  it('preserves stdout, stderr, exit codes, cwd and per-command environment', async () => {
    const exec = vi.fn(async () => ({ stdout: { readText: async () => 'out' }, stderr: { readText: async () => 'err' }, wait: async () => 7 }));
    const box = new ModalComputer({ sandboxId: 'sb-test', exec } as unknown as Sandbox);
    const result = await box.process.executeCommand('example', '/workspace', { TEST: 'value' }, 12);
    expect(exec).toHaveBeenCalledWith(['sh','-c','example'], { workdir: '/workspace', env: { TEST: 'value' }, timeoutMs: 12000 });
    expect(result).toEqual({ result: 'outerr', exitCode: 7, artifacts: { stdout: 'out', stderr: 'err' } });
  });
  it('generates valid shell for desktop startup and graceful browser close', () => {
    for (const script of [CLOSE_BROWSER, MODAL_DESKTOP_START]) execFileSync('sh', ['-n'], { input: script });
  });
});
