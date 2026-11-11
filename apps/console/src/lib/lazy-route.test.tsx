import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { lazyRoute, ReloadingPlaceholder } from "./lazy-route";

function SessionDetail() {
  return <p>session</p>;
}

it("returns the named export as the route Component", async () => {
  const lazy = lazyRoute(async () => ({ SessionDetail }), "SessionDetail");
  const { Component } = await lazy();
  expect(Component).toBe(SessionDetail);
  render(<Component />);
  expect(screen.getByText("session")).toBeTruthy();
});

it("renders a placeholder when a reload swallowed the preload error and the import resolved to undefined", async () => {
  // vite's __vitePreload resolves to undefined once vite:preloadError is
  // preventDefault()ed; destructuring that used to throw into the route
  // error UI ("Cannot destructure property 'SessionDetail' ...").
  const lazy = lazyRoute<{ SessionDetail: typeof SessionDetail }, "SessionDetail">(
    async () => undefined,
    "SessionDetail",
  );
  const { Component } = await lazy();
  expect(Component).toBe(ReloadingPlaceholder);
  render(<Component />);
  expect(screen.getByRole("status").textContent).toBe("Loading the new version…");
});

it("throws a clear chunk error when the module loaded but lacks the export", async () => {
  const lazy = lazyRoute(
    async () => ({ SessionDetail: undefined }) as unknown as { SessionDetail: typeof SessionDetail },
    "SessionDetail",
  );
  await expect(lazy()).rejects.toThrow(/route chunk: it has no "SessionDetail" export/);
});

it("passes a real import failure through to the route error UI", async () => {
  const lazy = lazyRoute<{ SessionDetail: typeof SessionDetail }, "SessionDetail">(
    async () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    },
    "SessionDetail",
  );
  await expect(lazy()).rejects.toThrow("Failed to fetch dynamically imported module");
});
