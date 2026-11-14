// GET /v1/workspace/access — a read-only shim that tells the console who the
// caller is in this workspace.
//
// The console (Muse) gates tool approvals, the access-policy editor and the
// workspace page on `authorization.role`. This server has no role-based
// access control: every member can do everything in the workspaces they
// belong to, and an API key acts with full access. So the shim reports the
// truth in the console's vocabulary:
//
//   - a signed-in user whose membership role is "owner" → owner
//   - any other member ("member", or a role this server doesn't know) → admin
//   - auth disabled (single-operator dev) → owner, kind "development"
//   - an API key → owner, kind "api_key"
//
// `authorization` is never null. A null value would turn the console's
// "can operate" check off, which locks approvals and hides the policy
// editor, both of which main's console gives every member today.
//
// Nothing here changes what anyone may do; enforcement is unchanged.

import { Hono } from "hono";

export type ConsoleWorkspaceRole = "owner" | "admin" | "operator" | "viewer";
export type AccessKind = "session" | "api_key" | "development";

export interface WorkspaceAccessBody {
  authorization: { role: ConsoleWorkspaceRole; kind: AccessKind };
  budgets_supported: false;
}

export interface WorkspaceAccessDeps {
  /** The caller's membership role in `tenantId`, or null when there is no row. */
  membershipRole(userId: string, tenantId: string): Promise<string | null>;
}

/** Main's membership roles are only "owner" and "member" (Clerk org admins map to owner). */
export function consoleRoleFor(membershipRole: string | null | undefined): ConsoleWorkspaceRole {
  return membershipRole === "owner" ? "owner" : "admin";
}

export async function resolveWorkspaceAccess(
  input: { authType?: string; userId?: string; tenantId: string },
  deps: WorkspaceAccessDeps,
): Promise<WorkspaceAccessBody> {
  const body = (role: ConsoleWorkspaceRole, kind: AccessKind): WorkspaceAccessBody => ({
    authorization: { role, kind },
    budgets_supported: false,
  });
  if (input.authType === "disabled") return body("owner", "development");
  if (input.authType === "api_key") return body("owner", "api_key");
  if (!input.userId) return body("owner", "development");
  let role: string | null = null;
  try {
    role = await deps.membershipRole(input.userId, input.tenantId);
  } catch {
    // A failed lookup must not lock the console; this server does not
    // enforce roles, so "admin" is still the truth about what they can do.
    role = null;
  }
  return body(consoleRoleFor(role), "session");
}

/** Mounted at /v1/workspace (inside the authenticated v1 app). */
export function buildWorkspaceAccessRoutes(deps: WorkspaceAccessDeps) {
  const app = new Hono<{ Variables: { tenant_id: string; user_id?: string; auth_type?: string } }>();
  app.get("/access", async (c) =>
    c.json(
      await resolveWorkspaceAccess(
        { authType: c.get("auth_type"), userId: c.get("user_id"), tenantId: c.get("tenant_id") },
        deps,
      ),
    ),
  );
  return app;
}
