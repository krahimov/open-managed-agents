import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { authClient } from "./auth-client";

interface User {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

interface AuthCtx {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthCtx>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: authInfo, isLoading: isAuthInfoLoading } = useQuery<{
    auth_disabled?: boolean;
  }>({
    queryKey: ["/auth-info", "auth-mode"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/auth-info", { credentials: "include", signal });
      if (!res.ok) throw new Error(`auth-info failed: ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
    retry: 1,
  });

  const authDisabled = authInfo?.auth_disabled === true;
  if (authDisabled) {
    return (
      <AuthContext.Provider
        value={{
          user: {
            id: "dev-auth-disabled",
            name: "Local Dev",
            email: "dev@localhost",
            image: null,
          },
          isLoading: false,
          isAuthenticated: true,
        }}
      >
        {children}
      </AuthContext.Provider>
    );
  }

  if (isAuthInfoLoading) {
    return (
      <AuthContext.Provider
        value={{
          user: null,
          isLoading: true,
          isAuthenticated: false,
        }}
      >
        {children}
      </AuthContext.Provider>
    );
  }

  return <SessionAuthProvider>{children}</SessionAuthProvider>;
}

function SessionAuthProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();
  const sessionUser = session?.user
    ? {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        image: session.user.image,
      }
    : null;
  const user = sessionUser;

  return (
    <AuthContext.Provider
      value={{
        user,
        // Only "loading" when we have no user yet. Background session
        // revalidations (focus/network/timer) flip isPending back to
        // true momentarily even with a valid session — without this
        // guard, Layout briefly returns the BrandLoader, the sidebar
        // unmounts, and any click landing in that 50-200ms window gets
        // lost (the link's <a> tag is mid-unmount, React Router never
        // sees the navigation). Symptom: random "click does nothing,
        // refresh fixes it".
        isLoading: isPending && !user,
        isAuthenticated: !!user,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
