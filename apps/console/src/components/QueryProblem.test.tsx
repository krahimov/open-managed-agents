import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import { QueryProblem } from "./QueryProblem";

describe("QueryProblem", () => {
  it("never shows a bare server token: it says what kind of failure it was", () => {
    render(<QueryProblem title="Vaults could not be loaded" error={new ApiError({ status: 500, code: "unavailable", message: "unavailable" })} />);
    expect(screen.getByText("Vaults could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("The server had a problem (“unavailable”). Try again in a moment.")).toBeInTheDocument();
    expect(screen.queryByText(/^unavailable$/)).not.toBeInTheDocument();
  });

  it("keeps a server message that already reads as a sentence", () => {
    render(<QueryProblem title="Usage could not be loaded" error={new ApiError({ status: 403, code: "forbidden", message: "Usage is only visible to workspace admins" })} />);
    expect(screen.getByText("Usage is only visible to workspace admins.")).toBeInTheDocument();
  });

  it("words a network failure as one", () => {
    render(<QueryProblem compact title="Files could not be loaded" error={new TypeError("Failed to fetch")} />);
    expect(screen.getByText(/The server could not be reached/)).toBeInTheDocument();
  });
});
