// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandCenterBar } from "./CommandCenterBar";
import { useBarStore } from "./store/commandCenterStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./hooks/useCommandCenterSearch", () => ({
  useCommandCenterSearch: vi.fn(),
}));

vi.mock("./hooks/useCommandCenterKeyboard", () => ({
  handleCommandCenterKeyDown: vi.fn(),
}));

vi.mock("./CommandCenterPopover", () => ({
  CommandCenterPopover: () => null,
}));

describe("CommandCenterBar window drag contract", () => {
  beforeEach(() => {
    useBarStore.getState().reset();
    useBarStore.getState().setOpen(false);
    useBarStore.getState().setMode("search");
  });

  it("makes the search-bar frame draggable while keeping the input interactive", async () => {
    render(<CommandCenterBar />);

    const bar = screen.getByTestId("command-center-bar");
    const dragRegion = screen.getByTestId("command-center-drag-region");
    const input = screen.getByRole("textbox");

    expect(bar).toHaveAttribute("data-tauri-drag-region");
    expect(bar).not.toHaveAttribute("data-tauri-drag-region", "false");
    expect(dragRegion).toHaveAttribute("data-tauri-drag-region");
    expect(dragRegion).not.toHaveAttribute("data-tauri-drag-region", "false");
    expect(input).toHaveAttribute("data-tauri-drag-region", "false");

    await userEvent.setup().type(input, "chapter");
    expect(useBarStore.getState().query).toBe("chapter");
  });
});
