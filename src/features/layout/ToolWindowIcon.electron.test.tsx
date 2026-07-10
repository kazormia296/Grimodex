// @vitest-environment happy-dom
/**
 * Electron シェルでの stripe アイコン右クリック →「別ウィンドウで開く」
 * （Phase 2 レビュー指摘修正、受け入れ条件 A5）。
 * PanelChromeMenu.electron.test.tsx と対になる ToolWindowIcon 側のゲート検証。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolWindowIcon } from "./ToolWindowIcon";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState, findPanelLocation } from "./layoutStateUtils";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

type AnyWindow = Record<string, unknown>;

function installElectronBridge() {
  const panelWindow = {
    open: vi.fn().mockResolvedValue(undefined),
    focusByLabel: vi.fn().mockResolvedValue(false),
  };
  (window as unknown as AnyWindow).grimodex = {
    shell: "electron",
    invoke: vi.fn().mockResolvedValue({ ok: true, value: null }),
    listen: vi.fn().mockReturnValue(() => {}),
    emit: vi.fn().mockResolvedValue(undefined),
    panelWindow,
  };
  return panelWindow;
}

function renderIcon() {
  const slotId = findPanelLocation(useLayoutStore.getState().layout, "scenes")!
    .slot.id;
  return render(
    <ToolWindowIcon
      region="left"
      panelId="scenes"
      slotId={slotId}
      active
      slotOpen
    />,
  );
}

beforeEach(() => {
  useLayoutStore.setState({
    layout: buildDefaultLayoutState({ allInactive: true }),
    layoutLocked: false,
    hiddenStripePanels: new Set(),
  });
  useLayoutStore.getState().showPanel("scenes");
});

afterEach(() => {
  delete (window as unknown as AnyWindow).grimodex;
});

describe("ToolWindowIcon（Electron シェル）", () => {
  it("Electron では『別ウィンドウで開く』を出し、bridge.panelWindow.open へ到達する", async () => {
    const panelWindow = installElectronBridge();
    renderIcon();
    const user = userEvent.setup();

    await user.pointer({
      keys: "[MouseRight>]",
      target: screen.getByRole("button"),
    });
    await user.click(await screen.findByTestId("ctx-open-window-scenes"));

    await vi.waitFor(() => {
      expect(panelWindow.open).toHaveBeenCalledWith(
        "panel-scenes",
        expect.objectContaining({ width: expect.any(Number) }),
      );
    });
  });

  it("plain browser（bridge 無し）では項目を出さない", async () => {
    renderIcon();
    const user = userEvent.setup();

    await user.pointer({
      keys: "[MouseRight>]",
      target: screen.getByRole("button"),
    });

    expect(await screen.findByTestId("ctx-maximize-scenes")).not.toBeNull();
    expect(screen.queryByTestId("ctx-open-window-scenes")).toBeNull();
  });
});
