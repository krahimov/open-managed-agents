import { describe, expect, it } from "vitest";
import { mountResources } from "../../apps/agent/src/runtime/resource-mounter";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";

describe("resource mounter", () => {
  it("checks out GitHub pull request resources via refs/pull", async () => {
    const commands: string[] = [];
    const sandbox = {
      async exec(command: string): Promise<string> {
        commands.push(command);
        if (command.startsWith("which gh")) return "OK";
        return "";
      },
      async readFile(): Promise<string> {
        return "";
      },
      async writeFile(): Promise<string> {
        return "";
      },
    } as unknown as SandboxExecutor;

    await mountResources(
      sandbox,
      [
        {
          id: "res_pr",
          type: "github_repository",
          url: "https://github.com/acme/api",
          mount_path: "/workspace/repo",
          checkout: { type: "pull_request", name: "77", sha: "abc123headsha" },
        },
      ],
      {} as KVNamespace,
    );

    expect(commands).toContain("git clone https://github.com/acme/api /workspace/repo 2>&1");
    expect(commands).toContain(
      "cd /workspace/repo && git fetch origin refs/pull/77/head:refs/remotes/origin/pr/77 && git checkout -B pr-77 refs/remotes/origin/pr/77",
    );
  });
});
