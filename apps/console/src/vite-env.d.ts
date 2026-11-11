/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Enables the Clerk sign-in path (lib/clerk-auth.tsx) when set at
   *  build time; absent → classic better-auth screens. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_PUBLIC_POSTHOG_PROJECT_TOKEN?: string;
  readonly VITE_PUBLIC_POSTHOG_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
