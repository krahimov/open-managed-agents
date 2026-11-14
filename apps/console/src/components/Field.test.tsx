import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Combobox } from "./Combobox";
import { Field } from "./Field";
import { SecretInput } from "./Input";
import { MemoryModeControl } from "./MemoryModeControl";
import { SegmentedControl } from "./SegmentedControl";
import { Select, SelectOption } from "./Select";

/**
 * The Field contract: whatever the control is made of, the visible label
 * names it, a click on the label reaches it, and the hint or the error is
 * read out with it (aria-describedby and aria-invalid on the element that
 * takes focus).
 */
describe("Field with a composed control", () => {
  it("names a Select by its label, and the label points at the trigger", () => {
    render(
      <Field label="Applies to" hint="Agent limits apply alongside the workspace limits.">
        <Select value="workspace" onValueChange={() => {}} placeholder="Budget scope">
          <SelectOption value="workspace">Entire workspace</SelectOption>
        </Select>
      </Field>,
    );
    const trigger = screen.getByRole("combobox", { name: "Applies to" });
    const label = screen.getByText("Applies to").closest("label")!;
    expect(label.htmlFor).toBe(trigger.id);
    expect(document.getElementById(label.htmlFor)).toBe(trigger);
    // The hint is read with it.
    const hintId = trigger.getAttribute("aria-describedby")!;
    expect(document.getElementById(hintId)?.textContent).toContain("Agent limits apply");
  });

  it("focuses the Select when its label is clicked, without opening it", () => {
    render(
      <Field label="Applies to">
        <Select value="workspace" onValueChange={() => {}}>
          <SelectOption value="workspace">Entire workspace</SelectOption>
        </Select>
      </Field>,
    );
    fireEvent.click(screen.getByText("Applies to"));
    const trigger = screen.getByRole("combobox", { name: "Applies to" });
    expect(document.activeElement).toBe(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("announces an error on the Select: invalid, and described by the message", () => {
    render(
      <Field label="Applies to" error="Choose who this limit applies to.">
        <Select value="" onValueChange={() => {}} placeholder="Budget scope">
          <SelectOption value="workspace">Entire workspace</SelectOption>
        </Select>
      </Field>,
    );
    const trigger = screen.getByRole("combobox", { name: "Applies to" });
    expect(trigger).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById(trigger.getAttribute("aria-describedby")!)).toHaveTextContent(
      "Choose who this limit applies to.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Choose who this limit applies to.");
  });

  it("keeps the placeholder as the name of a Select with no label", () => {
    render(
      <Select value="" onValueChange={() => {}} placeholder="Access">
        <SelectOption value="read_only">Read only</SelectOption>
      </Select>,
    );
    expect(screen.getByRole("combobox", { name: "Access" })).toBeInTheDocument();
  });

  it("adds the hint to a description the control already had, instead of replacing it", () => {
    render(
      <>
        <p id="own">Own description</p>
        <Field label="Name" hint="Letters and dashes.">
          <input aria-describedby="own" />
        </Field>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    const ids = input.getAttribute("aria-describedby")!.split(" ");
    expect(ids).toContain("own");
    expect(ids).toHaveLength(2);
  });

  it("names a Combobox button and focuses it from the label", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Field label="Agent" error="Choose an agent.">
          <Combobox<{ id: string }>
            value=""
            onValueChange={() => {}}
            endpoint="/v1/agents"
            getValue={(a) => a.id}
            getLabel={(a) => a.id}
          />
        </Field>
      </QueryClientProvider>,
    );
    const button = screen.getByRole("combobox", { name: "Agent" });
    expect(button).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByText("Agent"));
    expect(document.activeElement).toBe(button);
  });

  it("names a segmented control by its label and focuses the chosen option from it", () => {
    render(
      <Field label="Trials">
        <SegmentedControl
          value="3"
          onChange={() => {}}
          options={[
            { value: "1", label: "1" },
            { value: "3", label: "3" },
          ]}
        />
      </Field>,
    );
    expect(screen.getByRole("radiogroup", { name: "Trials" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Trials"));
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "3" }));
  });

  it("gives the memory mode its label and reads what the mode means with it", () => {
    render(
      <Field label="Memory">
        <MemoryModeControl value="shared" onChange={() => {}} />
      </Field>,
    );
    const group = screen.getByRole("radiogroup", { name: "Memory" });
    const described = group
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toContain("One memory for this agent");
    fireEvent.click(screen.getByText("Memory"));
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Shared" }));
  });

  it("names a SecretInput by its own label and reads its hint, on the input, not the box around it", () => {
    render(<SecretInput label="API key" hint="Stored encrypted." placeholder="sk-..." />);
    const input = screen.getByLabelText("API key");
    expect(input.tagName).toBe("INPUT");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe("Stored encrypted.");
    // The label points at the input itself (jsdom does not move focus on a label click; the browser does).
    expect(screen.getByText("API key").closest("label")!.htmlFor).toBe(input.id);
  });

  it("names a SecretInput inside a Field the same way", () => {
    render(
      <Field label="Webhook signing secret" hint="Starts with lin_wh_">
        <SecretInput />
      </Field>,
    );
    const input = screen.getByLabelText("Webhook signing secret");
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
  });
});
