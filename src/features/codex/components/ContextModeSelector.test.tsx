// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextModeSelector } from "./ContextModeSelector";

describe("ContextModeSelector", () => {
  it("renders with the current value selected", () => {
    render(<ContextModeSelector value="mentioned" onChange={vi.fn()} />);
    const select = screen.getByTestId("context-mode-selector");
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue("mentioned");
  });

  it("shows all four context modes", () => {
    render(<ContextModeSelector value="mentioned" onChange={vi.fn()} />);
    expect(screen.getByText(/常に含める/)).toBeInTheDocument();
    expect(screen.getByText(/言及時/)).toBeInTheDocument();
    expect(screen.getByText(/手動のみ/)).toBeInTheDocument();
    expect(screen.getByText(/AI から除外/)).toBeInTheDocument();
  });

  it("calls onChange with new value when selection changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ContextModeSelector value="mentioned" onChange={onChange} />);

    await user.selectOptions(
      screen.getByTestId("context-mode-selector"),
      "always",
    );

    expect(onChange).toHaveBeenCalledWith("always");
  });

  it("renders with 'always' value", () => {
    render(<ContextModeSelector value="always" onChange={vi.fn()} />);
    expect(screen.getByTestId("context-mode-selector")).toHaveValue("always");
  });

  it("renders with 'hidden' value", () => {
    render(<ContextModeSelector value="hidden" onChange={vi.fn()} />);
    expect(screen.getByTestId("context-mode-selector")).toHaveValue("hidden");
  });
});
