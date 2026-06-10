import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
import { useLicenseStore } from "./store";
import type { LicenseStateDto } from "./types";

const mockInvoke = vi.mocked(invoke);

const INITIAL = {
  licensingEnabled: false,
  status: "disabled",
  trialDaysRemaining: null,
  graceDaysRemaining: null,
  keyTail: null,
  activatedAt: null,
  lastValidatedAt: null,
  initialized: false,
  staleConfirmed: false,
} as const;

function trialDto(): LicenseStateDto {
  return {
    licensingEnabled: true,
    status: "trial",
    trialDaysRemaining: 12,
    graceDaysRemaining: null,
    keyTail: null,
    activatedAt: null,
    lastValidatedAt: null,
  };
}

function resetStore() {
  useLicenseStore.setState(INITIAL);
}

describe("license/store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it("初期値は無効ビルド相当の fail-open（制限なし・未初期化）", () => {
    const s = useLicenseStore.getState();
    expect(s.licensingEnabled).toBe(false);
    expect(s.status).toBe("disabled");
    expect(s.initialized).toBe(false);
  });

  it("refresh は get_license_state を呼んで状態を反映する", async () => {
    mockInvoke.mockResolvedValueOnce(trialDto());
    await useLicenseStore.getState().refresh();
    expect(mockInvoke).toHaveBeenCalledWith("get_license_state");
    const s = useLicenseStore.getState();
    expect(s.status).toBe("trial");
    expect(s.licensingEnabled).toBe(true);
    expect(s.trialDaysRemaining).toBe(12);
    expect(s.initialized).toBe(true);
  });

  it("refresh 失敗は reject せず fail-open 状態を維持する", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("ipc down"));
    await expect(useLicenseStore.getState().refresh()).resolves.toBeUndefined();
    const s = useLicenseStore.getState();
    expect(s.status).toBe("disabled");
    expect(s.licensingEnabled).toBe(false);
    expect(s.initialized).toBe(false);
  });

  it("refresh 失敗は取得済みの状態を上書きしない", async () => {
    mockInvoke.mockResolvedValueOnce(trialDto());
    await useLicenseStore.getState().refresh();
    mockInvoke.mockRejectedValueOnce(new Error("ipc down"));
    await useLicenseStore.getState().refresh();
    const s = useLicenseStore.getState();
    expect(s.status).toBe("trial");
    expect(s.initialized).toBe(true);
  });

  it("activate は activate_license を呼び応答 DTO を反映する", async () => {
    mockInvoke.mockResolvedValueOnce({
      ...trialDto(),
      status: "licensed",
      keyTail: "5678",
    });
    await useLicenseStore.getState().activate("GRIM-KEY-5678");
    expect(mockInvoke).toHaveBeenCalledWith("activate_license", {
      key: "GRIM-KEY-5678",
    });
    const s = useLicenseStore.getState();
    expect(s.status).toBe("licensed");
    expect(s.keyTail).toBe("5678");
    expect(s.initialized).toBe(true);
  });

  it("activate 失敗は reject し状態を変えない (UI がエラー文言を表示する契約)", async () => {
    mockInvoke.mockRejectedValueOnce("ライセンスキーが見つかりません");
    await expect(
      useLicenseStore.getState().activate("BAD-KEY"),
    ).rejects.toBeTruthy();
    expect(useLicenseStore.getState().status).toBe("disabled");
  });

  it("deactivate は deactivate_license を呼び応答 DTO を反映する", async () => {
    mockInvoke.mockResolvedValueOnce(trialDto());
    await useLicenseStore.getState().deactivate();
    expect(mockInvoke).toHaveBeenCalledWith("deactivate_license");
    expect(useLicenseStore.getState().status).toBe("trial");
  });

  it("revalidate は revalidate_license を呼び応答 DTO を反映する", async () => {
    mockInvoke.mockResolvedValueOnce({ ...trialDto(), status: "licensed" });
    await useLicenseStore.getState().revalidate();
    expect(mockInvoke).toHaveBeenCalledWith("revalidate_license");
    expect(useLicenseStore.getState().status).toBe("licensed");
  });

  it("refresh の license_stale は未確認のまま（§3 前方ジャンプ対策）", async () => {
    mockInvoke.mockResolvedValueOnce({
      ...trialDto(),
      status: "license_stale",
    });
    await useLicenseStore.getState().refresh();
    const s = useLicenseStore.getState();
    expect(s.status).toBe("license_stale");
    expect(s.staleConfirmed).toBe(false);
  });

  it("applyValidatedState の license_stale は確認済みになる", () => {
    useLicenseStore
      .getState()
      .applyValidatedState({ ...trialDto(), status: "license_stale" });
    expect(useLicenseStore.getState().staleConfirmed).toBe(true);
    // stale 以外なら確認フラグは下りる
    useLicenseStore
      .getState()
      .applyValidatedState({ ...trialDto(), status: "licensed" });
    expect(useLicenseStore.getState().staleConfirmed).toBe(false);
  });

  it("revalidate 失敗は staleConfirmed を立てて reject する", async () => {
    mockInvoke.mockResolvedValueOnce({
      ...trialDto(),
      status: "license_stale",
    });
    await useLicenseStore.getState().refresh();
    mockInvoke.mockRejectedValueOnce("サーバーに接続できません");
    await expect(useLicenseStore.getState().revalidate()).rejects.toBeTruthy();
    expect(useLicenseStore.getState().staleConfirmed).toBe(true);
  });

  it("applyState は DTO を反映し initialized を立てる", () => {
    useLicenseStore.getState().applyState({
      ...trialDto(),
      status: "licensed",
      keyTail: "1234",
    });
    const s = useLicenseStore.getState();
    expect(s.status).toBe("licensed");
    expect(s.keyTail).toBe("1234");
    expect(s.initialized).toBe(true);
  });
});
