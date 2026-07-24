import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { showPanel, workspaceState } = vi.hoisted(() => ({
  showPanel: vi.fn(),
  workspaceState: {
    globalSettings: { defaultAiPolicy: null },
    setShowSampleTour: vi.fn(),
    updateGlobalSettings: vi.fn(() => Promise.resolve(true)),
    showLauncher: vi.fn(),
  },
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (selector: (state: typeof workspaceState) => unknown) =>
    selector(workspaceState),
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: {
    getState: () => ({ showPanel }),
  },
}));

vi.mock("./tourGates", () => ({
  useSceneOpenGate: () => true,
  useEditorWriteGate: () => true,
  useChatSentGate: () => true,
  useCodexExtractGate: () => true,
  useCodexViewGate: () => true,
  useSnippetUsedGate: () => true,
  usePanelDwellGate: () => true,
  usePostEffectRunGate: () => true,
}));

vi.mock("@gsap/react", () => ({
  useGSAP: () => undefined,
}));

vi.mock("gsap", () => ({
  gsap: {
    set: vi.fn(),
    fromTo: vi.fn(),
  },
}));

vi.mock("@/lib/gsap", () => ({
  isReducedMotion: () => true,
}));

vi.mock("@/lib/animation", () => ({
  DURATIONS: { fast: 0, normal: 0 },
  CSS_DURATIONS: { fast: "0ms" },
  EASINGS: {
    easeOut: [0, 0, 1, 1],
    spring: { type: "spring" },
  },
  useReducedMotion: () => true,
}));

vi.mock("motion/react", async () => {
  const { createElement, forwardRef } = await import("react");
  return {
    motion: {
      div: forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) =>
          createElement("div", { ...props, ref }, children),
      ),
    },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      children ?? null,
  };
});

import { SampleTour } from "./SampleTour";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SampleTour layering", () => {
  it("portals the explanation card above the blur layer outside app-shell", () => {
    const { getByRole, getByTestId } = render(
      <div className="app-shell" data-testid="app-shell">
        <SampleTour />
      </div>,
    );

    const shell = getByTestId("app-shell");
    const blurLayer = getByTestId("tour-spotlight-overlay");
    const nextButton = getByRole("button", { name: "次へ" });
    const card = nextButton.parentElement?.parentElement as HTMLElement;

    expect(getComputedStyle(shell).isolation).toBe("isolate");
    expect(shell.contains(blurLayer)).toBe(false);
    expect(shell.contains(card)).toBe(false);
    expect(card.parentElement).toBe(document.body);
    expect(getComputedStyle(card).zIndex).toBe("50");
    expect(getComputedStyle(blurLayer).zIndex).toBe("40");
  });
});
