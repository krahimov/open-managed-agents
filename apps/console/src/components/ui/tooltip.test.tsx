import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Tip } from "../Tip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

/**
 * A dialog that puts the focus on a button with a tooltip (the avatar
 * button's "Change avatar" over the Name label) must not open that tooltip:
 * the person did not move there. Moving there inside the dialog does.
 */
function AvatarDialog() {
  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>Edit agent</DialogTitle>
        <DialogDescription>Saving creates a new version.</DialogDescription>
        <Tip label="Change avatar">
          <button type="button">Avatar</button>
        </Tip>
        <input aria-label="Name" />
      </DialogContent>
    </Dialog>
  );
}

describe("tooltips in a dialog", () => {
  it("do not open from the focus the dialog put there when it opened", async () => {
    render(<AvatarDialog />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const avatar = screen.getByRole("button", { name: "Avatar" });
    // The dialog moved focus somewhere in it; say it landed on the avatar button.
    act(() => avatar.focus());
    expect(document.activeElement).toBe(avatar);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("open when the person moves to the button within the dialog", async () => {
    render(<AvatarDialog />);
    const name = screen.getByRole("textbox", { name: "Name" });
    const avatar = screen.getByRole("button", { name: "Avatar" });
    act(() => name.focus());
    // Shift+Tab from Name: focus comes from inside the same dialog.
    act(() => {
      fireEvent.focus(avatar, { relatedTarget: name });
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Change avatar");
  });
});
