// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { TrashItemData } from "./types";

vi.mock("@/lib/animation", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/animation")>("@/lib/animation");
  return {
    ...actual,
    useReducedMotion: vi.fn(),
  };
});

vi.mock("./trashBinStore", () => ({
  useTrashBinStore: vi.fn(),
}));

import { TrashBinPanel } from "./TrashBinPanel";
import { useReducedMotion } from "@/lib/animation";
import { useTrashBinStore } from "./trashBinStore";

function makeFakeItem(id: string): TrashItemData {
  return {
    id,
    projectId: "p",
    kind: "text-fragment",
    subKind: "text-fragment",
    originSceneId: null,
    originCodexId: null,
    previewText: id,
    previewMeta: null,
    payload: { text: id, spans: [] },
    charCount: id.length,
    isInteresting: false,
    deletedAt: new Date(2026, 0, 1).toISOString(),
  };
}

function setupStore(items: Map<string, TrashItemData>, isLoading = false) {
  const state = {
    activeProjectId: "p",
    items,
    selectedItemId: null,
    isCapturing: true,
    isLoading,
    pendingQueue: [],
    resetForProject: vi.fn(),
    loadItems: vi.fn().mockResolvedValue(undefined),
    enqueuePending: vi.fn(),
    cancelPending: vi.fn(),
    removeItem: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn().mockResolvedValue(undefined),
    setSelectedItem: vi.fn(),
    setCapturing: vi.fn(),
    pickup: vi.fn().mockResolvedValue({ ok: false, reason: "rejected" }),
  };
  vi.mocked(useTrashBinStore).mockImplementation(
    (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : (state as unknown),
  );
}

beforeEach(() => {
  // happy-dom layout: コンテナサイズを stub
  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        width: 400,
        height: 600,
        top: 0,
        left: 0,
        right: 400,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  // Observers の no-op stub
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("TrashBinPanel reduced-motion 分岐", () => {
  it("reduced-motion ON ではリスト fallback が描画される (物理ビューは描画しない)", () => {
    vi.mocked(useReducedMotion).mockReturnValue(true);
    setupStore(new Map([["a", makeFakeItem("a")]]));

    const { container } = render(<TrashBinPanel />);

    // 物理ビューのコンテナは存在しない
    expect(
      container.querySelector('[data-testid="trash-bin-physics-view"]'),
    ).toBeNull();
    // リスト UI の <ul> が存在
    expect(container.querySelector("ul")).not.toBeNull();
  });

  it("reduced-motion OFF では物理ビューが描画される", () => {
    vi.mocked(useReducedMotion).mockReturnValue(false);
    setupStore(new Map([["a", makeFakeItem("a")]]));

    const { container } = render(<TrashBinPanel />);

    expect(
      container.querySelector('[data-testid="trash-bin-physics-view"]'),
    ).not.toBeNull();
    // 物理ビューの中には <ul> のリストは無い
    expect(container.querySelector("ul")).toBeNull();
  });
});
