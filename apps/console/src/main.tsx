import { StrictMode, Suspense, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Navigate,
  RouterProvider,
  createBrowserRouter,
  type RouteObject,
  type UIMatch,
} from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
// Fonts are bundled: Hanken Grotesk is vendored under assets/fonts and
// declared in index.css; JetBrains Mono comes from the installed package.
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import { AuthProvider } from "./lib/auth";
import { MaybeClerkProvider } from "./lib/clerk-auth";
import { Toaster } from "./components/ui/sonner";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { queryClient } from "./lib/query-client";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { AgentsList } from "./pages/AgentsList";
import { AgentDetail } from "./pages/AgentDetail";
import { DeploymentsList } from "./pages/DeploymentsList";
import { SessionsList } from "./pages/SessionsList";
import { FilesList } from "./pages/FilesList";
import { EnvironmentsList } from "./pages/EnvironmentsList";
import { EnvironmentDetail } from "./pages/EnvironmentDetail";
import { VaultsList } from "./pages/VaultsList";
import { VaultDetail } from "./pages/VaultDetail";
import { SkillsList } from "./pages/SkillsList";
import { SkillsCatalog } from "./pages/SkillsCatalog";
import { MemoryStoresList } from "./pages/MemoryStoresList";
import { MemoryStoreDetail } from "./pages/MemoryStoreDetail";
import { ModelCardsList } from "./pages/ModelCardsList";
import { ApiKeysList } from "./pages/ApiKeysList";
import { CliLogin } from "./pages/CliLogin";
import { RuntimesList } from "./pages/RuntimesList";
import { ConnectRuntime } from "./pages/ConnectRuntime";
import { ComposioCallback } from "./pages/ComposioCallback";
import { IntegrationsApps } from "./pages/IntegrationsApps";
import { EvalRunsList } from "./pages/EvalRunsList";
import { EvalRunDetail } from "./pages/EvalRunDetail";
import {
  IntegrationsLinearList,
  IntegrationsLinearWorkspace,
  IntegrationsLinearPublishPage,
  IntegrationsLinearPatInstallPage,
} from "./pages/IntegrationsLinear";
import {
  IntegrationsGitHubList,
  IntegrationsGitHubWorkspace,
  IntegrationsGitHubBindPage,
} from "./pages/IntegrationsGitHub";
import {
  IntegrationsSlackList,
  IntegrationsSlackWorkspace,
  IntegrationsSlackPublishPage,
} from "./pages/IntegrationsSlack";
import { NotFound } from "./pages/NotFound";
import { consolePlugins } from "./plugins/registry";
import { BRAND_NAME } from "./lib/brand";
import type { EntityKind } from "./lib/directory";

/** Tab title for a page outside the shell (sign-in and its relatives). Inside
 *  the shell the title comes from the breadcrumb trail: see `useRouteTitle`. */
function Titled({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · ${BRAND_NAME}`;
  }, [title]);
  return children;
}

/** Breadcrumb for a record route: AppBreadcrumb resolves the id to the
 *  record's name (never shows the raw id in the trail). */
function entityCrumb(kind: EntityKind, m: UIMatch, fallback: string) {
  const id = m.params.id as string | undefined;
  return id ? { entity: { kind, id } } : { label: fallback };
}

/**
 * Router config. Migrated from declarative `<BrowserRouter><Routes>` to
 * the data router (`createBrowserRouter` + `<RouterProvider>`) so we
 * can use `useMatches()` / per-route `handle` / loaders / actions.
 * Hooks that throw "must be used within a data router" — AppBreadcrumb,
 * future loader-driven pages — now work.
 *
 * Lazy chunks use the data-router-native `lazy:` field, which returns
 * an object with `Component` (and optionally `loader`, `action`,
 * `errorElement` etc). Compared to wrapping `<React.lazy />` in a
 * `<Suspense>`, the data router knows to await the chunk before
 * rendering the route, avoiding a flash of fallback during navigation.
 *
 * Per-route `handle.crumb` publishes a label for AppBreadcrumb. For
 * fixed labels pass a string; for dynamic labels (resource name from
 * the loader) pass a function that reads the match.
 */

const protectedRoutes: RouteObject[] = [
  { index: true, element: <Dashboard />, handle: { crumb: "Home" } },
  // Nested route groups so detail pages publish a proper hierarchy
  // through `useMatches()` — `/agents/:id` resolves to
  // [agents-parent, agents/:id], so AppBreadcrumb renders
  // `Agents › Agent` instead of just `Agent` with no link back.
  {
    path: "agents",
    handle: { crumb: "Agents" },
    children: [
      { index: true, element: <AgentsList /> },
      {
        // The agent's record, and under it the setup conversation, so the
        // trail reads Agents › {agent} › Setup.
        path: ":id",
        handle: { crumb: (m: UIMatch) => entityCrumb("agent", m, "Agent") },
        children: [
          { index: true, element: <AgentDetail /> },
          {
            // Agent setup session — the agent's first session, where it reads its
            // own harness and interviews the user to refine it. Lazy (pulls in
            // ai-elements + Shiki like SessionDetail), so keep it out of the list bundle.
            path: "setup",
            handle: { crumb: "Setup" },
            lazy: async () => {
              const { AgentSetup } = await import("./pages/agents/AgentSetup");
              return { Component: AgentSetup };
            },
          },
        ],
      },
    ],
  },
  { path: "deployments", element: <DeploymentsList />, handle: { crumb: "Deployments" } },
  {
    path: "sessions",
    handle: { crumb: "Sessions" },
    children: [
      { index: true, element: <SessionsList /> },
      {
        path: ":id",
        handle: { crumb: (m: UIMatch) => entityCrumb("session", m, "Session") },
        // SessionDetail lazy-loads — it pulls in ai-elements + Shiki +
        // Streamdown + mermaid + dozens of language defs (~500 kB
        // gzipped). Splitting it out keeps the initial bundle for
        // /agents, /sessions list, etc. under 350 kB.
        lazy: async () => {
          const { SessionDetail } = await import("./pages/SessionDetail");
          return { Component: SessionDetail };
        },
      },
    ],
  },
  { path: "files", element: <FilesList />, handle: { crumb: "Files" } },
  {
    path: "usage",
    handle: { crumb: "Usage" },
    lazy: async () => {
      const { UsagePage } = await import("./pages/UsagePage");
      return { Component: UsagePage };
    },
  },
  {
    path: "evals",
    handle: { crumb: "Evals" },
    children: [
      { index: true, element: <EvalRunsList /> },
      {
        path: ":id",
        // The run is named for its suite (or its kind), never by its id.
        handle: { crumb: (m: UIMatch) => entityCrumb("eval_run", m, "Run") },
        children: [
          { index: true, element: <EvalRunDetail /> },
          {
            path: "trials/:taskId/:trialIndex",
            handle: {
              // Trials are zero-based in the URL; people count from one.
              crumb: (m: UIMatch) => {
                const index = Number(m.params.trialIndex);
                return `${(m.params.taskId as string | undefined) ?? "task"} · trial ${Number.isInteger(index) ? index + 1 : "?"}`;
              },
            },
            // Lazy: pulls in TimelineView + trajectory panels, only
            // needed once an operator drills into a trial.
            lazy: async () => {
              const { EvalTrialDetail } = await import("./pages/EvalTrialDetail");
              return { Component: EvalTrialDetail };
            },
          },
        ],
      },
    ],
  },
  {
    path: "environments",
    handle: { crumb: "Environments" },
    children: [
      { index: true, element: <EnvironmentsList /> },
      {
        path: ":id",
        element: <EnvironmentDetail />,
        handle: { crumb: (m: UIMatch) => entityCrumb("environment", m, "Environment") },
      },
    ],
  },
  { path: "skills", element: <SkillsList />, handle: { crumb: "Skills" } },
  { path: "skills/catalog", element: <SkillsCatalog />, handle: { crumb: "Skill catalog" } },
  {
    path: "vaults",
    handle: { crumb: "Vaults" },
    children: [
      { index: true, element: <VaultsList /> },
      {
        path: ":id",
        element: <VaultDetail />,
        handle: { crumb: (m: UIMatch) => entityCrumb("vault", m, "Vault") },
      },
    ],
  },
  {
    path: "memory",
    handle: { crumb: "Memory" },
    children: [
      { index: true, element: <MemoryStoresList /> },
      {
        path: ":id",
        element: <MemoryStoreDetail />,
        handle: { crumb: (m: UIMatch) => entityCrumb("memory_store", m, "Memory store") },
      },
    ],
  },
  { path: "model-cards", element: <ModelCardsList />, handle: { crumb: "Models" } },
  { path: "api-keys", element: <ApiKeysList />, handle: { crumb: "API keys" } },
  { path: "operations", handle: { crumb: "Operations" }, lazy: async () => {
    const { Operations } = await import("./pages/Operations"); return { Component: Operations };
  } },
  { path: "workspace", handle: { crumb: "Workspace" }, lazy: async () => {
    const { WorkspaceSettings } = await import("./pages/WorkspaceSettings"); return { Component: WorkspaceSettings };
  } },
  { path: "runtimes", element: <RuntimesList />, handle: { crumb: "Local runtimes" } },
  {
    path: "integrations",
    handle: { crumb: "Integrations" },
    children: [
      { index: true, element: <Navigate to="/integrations/apps" replace /> },
      {
        path: "apps",
        element: <IntegrationsApps />,
        handle: { crumb: "Apps" },
      },
      {
        path: "linear",
        handle: { crumb: "Linear" },
        children: [
          { index: true, element: <IntegrationsLinearList /> },
          {
            path: "publish",
            element: <IntegrationsLinearPublishPage />,
            handle: { crumb: "Publish an agent" },
          },
          {
            path: "install-pat",
            element: <IntegrationsLinearPatInstallPage />,
            handle: { crumb: "Install with an API key" },
          },
          {
            path: "installations/:id",
            element: <IntegrationsLinearWorkspace />,
            handle: { crumb: "Workspace" },
          },
        ],
      },
      {
        path: "github",
        handle: { crumb: "GitHub" },
        children: [
          { index: true, element: <IntegrationsGitHubList /> },
          {
            path: "bind",
            element: <IntegrationsGitHubBindPage />,
            handle: { crumb: "Bind an agent" },
          },
          {
            path: "installations/:id",
            element: <IntegrationsGitHubWorkspace />,
            handle: { crumb: "Workspace" },
          },
        ],
      },
      {
        path: "slack",
        handle: { crumb: "Slack" },
        children: [
          { index: true, element: <IntegrationsSlackList /> },
          {
            path: "publish",
            element: <IntegrationsSlackPublishPage />,
            handle: { crumb: "Publish an agent" },
          },
          {
            path: "installations/:id",
            element: <IntegrationsSlackWorkspace />,
            handle: { crumb: "Workspace" },
          },
        ],
      },
    ],
  },
  // The Muse kit: every shared component with live data. The visual
  // companion to DESIGN.md; not linked from the navigation.
  {
    path: "_kit",
    handle: { crumb: "Design kit" },
    lazy: async () => {
      const { Kit } = await import("./pages/Kit");
      return { Component: Kit };
    },
  },
  // Plugin-contributed routes (hosted-only extensions). Default empty in
  // OSS — hosted deploy overlays plugins/registry.ts to inject billing
  // / etc. PluginRoute keeps the same `{ path, element }` shape that
  // RouteObject expects.
  ...consolePlugins.flatMap((p) => p.routes ?? []),
  // An address that matches nothing says so, inside the shell, instead of
  // quietly landing on Agents.
  { path: "*", element: <NotFound />, handle: { crumb: "Page not found" } },
];

const router = createBrowserRouter([
  { path: "login", element: <Titled title="Sign in"><Login /></Titled> },
  { path: "cli/login", element: <Titled title="Authorize the CLI"><CliLogin /></Titled> },
  { path: "connect-runtime", element: <Titled title="Connect this machine"><ConnectRuntime /></Titled> },
  { path: "composio/callback", element: <Titled title="Connecting an app"><ComposioCallback /></Titled> },
  {
    element: <AppShell />,
    children: protectedRoutes,
  },
]);

// A deploy replaces every hashed chunk; tabs opened before it still hold
// the old index.html and fail to lazy-load route chunks (Model Cards /
// Integrations pages silently break). Vite fires this event exactly for
// that case — reload once to pick up the fresh manifest.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  const KEY = "oma-chunk-reload-at";
  const last = Number(sessionStorage.getItem(KEY) ?? 0);
  if (Date.now() - last > 10_000) {
    sessionStorage.setItem(KEY, String(Date.now()));
    window.location.reload();
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <MaybeClerkProvider>
          <AuthProvider>
            <Suspense fallback={null}>
              <RouterProvider router={router} />
            </Suspense>
          </AuthProvider>
        </MaybeClerkProvider>
        <Toaster />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
