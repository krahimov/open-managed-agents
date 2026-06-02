import { describe, expect, it } from "vitest";
import type { EnvironmentConfig } from "@open-managed-agents/shared";
import {
  buildSandboxEnvForEnvironment,
  environmentMemoryStoreRefs,
  environmentMountsSessionOutputs,
  sandboxProviderFromEnvironment,
} from "../../apps/main-node/src/lib/environment-runtime-config";

describe("environment runtime config", () => {
  it("maps environment sandbox config to adapter env vars", () => {
    const environment = {
      id: "env_1",
      name: "Daytona",
      config: {
        type: "cloud",
        sandbox: {
          provider: "daytona",
          image: "node:22-bookworm",
          workdir: "/workspace",
          ephemeral: true,
          bootstrap_tools: true,
          bootstrap_apt_packages: ["git", "ripgrep"],
          max_file_bytes: 1234,
        },
      },
      created_at: "2026-06-02T00:00:00.000Z",
    } satisfies EnvironmentConfig;

    const env = buildSandboxEnvForEnvironment(
      { SANDBOX_PROVIDER: "subprocess" },
      environment,
    );

    expect(sandboxProviderFromEnvironment(env, environment)).toBe("daytona");
    expect(env.SANDBOX_IMAGE).toBe("node:22-bookworm");
    expect(env.DAYTONA_WORKDIR).toBe("/workspace");
    expect(env.DAYTONA_EPHEMERAL).toBe("true");
    expect(env.DAYTONA_BOOTSTRAP_TOOLS).toBe("true");
    expect(env.DAYTONA_BOOTSTRAP_APT_PACKAGES).toBe("git,ripgrep");
    expect(env.DAYTONA_MAX_FILE_BYTES).toBe("1234");
  });

  it("extracts environment memory store refs from memory and resources blocks", () => {
    const environment = {
      id: "env_1",
      name: "Memory",
      config: {
        type: "cloud",
        memory: {
          stores: [
            { id: "mem_1", access: "read_only", instructions: "Read policy docs." },
          ],
        },
        resources: {
          outputs: false,
          memory_stores: [
            { name: "team-notes", access: "read_write" },
          ],
        },
      },
      created_at: "2026-06-02T00:00:00.000Z",
    } satisfies EnvironmentConfig;

    expect(environmentMountsSessionOutputs(environment)).toBe(false);
    expect(environmentMemoryStoreRefs(environment)).toEqual([
      { storeId: "mem_1", access: "read_only", instructions: "Read policy docs." },
      { name: "team-notes", access: "read_write" },
    ]);
  });
});
