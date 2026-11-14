import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { MemoryEnabledCard } from "./MemoryEnabledCard";

const show = (event: Record<string, unknown>) =>
  render(
    <MemoryRouter>
      <MemoryEnabledCard event={{ type: "system.memory_enabled", ...event } as never} />
    </MemoryRouter>,
  );

it("says memory is on, links the store, and says what it applies to", () => {
  show({
    mode: "shared",
    store_id: "memstore-1",
    store_name: "agent-abc-memory",
    source: "setup",
    newly_enabled: true,
  });
  expect(screen.getByText("Memory enabled")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "agent-abc-memory" })).toHaveAttribute("href", "/memory/memstore-1");
  expect(screen.getByText("every new session of this agent, scheduled runs included")).toBeInTheDocument();
  expect(screen.queryByText(/turned on with the schedule/)).not.toBeInTheDocument();
});

it("explains why when a schedule turned it on", () => {
  show({ mode: "shared", store_id: "memstore-1", store_name: "agent-abc-memory", source: "ambient_rule" });
  expect(screen.getByText("turned on with the schedule — each run is a fresh session")).toBeInTheDocument();
});

it("renders per-user mode without a store row", () => {
  show({ mode: "per_user", source: "setup" });
  expect(screen.getByText("every new session, one store per user")).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
