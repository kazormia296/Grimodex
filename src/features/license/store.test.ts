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
