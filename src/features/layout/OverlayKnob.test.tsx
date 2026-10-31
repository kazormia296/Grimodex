// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePostEffectRunStore } from "@/features/post-effect/runStore";
import { OverlayKnob } from "./OverlayKnob";
import { ToolWindowIcon } from "./ToolWindowIcon";
import { buildDefaultLayoutState, findPanelLocation } from "./layoutStateUtils";
import { useLayoutStore } from "./layoutStore";
import type { ToolWindowPanelId } from "./layoutTypes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function setOverlay(panel: ToolWindowPanelId | null, locked = false) {
  const layout = buildDefaultLayoutState({ allInactive: true });
  if (panel !== null) {
    // slot から外して overlay に置く（検証が通る形）。
    for (const region of ["left", "right", "bottom"] as const) {
      for (const slot of layout.regions[region].slots) {
        slot.panels = slot.panels.filter((p) => p !== panel);
      }
    }
  }
  layout.overlays = { left: { panel }, right: { panel: null } };
  useLayoutStore.setState({
    layout,
    layoutLocked: locked,
    hiddenStripePanels: new Set(),
    openOverlay: null,
    maximizedPanelId: null,
  });
}

function begin() {
  usePostEffectRunStore.getState().begin({
    runId: "r1",
    projectId: "p1",
    effectType: "review",
    scopeType: "project",
    scopeTargetId: null,
  });
}

afterEach(cleanup);

describe("OverlayKnob の右クリックメニュー", () => {
  beforeEach(() => {
    usePostEffectRunStore.setState({ runs: {} });
    setOverlay("snippets");
  });

  async function openMenu() {
    render(<OverlayKnob side="left" />);
    const user = userEvent.setup();
    await user.pointer({
      keys: "[MouseRight>]",
      target: screen.getByRole("button"),
    });
    return user;
  }

  it("「元に戻す（領域へ）」だけを出し、「サイドバーから削除」は出さない", async () => {
    await openMenu();
    expect(
      await screen.findByTestId("ctx-overlay-restore-left"),
    ).toBeInTheDocument();
    expect(screen.queryByText("layout.stripe.removeFromSidebar")).toBeNull();
  });

  it("元に戻すと既定の領域へ戻り、active にして表示する", async () => {
    const user = await openMenu();
    await user.click(await screen.findByTestId("ctx-overlay-restore-left"));
    const layout = useLayoutStore.getState().layout;
    expect(layout.overlays?.left.panel).toBeNull();
    const location = findPanelLocation(layout, "snippets");
    expect(location).not.toBeNull();
    expect(location?.slot.activePanel).toBe("snippets");
    expect(useLayoutStore.getState().isPanelActive("snippets")).toBe(true);
  });

  it("ロック中は無効で、overlay から動かない", async () => {
    setOverlay("snippets", true);
    const user = await openMenu();
    const item = await screen.findByTestId("ctx-overlay-restore-left");
    expect(item).toHaveAttribute("aria-disabled", "true");
    await user.click(item);
    expect(useLayoutStore.getState().layout.overlays?.left.panel).toBe(
      "snippets",
    );
  });

  it("パネル名は title に出し、丸いつまみには文字を描かない", () => {
    render(<OverlayKnob side="left" />);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("title", "layout.panel.snippets");
    expect(button).toHaveAttribute("aria-label", "layout.overlay.toggle");
    expect(button).toHaveAttribute("data-overlay-knob", "left");
    expect(button.textContent).toBe("");
    expect(button.querySelector("span:not([data-testid])")).toBeNull();
  });

  it("パネルが無い側は何も描かない", () => {
    setOverlay(null);
    const { container } = render(<OverlayKnob side="left" />);
    expect(container.querySelector("[data-overlay-knob-cell]")).toBeNull();
    expect(container.querySelector("[data-overlay-knob]")).toBeNull();
  });

  it("ロック中でもつまみで開閉できる", async () => {
    setOverlay("snippets", true);
    render(<OverlayKnob side="left" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button"));
    expect(useLayoutStore.getState().openOverlay).toBe("left");
  });
});

describe("busy の印の共有（Stripe とつまみ）", () => {
  beforeEach(() => {
    usePostEffectRunStore.setState({ runs: {} });
  });

  it("校閲の実行中はつまみにも印が出て、終端で消える", () => {
    setOverlay("kouetsu");
    render(<OverlayKnob side="left" />);
    expect(screen.queryByTestId("overlay-busy-badge")).toBeNull();
    act(() => begin());
    expect(screen.getByTestId("overlay-busy-badge")).toBeInTheDocument();
    act(() => usePostEffectRunStore.getState().complete("r1", 0));
    expect(screen.queryByTestId("overlay-busy-badge")).toBeNull();
  });

  it("kouetsu 以外のつまみには出さない", () => {
    setOverlay("snippets");
    render(<OverlayKnob side="left" />);
    act(() => begin());
    expect(screen.queryByTestId("overlay-busy-badge")).toBeNull();
  });

  it("同じ実行で Stripe のアイコンと つまみの両方に出る", () => {
    setOverlay("kouetsu");
    const layout = buildDefaultLayoutState({ allInactive: true });
    const slotId = findPanelLocation(layout, "scenes")!.slot.id;
    render(
      <>
        <OverlayKnob side="left" />
        <ToolWindowIcon
          region="left"
          panelId="kouetsu"
          slotId={slotId}
          active={false}
          slotOpen={false}
        />
      </>,
    );
    act(() => begin());
    expect(screen.getByTestId("overlay-busy-badge")).toBeInTheDocument();
    expect(screen.getByTestId("stripe-busy-badge")).toBeInTheDocument();
  });
});
