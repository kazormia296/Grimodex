// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { registerActiveTurnStopper } from "@/lib/activeTurnStopRegistry";
import { confirmStopActiveTurn } from "@/application/lifecycle/chatStopConfirm";
import { ChatStopConfirmHost } from "./ChatStopConfirmHost";

vi.mock("./ChatStopConfirmDialog", () => {
  throw new Error("chunk load failed");
});

describe("確認画面の読み込みに失敗したとき", () => {
  it("断ると答え、停止しない", async () => {
    const stop = vi.fn();
    registerActiveTurnStopper({ isActive: () => true, stop });
    render(<ChatStopConfirmHost />);
    let decision!: Promise<boolean> | true;
    act(() => {
      decision = confirmStopActiveTurn("close");
    });
    await expect(Promise.resolve(decision)).resolves.toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });
});
