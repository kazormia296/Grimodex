// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useBackgroundStudioStore } from "./background/backgroundStudioStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { title?: string }) =>
      `Zen${options?.title ? ` · ${options.title}` : ""} · Escで終了`,
  }),
}));

import { ZenModeController } from "./ZenModeController";

function dispatchEscape(options?: {
  defaultPrevented?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}) {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  if (options?.defaultPrevented) event.preventDefault();
  if (options?.isComposing) {
    Object.defineProperty(event, "isComposing", { value: true });
  }
  if (options?.keyCode !== undefined) {
    Object.defineProperty(event, "keyCode", { value: options.keyCode });
  }
  act(() => window.dispatchEvent(event));
  return event;
}

describe("ZenModeController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCursorSettingsStore.setState({ zenMode: false });
    useBackgroundStudioStore.setState({ open: false });
    useTreeStore.setState({
      activeSceneId: "scene-1",
      nodes: [{ id: "scene-1", title: "雨の駅", nodeType: "scene" }],
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a temporary non-interactive entry hint and then removes it", () => {
    render(<ZenModeController />);
    act(() => useCursorSettingsStore.setState({ zenMode: true }));

    const hint = screen.getByRole("status");
    expect(hint).toHaveTextContent("Zen · 雨の駅 · Escで終了");
    expect(hint).toHaveClass("pointer-events-none");

    act(() => vi.advanceTimersByTime(2_500));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("exits on an unhandled Escape", () => {
    useCursorSettingsStore.setState({ zenMode: true });
    render(<ZenModeController />);

    const event = dispatchEscape();

    expect(event.defaultPrevented).toBe(true);
    expect(useCursorSettingsStore.getState().zenMode).toBe(false);
  });

  it("closes the live background studio before leaving Zen", () => {
    useCursorSettingsStore.setState({ zenMode: true });
    useBackgroundStudioStore.setState({ open: true });
    render(<ZenModeController />);

    dispatchEscape();

    expect(useBackgroundStudioStore.getState().open).toBe(false);
    expect(useCursorSettingsStore.getState().zenMode).toBe(true);
  });

  it.each([
    ["an already handled Escape", { defaultPrevented: true }],
    ["an IME composition Escape", { isComposing: true }],
    ["an IME process Escape", { keyCode: 229 }],
  ])("does not exit for %s", (_label, options) => {
    useCursorSettingsStore.setState({ zenMode: true });
    render(<ZenModeController />);

    dispatchEscape(options);

    expect(useCursorSettingsStore.getState().zenMode).toBe(true);
  });
});
