import { describe, expect, it } from "vitest";
import {
  buildDaytonaBootstrapScript,
  buildDaytonaCreateParams,
  DaytonaSandbox,
} from "../../packages/sandbox/src/adapters/daytona";
import { NodeWorkspaceBackupService } from "../../apps/main-node/src/lib/node-workspace-backup";

const silentLogger = {
  warn: (_msg: string, _ctx?: unknown) => {},
  log: (_msg: string) => {},
};

describe("sandbox storage policy", () => {
  it("creates Daytona sandboxes as ephemeral by default", async () => {
    expect(buildDaytonaCreateParams({
      sessionId: "sess-test",
    })).toMatchObject({
      image: "node:22-bookworm",
      ephemeral: true,
      labels: { "oma-session-id": "sess-test" },
    });
  });

  it("bootstraps Daytona coding tools in /workspace", () => {
    const script = buildDaytonaBootstrapScript({
      workdir: "/workspace",
      bootstrapTools: true,
      aptPackages: ["python3", "git", "curl", "jq", "ripgrep", "build-essential"],
    });

    expect(script).toContain("mkdir -p '/workspace'");
    expect(script).toContain("apt-get install");
    expect(script).toContain("python3");
    expect(script).toContain("git");
    expect(script).toContain("ripgrep");
    expect(script).toContain("cd '/workspace'");
  });

  it("rejects oversized Daytona file uploads before creating a sandbox", async () => {
    const sandbox = new DaytonaSandbox({
      sessionId: "sess-test",
      apiKey: "unused",
      maxFileBytes: 8,
      logger: silentLogger,
    });

    await expect(
      sandbox.writeFileBytes("/workspace/big.bin", new Uint8Array(9)),
    ).rejects.toThrow(/exceeds the Daytona per-file limit/);
  });

  it("blocks direct writes to the raw Daytona S3 mount", async () => {
    const sandbox = new DaytonaSandbox({
      sessionId: "sess-test",
      apiKey: "unused",
      logger: silentLogger,
    });

    await expect(
      sandbox.writeFile("/mnt/_oma_storage/raw.txt", "nope"),
    ).rejects.toThrow(/Direct writes to \/mnt\/_oma_storage are blocked/);
  });

  it("blocks obvious bulk allocation commands in Daytona bash", async () => {
    const sandbox = new DaytonaSandbox({
      sessionId: "sess-test",
      apiKey: "unused",
      logger: silentLogger,
    });

    await expect(sandbox.exec("fallocate -l 30G /workspace/blob")).resolves.toContain(
      "blocked",
    );
    await expect(sandbox.exec("ls /mnt/_oma_storage")).resolves.toContain(
      "Direct sandbox access to /mnt/_oma_storage is blocked",
    );
  });

  it("skips Node workspace backups when /workspace is over the cap", async () => {
    const commands: string[] = [];
    const service = new NodeWorkspaceBackupService({
      sql: {} as never,
      blobs: {} as never,
      maxBytes: 1024,
      logger: silentLogger,
    });
    const sandbox = {
      exec: async (command: string) => {
        commands.push(command);
        return "2\n";
      },
      readFile: async () => "",
      writeFile: async () => "ok",
      readFileBytes: async () => {
        throw new Error("readFileBytes should not run when backup is skipped");
      },
    };

    const result = await service.snapshot({
      sessionId: "sess-test",
      tenantId: "default",
      sandbox,
    });

    expect(result).toBeNull();
    expect(commands.some((command) => command.includes("tar -cf"))).toBe(false);
  });
});
