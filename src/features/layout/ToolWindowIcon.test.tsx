// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolWindowIcon } from "./ToolWindowIcon";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState, findPanelLocation } from "./layoutStateUtils";
import { usePostEffectRunStore } from "@/features/post-effect/runStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("ToolWindowIcon context menu", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
      hiddenStripePanels: new Set(),
    });
    useLayoutStore.getState().showPanel("scenes");
  });

  it("removes an active panel from the stripe", async () => {
    const slotId = findPanelLocation(
      useLayoutStore.getState().layout,
      "scenes",
    )!.slot.id;
    render(
      <ToolWindowIcon
        region="left"
        panelId="scenes"
        slotId={slotId}
        active
        slotOpen
      />,
    );
    const user = userEvent.setup();

    await user.pointer({
      keys: "[MouseRight>]",
      target: screen.getByRole("button"),
    });
    await user.click(
      await screen.findByTestId("ctx-remove-from-stripe-scenes"),
    );

    expect(useLayoutStore.getState().hiddenStripePanels.has("scenes")).toBe(
      true,
    );
    expect(useLayoutStore.getState().isPanelActive("scenes")).toBe(false);
  });

  it("shows remove from sidebar even when the panel is inactive", async () => {
    useLayoutStore.getState().togglePanel("scenes");
    const slotId = findPanelLocation(
      useLayoutStore.getState().layout,
      "scenes",
    )!.slot.id;
    render(
      <ToolWindowIcon
        region="left"
        panelId="scenes"
        slotId={slotId}
        active={false}
        slotOpen={false}
      />,
    );
    const user = userEvent.setup();

    await user.pointer({
      keys: "[MouseRight>]",
      target: screen.getByRole("button"),
    });
    await user.click(
      await screen.findByTestId("ctx-remove-from-stripe-scenes"),
    );

    expect(useLayoutStore.getState().hiddenStripePanels.has("scenes")).toBe(
      true,
    );
  });

  it("uses the active surface without rendering a left indicator bar", () => {
    const slotId = findPanelLocation(
      useLayoutStore.getState().layout,
      "scenes",
    )!.slot.id;
    render(
      <ToolWindowIcon
        region="left"
        panelId="scenes"
        slotId={slotId}
        active
        slotOpen
      />,
    );

    const button = screen.getByRole("button");
    expect(button.className).toContain("bg-accent");
    expect(button.querySelector("span[aria-hidden]")).toBeNull();
  });
});

describe("ToolWindowIcon 校閲実行中バッジ", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
      hiddenStripePanels: new Set(),
    });
    usePostEffectRunStore.setState({ runs: {} });
  });

  function renderIcon(panelId: "kouetsu" | "scenes") {
    useLayoutStore.getState().showPanel(panelId);
    const slotId = findPanelLocation(useLayoutStore.getState().layout, panelId)!
      .slot.id;
    return render(
      <ToolWindowIcon
        region="left"
        panelId={panelId}
        slotId={slotId}
        active={false}
        slotOpen={false}
      />,
    );
  }

  it("post-effect 実行中は kouetsu アイコンにバッジが出て、終端で消える", () => {
    act(() => {
      usePostEffectRunStore.getState().begin({
        runId: "r1",
        projectId: "p1",
        effectType: "review",
        scopeType: "project",
        scopeTargetId: null,
      });
    });
    renderIcon("kouetsu");
    expect(screen.getByTestId("stripe-busy-badge")).toBeInTheDocument();

    act(() => {
      usePostEffectRunStore.getState().complete("r1", 0);
    });
    expect(screen.queryByTestId("stripe-busy-badge")).toBeNull();
  });

  it("kouetsu 以外のアイコンにはバッジを出さない", () => {
    act(() => {
      usePostEffectRunStore.getState().begin({
        runId: "r1",
        projectId: "p1",
        effectType: "review",
        scopeType: "project",
        scopeTargetId: null,
      });
    });
    renderIcon("scenes");
    expect(screen.queryByTestId("stripe-busy-badge")).toBeNull();
  });
});
