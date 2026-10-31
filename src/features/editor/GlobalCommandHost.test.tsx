// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const quiescence = vi.hoisted(() => ({ allowed: true }));

vi.mock("@/application/lifecycle/quiescenceLease", () => ({
  canScheduleQuiescenceMutation: () => quiescence.allowed,
}));

import { buildDefaultLayoutState } from "@/features/layout/layoutStateUtils";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { GlobalCommandHost } from "./GlobalCommandHost";

const capabilities = {
  genericProjectTransfer: false,
} as unknown as import("@/runtime/runtimeCapabilities").RuntimeCapabilities;

function mount(phoneWorkspace = false) {
  return render(
    <GlobalCommandHost
      phoneWorkspace={phoneWorkspace}
      runtimeCapabilities={capabilities}
      onToggleExport={() => {}}
      onOpenSettings={() => {}}
    />,
  );
}

function setOverlays(left: "snippets" | null, right: "attribution" | null) {
  const layout = buildDefaultLayoutState({ allInactive: true });
  layout.overlays = { left: { panel: left }, right: { panel: right } };
  useLayoutStore.setState({
    layout,
    openOverlay: null,
    maximizedPanelId: null,
  });
}

/** Mod+Alt+[ ／ ]（非 mac の Ctrl）。 */
function press(code: "BracketLeft" | "BracketRight") {
  return fireEvent.keyDown(window, {
    ctrlKey: true,
    altKey: true,
    code,
    key: code === "BracketLeft" ? "[" : "]",
  });
}

afterEach(cleanup);

describe("GlobalCommandHost — オーバーレイの開閉ショートカット", () => {
  beforeEach(() => {
    quiescence.allowed = true;
    setOverlays("snippets", "attribution");
  });

  it("Mod+Alt+[ で左、Mod+Alt+] で右を開閉する", () => {
    mount();
    act(() => void press("BracketLeft"));
    expect(useLayoutStore.getState().openOverlay).toBe("left");
    act(() => void press("BracketRight"));
    expect(useLayoutStore.getState().openOverlay).toBe("right");
    act(() => void press("BracketRight"));
    expect(useLayoutStore.getState().openOverlay).toBeNull();
  });

  it("開閉は layout を変えない", () => {
    mount();
    const before = useLayoutStore.getState().layout;
    act(() => void press("BracketLeft"));
    expect(useLayoutStore.getState().layout).toBe(before);
  });

  it("キーを consume する（preventDefault）", () => {
    mount();
    let proceed = true;
    act(() => {
      proceed = press("BracketLeft");
    });
    expect(proceed).toBe(false);
  });

  it("phone 幅では何もしない", () => {
    mount(true);
    let proceed = false;
    act(() => {
      proceed = press("BracketLeft");
    });
    expect(useLayoutStore.getState().openOverlay).toBeNull();
    expect(proceed).toBe(true);
  });

  it("overlay が空なら何もしない", () => {
    setOverlays(null, "attribution");
    mount();
    let proceed = false;
    act(() => {
      proceed = press("BracketLeft");
    });
    expect(useLayoutStore.getState().openOverlay).toBeNull();
    expect(proceed).toBe(true);
  });

  it("zoom 中は zoom を解いてから開く", () => {
    useLayoutStore.setState({ maximizedPanelId: "scenes" });
    mount();
    act(() => void press("BracketLeft"));
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
    expect(useLayoutStore.getState().openOverlay).toBe("left");
  });

  it("専用キー以外（パネルのショートカット）で開いても zoom を解く", () => {
    useLayoutStore.setState({ maximizedPanelId: "scenes" });
    mount();
    // Mod+Alt+A は attribution（右の overlay）のパネルのショートカット。
    act(() => {
      fireEvent.keyDown(window, {
        ctrlKey: true,
        altKey: true,
        code: "KeyA",
        key: "a",
      });
    });
    expect(useLayoutStore.getState().openOverlay).toBe("right");
    expect(useLayoutStore.getState().maximizedPanelId).toBeNull();
  });

  it("overlay にある codex-quick のショートカットは、開いていても閉じずに開いたままにする", () => {
    const layout = buildDefaultLayoutState({ allInactive: true });
    layout.overlays = {
      left: { panel: "codex-quick" },
      right: { panel: null },
    };
    // 古い版の自己修復と同じく、slot に同じパネルは無い状態にする。
    for (const regionId of Object.keys(layout.regions) as Array<
      keyof typeof layout.regions
    >) {
      for (const slot of layout.regions[regionId].slots) {
        slot.panels = slot.panels.filter((p) => p !== "codex-quick");
        if (slot.activePanel === "codex-quick") slot.activePanel = null;
      }
    }
    useLayoutStore.setState({ layout, openOverlay: null });
    const rafs: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafs.push(cb);
      return rafs.length;
    });
    try {
      mount();
      const pressQ = () =>
        act(() => {
          fireEvent.keyDown(window, {
            ctrlKey: true,
            altKey: true,
            code: "KeyQ",
            key: "q",
          });
        });
      pressQ();
      expect(useLayoutStore.getState().openOverlay).toBe("left");
      // 開いている間にもう一度押しても、requestAnimationFrame を待たずに開いたまま。
      pressQ();
      expect(useLayoutStore.getState().openOverlay).toBe("left");
      expect(rafs).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("静止待ち（canScheduleQuiescenceMutation が false）でも開閉できる", () => {
    quiescence.allowed = false;
    mount();
    act(() => void press("BracketLeft"));
    expect(useLayoutStore.getState().openOverlay).toBe("left");
  });
});
