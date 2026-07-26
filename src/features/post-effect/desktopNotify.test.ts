// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@/lib/notification", () => ({
  isPermissionGranted: h.isPermissionGranted,
  requestPermission: h.requestPermission,
  sendNotification: h.sendNotification,
}));
vi.mock("i18next", () => ({
  default: { t: (k: string) => k },
}));

import {
  ensureNotificationPermission,
  notifyRunTerminalIfUnfocused,
  resetNotificationPermissionForTest,
} from "./desktopNotify";

describe("desktopNotify", () => {
  let hasFocusSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.isPermissionGranted.mockReset();
    h.requestPermission.mockReset();
    h.sendNotification.mockReset();
    resetNotificationPermissionForTest();
    hasFocusSpy = vi.spyOn(document, "hasFocus");
  });

  afterEach(() => {
    hasFocusSpy.mockRestore();
  });

  it("フォーカス中は通知しない（権限確認すらしない）", async () => {
    hasFocusSpy.mockReturnValue(true);
    await notifyRunTerminalIfUnfocused(
      { effectType: "review", scopeType: "project" },
      { kind: "done", annotationCount: 3 },
    );
    expect(h.isPermissionGranted).not.toHaveBeenCalled();
    expect(h.sendNotification).not.toHaveBeenCalled();
  });

  it("非フォーカス + 権限ありなら通知を送る（title=種別·スコープ）", async () => {
    hasFocusSpy.mockReturnValue(false);
    h.isPermissionGranted.mockResolvedValue(true);
    await notifyRunTerminalIfUnfocused(
      { effectType: "review", scopeType: "project" },
      { kind: "done", annotationCount: 3 },
    );
    expect(h.sendNotification).toHaveBeenCalledTimes(1);
    const arg = h.sendNotification.mock.calls[0][0];
    expect(arg.title).toContain("kouetsu.progressToast.effect.review");
    expect(arg.body).toBe("kouetsu.progressToast.done");
  });

  it("部分失敗は donePartial + summary 本文、エラーは failed を本文にする", async () => {
    hasFocusSpy.mockReturnValue(false);
    h.isPermissionGranted.mockResolvedValue(true);

    await notifyRunTerminalIfUnfocused(
      { effectType: "typo_detection", scopeType: "project" },
      { kind: "done", annotationCount: 2, summary: "3/15 シーン失敗" },
    );
    expect(h.sendNotification.mock.calls[0][0].body).toContain(
      "kouetsu.progressToast.donePartial",
    );
    expect(h.sendNotification.mock.calls[0][0].body).toContain(
      "3/15 シーン失敗",
    );

    await notifyRunTerminalIfUnfocused(
      { effectType: "typo_detection", scopeType: "project" },
      { kind: "error", error: "boom" },
    );
    expect(h.sendNotification.mock.calls[1][0].body).toBe(
      "kouetsu.progressToast.failed",
    );
  });

  it("非フォーカスでも権限が無ければ黙ってスキップ（プロンプトを出さない）", async () => {
    hasFocusSpy.mockReturnValue(false);
    h.isPermissionGranted.mockResolvedValue(false);
    await notifyRunTerminalIfUnfocused(
      { effectType: "review", scopeType: "project" },
      { kind: "error", error: "boom" },
    );
    expect(h.requestPermission).not.toHaveBeenCalled();
    expect(h.sendNotification).not.toHaveBeenCalled();
  });

  it("ensureNotificationPermission は未許可なら 1 回だけ要求する", async () => {
    h.isPermissionGranted.mockResolvedValue(false);
    h.requestPermission.mockResolvedValue("denied");
    await ensureNotificationPermission();
    await ensureNotificationPermission();
    expect(h.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("plugin が throw しても（Tauri 外）例外を漏らさない", async () => {
    hasFocusSpy.mockReturnValue(false);
    h.isPermissionGranted.mockRejectedValue(new Error("no tauri"));
    await expect(
      notifyRunTerminalIfUnfocused(
        { effectType: "review", scopeType: "project" },
        { kind: "done", annotationCount: 0 },
      ),
    ).resolves.toBeUndefined();
  });
});
