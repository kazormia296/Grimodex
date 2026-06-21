import { describe, it, expect, vi, beforeEach } from "vitest";

const { emitLockEventMock, onLockEventMock } = vi.hoisted(() => ({
  emitLockEventMock: vi.fn(),
  onLockEventMock: vi.fn(),
}));
vi.mock("./codexWindowSync", () => ({
  emitLockEvent: emitLockEventMock,
  onLockEvent: onLockEventMock,
}));
// このテストでは main 窓として振る舞う(別窓ターゲット無し)。
vi.mock("@/features/layout/multiwindow/panelWindow", () => ({
  getPanelWindowTarget: () => null,
  panelWindowLabel: (id: string) => `panel-${id}`,
}));

import {
  acquireLock,
  releaseLock,
  canEditEntry,
  applyRemoteLockEvent,
  CURRENT_WINDOW_ID,
  __resetCodexEditLockForTest,
} from "./codexEditLockStore";

beforeEach(() => {
  emitLockEventMock.mockReset().mockResolvedValue(undefined);
  onLockEventMock.mockReset().mockResolvedValue(() => {});
  __resetCodexEditLockForTest();
});

describe("codexEditLockStore", () => {
  it("main 窓 id は 'main'", () => {
    expect(CURRENT_WINDOW_ID).toBe("main");
  });

  it("acquire したら自窓は編集可、emit される", () => {
    acquireLock("e1");
    expect(canEditEntry("e1")).toBe(true); // 自分が holder
    expect(emitLockEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "acquire",
        entryId: "e1",
        windowId: "main",
      }),
    );
  });

  it("別窓が先に acquire 済みなら自窓は編集不可", () => {
    // 別窓 'panel-codex' の acquire イベントを受信
    applyRemoteLockEvent({
      type: "acquire",
      entryId: "e1",
      windowId: "panel-codex",
      ts: Date.now(),
    });
    expect(canEditEntry("e1")).toBe(false);
  });

  it("別窓 holder が release したら編集可に戻る", () => {
    const now = Date.now();
    applyRemoteLockEvent({
      type: "acquire",
      entryId: "e1",
      windowId: "panel-codex",
      ts: now,
    });
    expect(canEditEntry("e1")).toBe(false);
    applyRemoteLockEvent({
      type: "release",
      entryId: "e1",
      windowId: "panel-codex",
      ts: now + 1,
    });
    expect(canEditEntry("e1")).toBe(true);
  });

  it("holder 不在の entry は編集可", () => {
    expect(canEditEntry("free")).toBe(true);
  });

  it("自窓 acquire 後 release で holder が消える", () => {
    acquireLock("e1");
    expect(canEditEntry("e1")).toBe(true);
    releaseLock("e1");
    // release 後も holder 不在 = 編集可
    expect(canEditEntry("e1")).toBe(true);
    expect(emitLockEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "release", entryId: "e1" }),
    );
  });
});
