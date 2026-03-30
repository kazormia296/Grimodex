import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorPanel } from "./EditorPanel";

describe("EditorPanel", () => {
  it("renders the editor area", () => {
    render(<EditorPanel />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("displays character count", () => {
    render(<EditorPanel />);
    expect(screen.getByTestId("char-count")).toHaveTextContent("0");
  });

  it("updates character count when text is typed", async () => {
    const user = userEvent.setup();
    render(<EditorPanel />);
    const editor = screen.getByRole("textbox");
    await user.click(editor);
    await user.type(editor, "Hello");
    expect(screen.getByTestId("char-count")).not.toHaveTextContent("0");
  });

  it("renders toolbar with bold, italic, heading, and list buttons", () => {
    render(<EditorPanel />);
    expect(screen.getByRole("button", { name: /bold/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /italic/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /heading/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /list/i })).toBeInTheDocument();
  });
});

describe("Markdown export", () => {
  it("exports editor content as markdown", async () => {
    const user = userEvent.setup();
    render(<EditorPanel />);
    const editor = screen.getByRole("textbox");
    await user.click(editor);
    await user.type(editor, "Hello world");
    const exportBtn = screen.getByRole("button", { name: /export/i });
    await user.click(exportBtn);
    const output = screen.getByTestId("markdown-output");
    expect(output.textContent).toContain("Hello world");
  });
});
