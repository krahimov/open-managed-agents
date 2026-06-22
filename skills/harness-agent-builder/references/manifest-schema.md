# Agent Project Manifest

`harness.agent.json` is the portable handoff between a coding agent and
Harness Studio/openma. It should be checked into the user's repo when the agent
configuration is part of the product, and treated like infrastructure config.

The CLI currently applies JSON. Keep YAML examples for humans only unless the
installed CLI supports YAML.

## Top Level

```ts
interface AgentProject {
  apiVersion: "harness.studio/v1alpha1";
  kind: "AgentProject";
  metadata?: {
    name?: string;
    description?: string;
    labels?: Record<string, string>;
  };
  agent: AgentSpec;
  environment?: EnvironmentRef | EnvironmentSpec;
  vaults?: VaultRef[];
  apps?: Record<string, AppSpec>;
  publications?: Record<string, PublicationSpec>;
  tests?: SmokeTestSpec[];
}
```

`agent` is always applied by `oma agents apply -f`. Composio entries in `apps`
are also active: apply opens a browser OAuth window, creates the Composio
tool-router credential, and attaches the resulting vault to the agent. Other
sections are planning metadata for the skill and future reconciliation.

## Agent

```ts
interface AgentSpec {
  name: string;
  description?: string;
  model: string | { id: string; speed?: "standard" | "fast" };
  aux_model?: string | { id: string; speed?: "standard" | "fast" };
  system?: string;
  system_file?: string;
  tools?: ToolSpec[];
  skills?: SkillRef[];
  mcpServers?: McpServerSpec[];
  mcp_servers?: McpServerSpec[];
  callableAgents?: CallableAgentRef[];
  multiagent?: { type: "coordinator"; agents: CallableAgentRef[] };
  enable_general_subagent?: boolean;
  harness?: string;
  runtime_binding?: {
    runtime_id: string;
    acp_agent_id: string;
    local_skill_blocklist?: string[];
  };
  metadata?: Record<string, unknown>;
  default_environment_id?: string;
  default_vault_ids?: string[];
}
```

`system_file` is resolved relative to the manifest file. Prefer it over inline
`system` for non-trivial agents.

## Tools

Default:

```json
[{ "type": "agent_toolset_20260401" }]
```

Add MCP toolsets explicitly when needed by the API shape:

```json
[
  { "type": "agent_toolset_20260401" },
  {
    "type": "mcp_toolset",
    "mcp_server_name": "composio",
    "default_config": { "permission_policy": { "type": "always_allow" } }
  }
]
```

## MCP Servers

```ts
interface McpServerSpec {
  name: string;
  type: "url" | "stdio";
  url?: string;
  authorization_token?: string; // avoid; prefer vault-backed auth
  stdio?: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    port: number;
    sse_path?: string;
    ready_timeout_ms?: number;
  };
}
```

Use vault-backed auth instead of `authorization_token` unless this is a local
throwaway test.

## Environment

```ts
interface EnvironmentRef {
  id: string;
}

interface EnvironmentSpec {
  name: string;
  description?: string;
  config?: {
    type: "cloud";
    packages?: {
      pip?: string[];
      npm?: string[];
      apt?: string[];
      cargo?: string[];
      gem?: string[];
      go?: string[];
    };
    networking?: {
      type: "unrestricted" | "limited";
      allowed_hosts?: string[];
      allow_mcp_servers?: boolean;
      allow_package_managers?: boolean;
    };
  };
}
```

For now, create environments separately with `oma envs create` or the REST API,
then put the resulting id in `agent.default_environment_id`.

## Apps

```ts
interface AppSpec {
  provider: "composio" | "mcp" | "native";
  toolkit?: string;
  mcpServer?: McpServerSpec;
  requiredAuth?: "browser_oauth" | "admin_oauth" | "pat" | "static_bearer";
  scopes?: string[];
}
```

`provider: "composio"` is applied by the CLI. Other providers guide the coding
agent and are not applied directly yet.

## Publications

```ts
interface PublicationSpec {
  provider: "slack" | "github" | "linear";
  persona?: string;
  avatar?: string;
  environment_id?: string;
  capabilities?: string[];
}
```

Apply publications with the provider-specific CLI commands after the agent
exists.

## Smoke Tests

```ts
interface SmokeTestSpec {
  name: string;
  prompt: string;
  expect?: string[];
}
```

Smoke tests should be harmless. They should verify tool presence and planning,
not send real email, post to production channels, or modify user data.
