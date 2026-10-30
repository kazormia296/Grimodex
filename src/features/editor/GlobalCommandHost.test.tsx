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

  it("静止待ち（canScheduleQuiescenceMutation が false）でも開閉できる", () => {
    quiescence.allowed = false;
    mount();
    act(() => void press("BracketLeft"));
    expect(useLayoutStore.getState().openOverlay).toBe("left");
  });
});
