import type { OutputsAdapter } from "@open-managed-agents/http-routes";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { guessSessionOutputMime } from "@open-managed-agents/shared";

export interface AgentComputerOutputsOptions {
  resolve(tenantId: string, sessionId: string): Promise<{
    sandbox: SandboxExecutor;
    outputsPath: string;
  } | null>;
  fallback: OutputsAdapter;
}

const CHUNK_BYTES = 512 * 1024;

// Resolve every component relative to an already-open directory. Neither
// listing, reading, nor recursive deletion follows symlinks, including a
// symlink substituted for the session's outputs directory or an ancestor.
const FILE_SCRIPT = String.raw`
import base64, errno, json, os, stat, sys

request = json.loads(sys.argv[1])
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def open_root(path):
    parts = path.split('/')[1:]
    if not path.startswith('/') or any(p in ('', '.', '..') for p in parts):
        raise ValueError('Invalid outputs directory')
    if len(parts) < 2 or parts[-1] != 'outputs':
        raise ValueError('Invalid outputs directory')
    current = os.open('/', flags)
    try:
        for part in parts:
            following = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = following
        return current
    except:
        os.close(current)
        raise

def remove_contents(directory):
    for name in os.listdir(directory):
        try:
            item = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if stat.S_ISDIR(item.st_mode):
                child = os.open(name, flags, dir_fd=directory)
                try:
                    remove_contents(child)
                finally:
                    os.close(child)
                os.rmdir(name, dir_fd=directory)
            else:
                os.unlink(name, dir_fd=directory)
        except FileNotFoundError:
            pass

def main():
    directory = open_root(request['path'])
    try:
        if request['operation'] == 'list':
            result = []
            for name in sorted(os.listdir(directory)):
                try:
                    item = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    if stat.S_ISREG(item.st_mode):
                        result.append({'filename': name, 'size': item.st_size, 'modified': item.st_mtime * 1000})
                except FileNotFoundError:
                    pass
            return result
        if request['operation'] == 'delete':
            remove_contents(directory)
            return True
        name = request['filename']
        if not name or name in ('.', '..') or '/' in name or '\\' in name or '\0' in name:
            return None
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        item = os.fstat(descriptor)
        if not stat.S_ISREG(item.st_mode):
            os.close(descriptor)
            return None
        with os.fdopen(descriptor, 'rb') as source:
            identity = ':'.join(str(value) for value in (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns))
            if request.get('identity') and request['identity'] != identity:
                raise ValueError('Output changed during download. Try again.')
            source.seek(request.get('offset', 0))
            data = source.read(request['limit'])
            return {'size': item.st_size, 'identity': identity, 'data': base64.b64encode(data).decode('ascii')}
    finally:
        os.close(directory)

try:
    result = main()
    print(json.dumps({'result': result}))
except OSError as error:
    if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
        print(json.dumps({'result': None}))
    else:
        print(json.dumps({'error': str(error)}))
except Exception as error:
    print(json.dumps({'error': str(error)}))
`;

interface FileChunk {
  size: number;
  identity: string;
  data: string;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const flatFilename = (filename: string) => filename.length > 0 &&
  !filename.includes("/") && !filename.includes("\\") && !filename.includes("\0") &&
  filename !== "." && filename !== "..";

async function operation<T>(sandbox: SandboxExecutor, request: Record<string, unknown>): Promise<T | null> {
  const command = `python3 -c ${shellQuote(FILE_SCRIPT)} ${shellQuote(JSON.stringify(request))}`;
  const output = await sandbox.exec(command, 60_000);
  let response: { result?: T | null; error?: string };
  try {
    response = JSON.parse(output);
  } catch {
    throw new Error("Could not read computer outputs.");
  }
  if (response.error) throw new Error(response.error);
  return response.result ?? null;
}

/** Read agent outputs directly from its computer, including without S3. */
export function agentComputerOutputsAdapter(options: AgentComputerOutputsOptions): OutputsAdapter {
  return {
    async list(tenantId, sessionId) {
      const target = await options.resolve(tenantId, sessionId);
      if (!target) return options.fallback.list(tenantId, sessionId);
      const files = await operation<Array<{ filename: string; size: number; modified: number }>>(target.sandbox, {
        operation: "list", path: target.outputsPath,
      });
      const current = (files ?? []).filter((file) => flatFilename(file.filename)).map((file) => ({
        filename: file.filename,
        size_bytes: file.size,
        uploaded_at: new Date(file.modified).toISOString(),
        media_type: guessSessionOutputMime(file.filename),
      }));
      // A recreated computer may have lost /mnt/sessions while S3 still
      // holds completed outputs. Keep those downloadable; live files win.
      const retained = await options.fallback.list(tenantId, sessionId) ?? [];
      return [...new Map([...retained, ...current].map((file) => [file.filename, file])).values()]
        .sort((left, right) => left.filename.localeCompare(right.filename));
    },
    async read(tenantId, sessionId, filename) {
      if (!flatFilename(filename)) return null;
      const target = await options.resolve(tenantId, sessionId);
      if (!target) return options.fallback.read(tenantId, sessionId, filename);
      const request = { operation: "read", path: target.outputsPath, filename, limit: CHUNK_BYTES };
      const first = await operation<FileChunk>(target.sandbox, request);
      if (!first) return options.fallback.read(tenantId, sessionId, filename);
      let offset = 0;
      let next: FileChunk | null = first;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = next ?? await operation<FileChunk>(target.sandbox, {
              ...request, offset, identity: first.identity,
            });
            next = null;
            if (cancelled) return;
            if (!chunk) throw new Error("Output is no longer available.");
            const bytes = Buffer.from(chunk.data, "base64");
            if (bytes.length === 0 && offset < first.size) throw new Error("Output changed during download. Try again.");
            offset += bytes.length;
            if (bytes.length) controller.enqueue(bytes);
            if (offset >= first.size) controller.close();
          } catch (error) {
            if (!cancelled) controller.error(error);
          }
        },
        cancel() { cancelled = true; },
      });
      return { body, size: first.size, contentType: guessSessionOutputMime(filename) };
    },
    async deleteAll(tenantId, sessionId) {
      const target = await options.resolve(tenantId, sessionId);
      if (!target) return options.fallback.deleteAll(tenantId, sessionId);
      await operation(target.sandbox, { operation: "delete", path: target.outputsPath });
      // Remove any copies retained by an earlier S3-backed session too.
      await options.fallback.deleteAll(tenantId, sessionId);
    },
  };
}
