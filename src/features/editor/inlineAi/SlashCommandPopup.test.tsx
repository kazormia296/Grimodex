// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SlashCommandPopup } from "./SlashCommandPopup";
import { useSlashCommandStore } from "./slashCommandStore";
import { getInlineAiCommands } from "./inlineAiCommands";
import type { InlineAiCommand } from "./inlineAiTypes";

const rect = { top: 100, left: 50, bottom: 116 };

function openWith(
  items: InlineAiCommand[],
  query = "",
  commandFn: (c: InlineAiCommand) => void = () => {},
) {
  useSlashCommandStore.getState().open({ items, query, rect, commandFn });
}

describe("SlashCommandPopup", () => {
  beforeEach(() => {
    useSlashCommandStore.getState().close();
  });
  afterEach(() => {
    cleanup();
    useSlashCommandStore.getState().close();
  });

  it("renders the localized command label, not only the raw id", () => {
    const cmds = getInlineAiCommands();
    const cont = cmds.find((c) => c.id === "continue")!;
    openWith(cmds);
    render(<SlashCommandPopup />);
    // The localized label (e.g. 続きを書く / Continue) must be visible.
    expect(screen.getByText(cont.label)).toBeInTheDocument();
  });

  it("exposes listbox/option a11y roles", () => {
    const cmds = getInlineAiCommands();
    openWith(cmds);
    render(<SlashCommandPopup />);
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    // aria-activedescendant を機能させるため listbox は focusable (tabindex=-1)。
    expect(listbox).toHaveAttribute("tabindex", "-1");
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(cmds.length);
    // First option is selected by default.
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("shows a no-results affordance when a query matches nothing", () => {
    openWith([], "zzznomatch");
    render(<SlashCommandPopup />);
    expect(screen.getByTestId("slash-no-results")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(<SlashCommandPopup />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("invokes commandFn on click", () => {
    const cmds = getInlineAiCommands();
    const spy = vi.fn();
    openWith(cmds, "", spy);
    render(<SlashCommandPopup />);
    fireEvent.click(screen.getByText(cmds[1].label));
    expect(spy).toHaveBeenCalledWith(cmds[1]);
  });

  it("keyboard ArrowDown + Enter selects the second command", () => {
    const cmds = getInlineAiCommands();
    const spy = vi.fn();
    openWith(cmds, "", spy);
    render(<SlashCommandPopup />);
    const handler = useSlashCommandStore.getState().keyHandler!;
    expect(handler).toBeTypeOf("function");
    handler(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    handler(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(spy).toHaveBeenCalledWith(cmds[1]);
  });
});
