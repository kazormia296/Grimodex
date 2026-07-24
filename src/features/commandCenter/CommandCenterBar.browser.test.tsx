import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("CommandCenterBar Electron drag CSS", () => {
  beforeEach(() => {
    document.documentElement.dataset.shell = "electron";
    useBarStore.getState().reset();
    useBarStore.getState().setOpen(false);
    useBarStore.getState().setMode("search");
  });

  afterEach(() => {
    delete document.documentElement.dataset.shell;
  });

  it("maps the frame to drag and the input to no-drag in Chromium", () => {
    render(<CommandCenterBar />);

    const dragRegion = screen.getByTestId("command-center-drag-region");
    const input = screen.getByRole("textbox");

    expect(
      getComputedStyle(
        screen.getByTestId("command-center-bar"),
      ).getPropertyValue("-webkit-app-region"),
    ).toBe("drag");
    expect(
      getComputedStyle(dragRegion).getPropertyValue("-webkit-app-region"),
    ).toBe("drag");
    expect(getComputedStyle(input).getPropertyValue("-webkit-app-region")).toBe(
      "no-drag",
    );
    expect(dragRegion.getBoundingClientRect().width).toBeGreaterThan(
      input.getBoundingClientRect().width,
    );
  });
});
