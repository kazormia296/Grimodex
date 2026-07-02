// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

const { getBooleanMock } = vi.hoisted(() => ({
  getBooleanMock: vi.fn((_key: string, def?: boolean) => def ?? false),
}));

vi.mock("@gsap/react", () => ({ useGSAP: vi.fn() }));
vi.mock("gsap", () => ({ gsap: { fromTo: vi.fn() } }));
vi.mock("@/features/settings/settingsStore", () => {
  const state = { getBoolean: getBooleanMock };
  const useSettingsStore = Object.assign(
    (selector: (s: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return { useSettingsStore };
});

import { PanelHighlightOverlay } from "./PanelHighlightOverlay";

if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

function renderOverlay() {
  const panel = document.createElement("div");
  panel.setAttribute("data-slot-panel", "chat");
  document.body.appendChild(panel);
  render(<PanelHighlightOverlay panelId="chat" />);
  const inner = document.body.querySelector(".h-full.w-full");
  return inner?.parentElement as HTMLElement | null;
}

describe("PanelHighlightOverlay reduced motion", () => {
  beforeEach(() => {
    getBooleanMock.mockImplementation((_key, def) => def ?? false);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("applies position transition when motion is enabled", () => {
    const container = renderOverlay();
    expect(container).not.toBeNull();
    expect(container!.style.transition).toContain("left");
  });

  it("disables transition when app reduceMotion setting is on", () => {
    getBooleanMock.mockImplementation((key, def) =>
      key === "display.reduceMotion" ? true : (def ?? false),
    );
    const container = renderOverlay();
    expect(container).not.toBeNull();
    expect(container!.style.transition).toBe("none");
  });
});
