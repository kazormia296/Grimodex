// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AliasesField } from "./AliasesField";

describe("AliasesField", () => {
  it("renders existing aliases as pills", () => {
    render(
      <AliasesField
        label="Aliases"
        aliases={["エララ", "the apprentice"]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("エララ")).toBeInTheDocument();
    expect(screen.getByText("the apprentice")).toBeInTheDocument();
  });

  it("renders the label", () => {
    render(<AliasesField label="Aliases" aliases={[]} onChange={vi.fn()} />);
    expect(screen.getByText("Aliases")).toBeInTheDocument();
  });

  it("renders [+] button when no aliases", () => {
    render(<AliasesField label="Aliases" aliases={[]} onChange={vi.fn()} />);
    expect(screen.getByTestId("aliases-add-button")).toBeInTheDocument();
  });

  it("shows input when [+] is clicked", async () => {
    const user = userEvent.setup();
    render(<AliasesField label="Aliases" aliases={[]} onChange={vi.fn()} />);
    await user.click(screen.getByTestId("aliases-add-button"));
    expect(screen.getByTestId("aliases-input")).toBeInTheDocument();
  });

  it("adds new alias on Enter and calls onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AliasesField label="Aliases" aliases={[]} onChange={onChange} />);

    await user.click(screen.getByTestId("aliases-add-button"));
    await user.type(screen.getByTestId("aliases-input"), "新しい別名");
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith(["新しい別名"]);
  });

  it("does not submit when Enter confirms an IME composition", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AliasesField label="Aliases" aliases={[]} onChange={onChange} />);

    await user.click(screen.getByTestId("aliases-add-button"));
    const input = screen.getByTestId("aliases-input");
    await user.type(input, "せつな");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(onChange).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("せつな");
  });

  it("appends new alias to existing aliases", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AliasesField label="Aliases" aliases={["エララ"]} onChange={onChange} />,
    );

    await user.click(screen.getByTestId("aliases-add-button"));
    await user.type(screen.getByTestId("aliases-input"), "the apprentice");
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith(["エララ", "the apprentice"]);
  });

  it("removes alias when delete button is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AliasesField
        label="Aliases"
        aliases={["エララ", "the apprentice"]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByTestId("aliases-remove-0"));

    expect(onChange).toHaveBeenCalledWith(["the apprentice"]);
  });

  it("does not add empty alias", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AliasesField label="Aliases" aliases={[]} onChange={onChange} />);

    await user.click(screen.getByTestId("aliases-add-button"));
    await user.keyboard("{Enter}");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("cancels input on Escape", async () => {
    const user = userEvent.setup();
    render(<AliasesField label="Aliases" aliases={[]} onChange={vi.fn()} />);

    await user.click(screen.getByTestId("aliases-add-button"));
    expect(screen.getByTestId("aliases-input")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("aliases-input")).not.toBeInTheDocument();
  });
});
