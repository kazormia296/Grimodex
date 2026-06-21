import { describe, it, expect, vi, beforeEach } from "vitest";

const { emitMock, listenMock } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  listenMock: vi.fn(),
}));
vi.mock("@/lib/tauri", () => ({ emit: emitMock, listen: listenMock }));

import {
  CODEX_CHANGED_CHANNEL,
  CODEX_LOCK_CHANNEL,
  emitCodexChanged,
  emitLockEvent,
  onCodexChanged,
  onLockEvent,
} from "./codexWindowSync";
import type { LockEvent } from "./codexEditLock";

beforeEach(() => {
  emitMock.mockReset().mockResolvedValue(undefined);
  listenMock.mockReset().mockResolvedValue(() => {});
});

describe("codexWindowSync transport", () => {
  it("emitCodexChanged は data 変更チャネルへ projectId を撃つ", async () => {
    await emitCodexChanged("p1");
    expect(emitMock).toHaveBeenCalledWith(CODEX_CHANGED_CHANNEL, {
      projectId: "p1",
    });
  });

  it("emitLockEvent は lock チャネルへイベントをそのまま撃つ", async () => {
    const ev: LockEvent = {
      type: "acquire",
      entryId: "e1",
      windowId: "A",
      ts: 1,
    };
    await emitLockEvent(ev);
    expect(emitMock).toHaveBeenCalledWith(CODEX_LOCK_CHANNEL, ev);
  });

  it("onCodexChanged / onLockEvent は対応チャネルを listen する", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    await onCodexChanged(h1);
    await onLockEvent(h2);
    expect(listenMock).toHaveBeenCalledWith(CODEX_CHANGED_CHANNEL, h1);
    expect(listenMock).toHaveBeenCalledWith(CODEX_LOCK_CHANNEL, h2);
  });

  it("チャネル名は data:// と codex-lock:// 名前空間で衝突しない", () => {
    expect(CODEX_CHANGED_CHANNEL).not.toBe(CODEX_LOCK_CHANNEL);
    expect(CODEX_CHANGED_CHANNEL).toContain("codex");
    expect(CODEX_LOCK_CHANNEL).toContain("lock");
  });
});
