import type { ComponentType } from "react";

/**
 * `lazy:` for a data-router route whose page is a named export of a chunk.
 *
 * When a chunk preload fails, chunk-reload.ts may decide to reload and calls
 * `preventDefault()` on `vite:preloadError`. Vite's preload wrapper then
 * swallows the error and the dynamic import RESOLVES TO `undefined`
 * (vite 6.4 `preload()`: `baseModule().catch(handlePreloadError)`, where
 * `handlePreloadError` only rethrows `if (!e.defaultPrevented)`). Destructuring
 * that module threw "Cannot destructure property 'SessionDetail' of
 * '(intermediate value)' as it is undefined" into the route error UI while the
 * reload was under way. An undefined module therefore renders a neutral
 * placeholder; a loaded module without the export is a real error.
 */
export function lazyRoute<M, K extends keyof M & string>(
  load: () => Promise<M | undefined>,
  exportName: K,
): () => Promise<{ Component: ComponentType }> {
  return async () => {
    const mod = await load();
    if (mod == null) return { Component: ReloadingPlaceholder };
    const Component = mod[exportName];
    if (typeof Component !== "function" && (typeof Component !== "object" || Component === null)) {
      throw new Error(
        `Failed to load route chunk: it has no "${exportName}" export. Reload the page to get the latest version.`,
      );
    }
    return { Component: Component as ComponentType };
  };
}

/** Shown while chunk-reload.ts loads the fresh build. */
export function ReloadingPlaceholder() {
  return (
    <div role="status" className="flex flex-1 items-center justify-center p-8 text-sm text-fg-muted">
      Loading the new version…
    </div>
  );
}
