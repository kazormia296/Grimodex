// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useTreeStore } from "@/features/tree/treeStore";

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
  act(() => window.dispatchEvent(event));
  return event;
}

describe("ZenModeController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCursorSettingsStore.setState({ zenMode: false });
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

  it.each([
    ["an already handled Escape", { defaultPrevented: true }],
    ["an IME composition Escape", { isComposing: true }],
  ])("does not exit for %s", (_label, options) => {
    useCursorSettingsStore.setState({ zenMode: true });
    render(<ZenModeController />);

    dispatchEscape(options);

    expect(useCursorSettingsStore.getState().zenMode).toBe(true);
  });
});
