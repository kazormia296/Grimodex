// @vitest-environment happy-dom
/**
 * WindowControls の Electron シェル分岐（Phase 2 S6、設計書 §6.3）。
 *
 * frame:false の win/linux Electron 窓で操作系が空白にならないこと
 * （isTauri でなくても isElectron なら描画する）と、
 * bridge.windowControls 経由の min/max/close・onResized → isMaximized
 * 再取得が動くことを検証する。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WindowControls } from "./WindowControls";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/platform", () => ({
  isMac: () => false,
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}));

// close ガード（インライン AI pending）はこのテストの関心外 — 常に非ブロック
vi.mock("@/features/editor/inlineAi/pendingGuard", () => ({
  guardInlineAiPending: () => false,
}));

type ResizedCallback = () => void;

function installBridgeMock(options?: { maximized?: boolean }) {
  let maximized = options?.maximized ?? false;
  const resizedCallbacks = new Set<ResizedCallback>();
  const windowControls = {
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => {
      maximized = !maximized;
      return Promise.resolve();
    }),
    close: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() => Promise.resolve(maximized)),
    onResized: vi.fn((cb: ResizedCallback) => {
      resizedCallbacks.add(cb);
      return () => {
        resizedCallbacks.delete(cb);
      };
    }),
    onCloseRequested: vi.fn(() => () => {}),
  };
  // isElectron() は "grimodex" in window で判定される（src/lib/shell.ts）
  (window as unknown as Record<string, unknown>).grimodex = { windowControls };
  return {
    windowControls,
    fireResized: () => {
      for (const cb of [...resizedCallbacks]) cb();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("WindowControls (Electron シェル)", () => {
  it("window.grimodex があれば isTauri=false でも 3 ボタンを描画する", async () => {
    installBridgeMock();
    render(<WindowControls />);
    expect(
      screen.getByRole("button", { name: "window.minimize" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "window.close" })).toBeDefined();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "window.maximize" }),
      ).toBeDefined();
    });
  });

  it("非 Tauri / 非 Electron（ブラウザ）では何も描画しない", () => {
    const { container } = render(<WindowControls />);
    expect(container.innerHTML).toBe("");
  });

  it("minimize / toggleMaximize / close が bridge に届く", async () => {
    const { windowControls } = installBridgeMock();
    render(<WindowControls />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "window.minimize" }));
    expect(windowControls.minimize).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "window.maximize" }));
    expect(windowControls.toggleMaximize).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "window.close" }));
    expect(windowControls.close).toHaveBeenCalledTimes(1);
  });

  it("初期 isMaximized=true なら restore 表示になる", async () => {
    installBridgeMock({ maximized: true });
    render(<WindowControls />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "window.restore" }),
      ).toBeDefined();
    });
  });

  it("onResized 通知で isMaximized を再取得して表示を更新する（§6.3）", async () => {
    const bridge = installBridgeMock();
    render(<WindowControls />);
    await waitFor(() => {
      expect(bridge.windowControls.onResized).toHaveBeenCalledTimes(1);
    });
    // main 側の maximize → grim:window-resized 相当
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "window.maximize" }));
    bridge.fireResized();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "window.restore" }),
      ).toBeDefined();
    });
  });
});
