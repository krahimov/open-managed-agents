// Public surface — every mount factory and the shared types.
//
// CF + Node both `import { buildXxxRoutes, type RouteServices } from
// "@open-managed-agents/http-routes"`, build their services bundle, and
// mount the routes under the same paths.

export type {
  RouteServices,
  RouteServicesArg,
  EventStreamHub,
  BackgroundRunner,
  SessionRegistryLike,
} from "./types";
export { resolveServices } from "./types";

export { buildAgentRoutes } from "./agents";
export type { AgentRoutesDeps } from "./agents";

export {
  buildVaultRoutes,
  listComposioToolkits,
  createComposioToolRouterSession,
  listComposioConnectedAccounts,
} from "./vaults";
export type { VaultRoutesDeps } from "./vaults";

export { buildSessionRoutes } from "./sessions";
export type {
  SessionRoutesDeps,
  SessionLifecycleHooks,
  OutputsAdapter,
} from "./sessions";

export { buildMemoryRoutes } from "./memory";
export type { MemoryRoutesDeps } from "./memory";

export { buildTenantRoutes, buildMeRoutes } from "./tenants";
export type { TenantRoutesDeps, MeRoutesDeps } from "./tenants";

export {
  buildApiKeyRoutes,
  mintApiKeyOnStorage,
  apiKeyMintForbidden,
  sha256Hex,
} from "./api-keys";

export {
  bindOAuthInitiator,
  gateOAuthStart,
  inlineScriptJson,
  isLoopbackRedirect,
  mintOAuthStartToken,
  verifyOAuthInitiator,
  OAUTH_START_CONFIRM_PARAM,
  OAUTH_STATE_TTL_SECONDS,
} from "./oauth-initiator";
export type {
  OAuthInitiator,
  OAuthInitiatorAuth,
  OAuthInitiatorCheck,
  OAuthStartGate,
  OAuthStartKv,
  OAuthStartTokenResult,
} from "./oauth-initiator";
export type {
  ApiKeyRoutesDeps,
  ApiKeyStorage,
  ApiKeyRecord,
  ApiKeyMeta,
} from "./api-keys";

export { buildEvalRoutes } from "./evals";
export type { EvalRoutesDeps, EvalTaskSpec } from "./evals";

export {
  buildDeploymentRoutes,
  buildPublicGatewayRoutes,
  kvDeploymentStorage,
} from "./deployments";
export type {
  DeploymentRecord,
  DeploymentStorage,
  DeploymentRoutesDeps,
  PublicGatewayDeps,
  PublicDeployment,
  HonoFetchable,
} from "./deployments";

export {
  handleFileUpload,
  contentDispositionAttachment,
  sanitizeUploadFilename,
  normalizeUploadMediaType,
  resolveUploadMaxBytes,
  DEFAULT_UPLOAD_MAX_BYTES,
  MAX_UPLOAD_FILENAME_LENGTH,
} from "./files/upload";
export type { FileUploadDeps } from "./files/upload";

export { buildIntegrationsRoutes } from "./integrations";
export type {
  IntegrationsRoutesDeps,
  IntegrationsBags,
  IntegrationsRepoBag,
  InstallProxyForwarder,
} from "./integrations";

export { buildIntegrationsGatewayRoutes } from "./integrations/gateway";
export type {
  IntegrationsGatewayDeps,
  WebhookHandler,
  WebhookHandlers,
  RateLimitHooks,
} from "./integrations/gateway";
