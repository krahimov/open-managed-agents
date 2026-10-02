import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToolConfirmationControls } from "./ToolConfirmationControls";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ useApi: () => ({ api }) }));

beforeEach(() => api.mockReset().mockResolvedValue({}));
afterEach(() => cleanup());

const posted = () => JSON.parse((api.mock.calls[0][1] as RequestInit).body as string);

it("approves with a user.tool_confirmation allow event", async () => {
  render(<ToolConfirmationControls sessionId="sess-1" toolUseId="call_1" />);
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Approved");
  expect(api).toHaveBeenCalledWith("/v1/sessions/sess-1/events", expect.objectContaining({ method: "POST" }));
  expect(posted()).toEqual({ events: [{ type: "user.tool_confirmation", tool_use_id: "call_1", result: "allow" }] });
});

it("denies with the optional reason as deny_message", async () => {
  render(<ToolConfirmationControls sessionId="sess-1" toolUseId="call_2" />);
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  fireEvent.change(screen.getByLabelText("Deny reason"), { target: { value: "  not on prod  " } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm deny" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Denied");
  expect(posted()).toEqual({
    events: [{ type: "user.tool_confirmation", tool_use_id: "call_2", result: "deny", deny_message: "not on prod" }],
  });
});

it("omits deny_message when no reason is given and addresses sub-agent threads", async () => {
  render(<ToolConfirmationControls sessionId="sess-1" toolUseId="call_3" threadId="sthr_worker" />);
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm deny" }));
  await screen.findByRole("status");
  expect(posted()).toEqual({
    events: [{ type: "user.tool_confirmation", tool_use_id: "call_3", result: "deny", session_thread_id: "sthr_worker" }],
  });
});

it("keeps the controls available after a failed post", async () => {
  api.mockRejectedValueOnce(new Error("boom"));
  render(<ToolConfirmationControls sessionId="sess-1" toolUseId="call_4" />);
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
  expect(screen.queryByRole("status")).toBeNull();
});
