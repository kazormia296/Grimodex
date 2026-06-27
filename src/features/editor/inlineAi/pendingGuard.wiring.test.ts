// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }));

import { useInlineAiStore } from "./inlineAiStore";
import { resetPendingGuardThrottle } from "./pendingGuard";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";

function setPending(on: boolean): void {
  useInlineAiStore.setState({ status: on ? "diffShown" : "idle" });
}

function seedTabs(): void {
  useTabStore.setState({
    tabs: [
      { nodeId: "a", isPreview: false, contentType: "scene" },
      { nodeId: "b", isPreview: false, contentType: "scene" },
    ],
    activeTabId: "a",
  });
}

beforeEach(() => {
  resetPendingGuardThrottle();
  setPending(false);
  useTabStore.setState({ tabs: [], activeTabId: null });
});

describe("pending guard wiring — tabStore (primary nav chokepoint)", () => {
  it("blocks switching the active tab while pending, allows when idle", () => {
    seedTabs();
    setPending(true);
    useTabStore.getState().setActiveTab("b");
    expect(useTabStore.getState().activeTabId).toBe("a");

    setPending(false);
    useTabStore.getState().setActiveTab("b");
    expect(useTabStore.getState().activeTabId).toBe("b");
  });

  it("blocks opening a different node (openPreview) while pending", () => {
    useTabStore.setState({
      tabs: [{ nodeId: "a", isPreview: false, contentType: "scene" }],
      activeTabId: "a",
    });
    setPending(true);
    useTabStore.getState().openPreview("c");
    expect(useTabStore.getState().activeTabId).toBe("a");
    expect(useTabStore.getState().tabs.some((t) => t.nodeId === "c")).toBe(
      false,
    );
  });

  it("blocks closing the active (owner) tab while pending", () => {
    seedTabs();
    setPending(true);
    useTabStore.getState().closeTab("a");
    expect(useTabStore.getState().tabs.some((t) => t.nodeId === "a")).toBe(
      true,
    );
  });

  it("still allows closing a non-active tab while pending", () => {
    seedTabs();
    setPending(true);
    useTabStore.getState().closeTab("b");
    expect(useTabStore.getState().tabs.some((t) => t.nodeId === "b")).toBe(
      false,
    );
  });
});

describe("pending guard wiring — layoutStore.setEditorOpen", () => {
  it("blocks closing the editor while pending, allows when idle", () => {
    useLayoutStore.getState().setEditorOpen(true);
    expect(useLayoutStore.getState().layout.center.editorOpen).toBe(true);

    setPending(true);
    useLayoutStore.getState().setEditorOpen(false);
    expect(useLayoutStore.getState().layout.center.editorOpen).toBe(true);

    setPending(false);
    useLayoutStore.getState().setEditorOpen(false);
    expect(useLayoutStore.getState().layout.center.editorOpen).toBe(false);
  });

  it("allows opening the editor even while pending", () => {
    useLayoutStore.getState().setEditorOpen(false);
    setPending(true);
    useLayoutStore.getState().setEditorOpen(true);
    expect(useLayoutStore.getState().layout.center.editorOpen).toBe(true);
  });
});
