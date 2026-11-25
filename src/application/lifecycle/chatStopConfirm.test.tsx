// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import "@/lib/i18n";
import { registerActiveTurnStopper } from "@/lib/activeTurnStopRegistry";
import {
  confirmStopActiveTurn,
  useChatStopConfirmStore,
} from "./chatStopConfirm";
import { ChatStopConfirmHost } from "./ChatStopConfirmHost";

describe("終了や切替の前の、生成中の応答の確認", () => {
  let active = true;
  const stop = vi.fn(() => {
    active = false;
  });

  beforeEach(() => {
    active = true;
    stop.mockClear();
    registerActiveTurnStopper({ isActive: () => active, stop });
  });

  afterEach(() => {
    useChatStopConfirmStore.getState().request?.answer(false);
    cleanup();
  });

  it("生成中でなければ、確認を出さずに同期で通す", () => {
    active = false;
    expect(confirmStopActiveTurn("close")).toBe(true);
    expect(useChatStopConfirmStore.getState().request).toBeNull();
  });

  it("了承すると停止してから通す", async () => {
    render(<ChatStopConfirmHost />);
    let decision!: Promise<boolean> | true;
    act(() => {
      decision = confirmStopActiveTurn("close");
    });
    // 初回は確認の画面を遅延読み込みするので、負荷が高いと 1 秒を超える。
    expect(
      await screen.findByText("応答を生成中です", {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/中断して終了しますか/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "中断して終了" }));
    await expect(Promise.resolve(decision)).resolves.toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("断ると停止せずに取りやめる", async () => {
    render(<ChatStopConfirmHost />);
    let decision!: Promise<boolean> | true;
    act(() => {
      decision = confirmStopActiveTurn("switch");
    });
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "キャンセル" },
        { timeout: 5_000 },
      ),
    );
    await expect(Promise.resolve(decision)).resolves.toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it("確認中の同じ種類は同じ答えを待ち、違う種類は取りやめる", async () => {
    let first!: Promise<boolean> | true;
    let same!: Promise<boolean> | true;
    let other!: Promise<boolean> | true;
    act(() => {
      first = confirmStopActiveTurn("switch");
      same = confirmStopActiveTurn("switch");
      other = confirmStopActiveTurn("close");
    });
    expect(same).toBe(first);
    await expect(Promise.resolve(other)).resolves.toBe(false);
    act(() => {
      useChatStopConfirmStore.getState().request?.answer(true);
    });
    await expect(Promise.resolve(first)).resolves.toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });
});
