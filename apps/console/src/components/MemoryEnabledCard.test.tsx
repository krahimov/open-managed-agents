import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { MemoryEnabledCard } from "./MemoryEnabledCard";

const show = (event: Record<string, unknown>) =>
  render(
    // The store is named by the card itself; nothing is looked up.
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <MemoryEnabledCard event={{ type: "system.memory_enabled", ...event } as never} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

it("says memory is on, links the store by name, and says what it applies to", () => {
  show({ mode: "shared", store_id: "memstore-1", store_name: "agent-abc-memory", source: "setup", newly_enabled: true });
  expect(screen.getByText("Memory turned on")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /agent-abc-memory/ })).toHaveAttribute("href", "/memory/memstore-1");
  expect(screen.getByText("Applies to every new session of this agent, scheduled runs included.")).toBeInTheDocument();
  expect(screen.queryByText(/Turned on with the trigger/)).not.toBeInTheDocument();
  expect(screen.getByText(/Turn it off on the agent's page/)).toBeInTheDocument();
});

it("explains why when a trigger turned it on", () => {
  show({ mode: "shared", store_id: "memstore-1", store_name: "agent-abc-memory", source: "ambient_rule" });
  expect(screen.getByText(/Turned on with the trigger: each run is a fresh session/)).toBeInTheDocument();
});

it("per-user memory has no single store to show", () => {
  show({ mode: "per_user", source: "setup" });
  expect(screen.getByText("Applies to every new session, with one store per person.")).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
