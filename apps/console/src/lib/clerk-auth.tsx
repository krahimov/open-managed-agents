// Clerk sign-in path for the console — active only when the build sets
// VITE_CLERK_PUBLISHABLE_KEY (and the backend advertises "clerk" in
// /auth-info). better-auth remains the default; with Clerk enabled the
// console renders Clerk's <SignIn/> and every api() call carries
// `Authorization: Bearer <session token>` which main-node verifies
// against the instance JWKS (see apps/main-node/src/lib/clerk.ts).
//
// The token bridge exists because api.ts is a plain module (no React
// context): ClerkTokenBridge registers a getToken closure at mount, and
// getClerkBearerToken() hands api()/streamEvents a fresh short-lived
// token per request (Clerk SDK caches + refreshes internally).

import { type ReactNode, useEffect } from "react";
import {
  ClerkProvider,
  SignIn,
  useAuth as useClerkAuth,
  useUser as useClerkUser,
} from "@clerk/clerk-react";

export const CLERK_PUBLISHABLE_KEY =
  (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) || undefined;

export const clerkEnabled = !!CLERK_PUBLISHABLE_KEY;

// ── Token bridge (module-scope so api.ts can reach it) ──────────────────

let tokenGetter: (() => Promise<string | null>) | null = null;

export function setClerkTokenGetter(fn: (() => Promise<string | null>) | null): void {
  tokenGetter = fn;
}

/** Fresh session token for the current Clerk user; null when Clerk is
 *  disabled, not mounted yet, or signed out. Never throws — auth failures
 *  surface as backend 401s, which the app already handles. */
export async function getClerkBearerToken(): Promise<string | null> {
  if (!clerkEnabled || !tokenGetter) return null;
  try {
    return await tokenGetter();
  } catch {
    return null;
  }
}

function ClerkTokenBridge() {
  const { getToken } = useClerkAuth();
  useEffect(() => {
    setClerkTokenGetter(() => getToken());
    return () => setClerkTokenGetter(null);
  }, [getToken]);
  return null;
}

// ── Providers ────────────────────────────────────────────────────────────

/** Wraps children in ClerkProvider when configured; identity otherwise. */
export function MaybeClerkProvider({ children }: { children: ReactNode }) {
  if (!clerkEnabled) return <>{children}</>;
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY!} afterSignOutUrl="/login">
      <ClerkTokenBridge />
      {children}
    </ClerkProvider>
  );
}

interface ClerkCtxUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

/** AuthProvider branch for Clerk mode — maps Clerk's user to the same
 *  shape lib/auth.tsx's context exposes. Must be called under
 *  MaybeClerkProvider (mounted app-wide in main.tsx). */
export function useClerkMappedUser(): {
  user: ClerkCtxUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
} {
  const { isLoaded, user } = useClerkUser();
  const mapped: ClerkCtxUser | null = user
    ? {
        id: user.id,
        name: user.fullName || user.username || user.primaryEmailAddress?.emailAddress || "User",
        email: user.primaryEmailAddress?.emailAddress ?? "",
        image: user.imageUrl ?? null,
      }
    : null;
  return {
    user: mapped,
    isLoading: !isLoaded && !mapped,
    isAuthenticated: !!mapped,
  };
}

/** Centered Clerk sign-in screen used by pages/Login.tsx in Clerk mode. */
export function ClerkLoginScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <SignIn routing="hash" fallbackRedirectUrl="/" />
    </div>
  );
}
