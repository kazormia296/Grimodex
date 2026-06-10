// @vitest-environment happy-dom
/**
 * s.layout 丸ごと購読の再レンダー契約 gate (perf レビュー 2026-06-10 残項目)。
 *
 * splitter の live ドラッグ等で layout は mousemove 毎に新参照になる。
 * 以下の 3 箇所は layout をイベント時/ドラッグ時にしか使わないのに丸ごと
 * 購読しており、アイドル時 (パネル drag していない時) も layout 変化の
 * たびに再レンダーされていた:
 *   - useStripeIconPointerDrag (ストライプアイコン全数 × 毎 mousemove)
 *   - CenterStripeDropOverlay (resolveTarget はイベント時のみ layout を読む)
 *   - LayoutDnDHighlightOverlay (measure はドラッグ中のみ layout を読む)
 * 再レンダー回数は Profiler の onRender 呼び出しで数える。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Profiler, useRef } from "react";
import { render, act } from "@testing-library/react";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState, cloneLayoutState } from "./layoutStateUtils";
import { useStripeIconPointerDrag } from "./useStripeIconPointerDrag";
import { CenterStripeDropOverlay } from "./CenterStripeDropOverlay";
import { LayoutDnDHighlightOverlay } from "./LayoutDnDHighlightOverlay";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

function resetStore() {
  useLayoutStore.setState({
    layout: buildDefaultLayoutState({ allInactive: true }),
    layoutLocked: false,
    draggingPanel: null,
    dragOverTarget: null,
    panelDragSource: null,
    hiddenStripePanels: new Set(),
  });
}

/** layout を新参照に差し替える (live ドラッグ 1 mousemove 相当)。 */
function touchLayout() {
  act(() => {
    useLayoutStore.setState({
      layout: cloneLayoutState(useLayoutStore.getState().layout),
    });
  });
}

function StripeIconProbe() {
  const handlers = useStripeIconPointerDrag({
    panelId: "scenes",
    region: "left",
    slotId: "l0",
    layoutLocked: false,
  });
  // handlers を参照だけして DOM には何も出さない
  useRef(handlers);
  return <div data-testid="stripe-icon-probe" />;
}

function renderWithCounter(ui: React.ReactElement) {
  const counter = { renders: 0 };
  render(
    <Profiler
      id="probe"
      onRender={() => {
        counter.renders += 1;
      }}
    >
      {ui}
    </Profiler>,
  );
  return counter;
}

describe("layout 丸ごと購読の再レンダー契約", () => {
  beforeEach(() => {
    resetStore();
  });

  it("ストライプアイコンの drag hook はアイドル時の layout 変化で再レンダーされない", () => {
    const counter = renderWithCounter(<StripeIconProbe />);
    const after = counter.renders;

    touchLayout();
    touchLayout();

    expect(counter.renders).toBe(after);
  });

  it("CenterStripeDropOverlay はアイドル時の layout 変化で再レンダーされない", () => {
    const counter = renderWithCounter(
      <CenterStripeDropOverlay
        segments={[]}
        slotIds={[]}
        stripeEndInsertIndex={0}
      />,
    );
    const after = counter.renders;

    touchLayout();
    touchLayout();

    expect(counter.renders).toBe(after);
  });

  it("LayoutDnDHighlightOverlay はアイドル時の layout 変化で再レンダーされない", () => {
    const counter = renderWithCounter(<LayoutDnDHighlightOverlay />);
    const after = counter.renders;

    touchLayout();
    touchLayout();

    expect(counter.renders).toBe(after);
  });

  it("ドラッグ中の LayoutDnDHighlightOverlay は layout 変化で再レンダーされる (measure 追従)", () => {
    act(() => {
      useLayoutStore.setState({
        draggingPanel: "scenes",
        dragOverTarget: {
          type: "new-slot",
          region: "left",
          insertIndex: 0,
        } as never,
      });
    });
    const counter = renderWithCounter(<LayoutDnDHighlightOverlay />);
    const after = counter.renders;

    touchLayout();

    expect(counter.renders).toBeGreaterThan(after);
  });
});
