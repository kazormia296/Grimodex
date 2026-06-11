// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReasoningEffortChip } from "./ReasoningEffortChip";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

type Props = React.ComponentProps<typeof ReasoningEffortChip>;

function baseProps(over: Partial<Props> = {}): Props {
  return {
    value: null,
    options: ["low", "medium", "high"],
    thinkingEnabled: true,
    onChange: vi.fn(),
    ...over,
  };
}

describe("ReasoningEffortChip", () => {
  it("shows the Auto label when no override is set", () => {
    render(<ReasoningEffortChip {...baseProps()} />);
    expect(screen.getByText("chat.reasoningEffortAuto")).toBeInTheDocument();
  });

  it("shows the current effort value when an override is set", () => {
    render(<ReasoningEffortChip {...baseProps({ value: "high" })} />);
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("opens a menu listing Auto plus all allowed values", () => {
    render(<ReasoningEffortChip {...baseProps()} />);
    fireEvent.click(screen.getByRole("button"));
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "chat.reasoningEffortAuto",
      "low",
      "medium",
      "high",
    ]);
  });

  it("calls onChange with the selected value and closes the menu", () => {
    const onChange = vi.fn();
    render(<ReasoningEffortChip {...baseProps({ onChange })} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("option", { name: "medium" }));
    expect(onChange).toHaveBeenCalledWith("medium");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("calls onChange with null when Auto is selected", () => {
    const onChange = vi.fn();
    render(<ReasoningEffortChip {...baseProps({ value: "high", onChange })} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(
      screen.getByRole("option", { name: "chat.reasoningEffortAuto" }),
    );
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("marks the active option with aria-selected", () => {
    render(<ReasoningEffortChip {...baseProps({ value: "medium" })} />);
    fireEvent.click(screen.getByRole("button"));
    const options = screen.getAllByRole("option");
    expect(
      options.map((o) => [o.textContent, o.getAttribute("aria-selected")]),
    ).toEqual([
      ["chat.reasoningEffortAuto", "false"],
      ["low", "false"],
      ["medium", "true"],
      ["high", "false"],
    ]);
  });

  it("is disabled while thinking is off and does not open the menu", () => {
    render(<ReasoningEffortChip {...baseProps({ thinkingEnabled: false })} />);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("is disabled when only one effort value is allowed", () => {
    render(<ReasoningEffortChip {...baseProps({ options: ["high"] })} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("closes the menu on outside click without calling onChange", () => {
    const onChange = vi.fn();
    render(<ReasoningEffortChip {...baseProps({ onChange })} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
