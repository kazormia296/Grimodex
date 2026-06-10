// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }));

import { toast } from "sonner";
import { useLicenseStore } from "./store";
import {
  isRestrictedLicenseState,
  isWriteRestrictedByLicense,
  blockIfUnlicensed,
} from "./gate";
import type { LicenseStatus } from "./types";

const mockToastError = vi.mocked(toast.error);

function setLicense(licensingEnabled: boolean, status: LicenseStatus) {
  useLicenseStore.setState({ licensingEnabled, status, initialized: true });
}

describe("license/gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLicenseStore.setState({
      licensingEnabled: false,
      status: "disabled",
      initialized: false,
    });
  });

  describe("isRestrictedLicenseState 判定テーブル（設計書 §3/§6）", () => {
    const cases: Array<[boolean, LicenseStatus, boolean]> = [
      // 無効ビルドはいかなる status でも制限しない（§9.1 全ゲート素通り）
      [false, "disabled", false],
      [false, "revoked", false],
      [false, "trial_expired", false],
      // 有効ビルド: 全機能側
      [true, "trial", false],
      [true, "licensed", false],
      [true, "grace", false],
      // 有効ビルド: 閲覧・エクスポート専用側
      [true, "trial_expired", true],
      [true, "license_stale", true],
      [true, "revoked", true],
    ];
    it.each(cases)(
      "licensingEnabled=%s status=%s → restricted=%s",
      (enabled, status, expected) => {
        expect(isRestrictedLicenseState(enabled, status)).toBe(expected);
      },
    );
  });

  describe("isWriteRestrictedByLicense（store 同期読み）", () => {
    it("初期状態（未初期化・fail-open）では制限しない", () => {
      expect(isWriteRestrictedByLicense()).toBe(false);
    });

    it("trial_expired で制限する", () => {
      setLicense(true, "trial_expired");
      expect(isWriteRestrictedByLicense()).toBe(true);
    });

    it("grace では制限しない（オフライン猶予中は全機能）", () => {
      setLicense(true, "grace");
      expect(isWriteRestrictedByLicense()).toBe(false);
    });
  });

  describe("blockIfUnlicensed", () => {
    it("非制限なら false で toast なし", () => {
      setLicense(true, "trial");
      expect(blockIfUnlicensed()).toBe(false);
      expect(mockToastError).not.toHaveBeenCalled();
    });

    it("制限中なら true で toast を出す", () => {
      setLicense(true, "revoked");
      expect(blockIfUnlicensed()).toBe(true);
      expect(mockToastError).toHaveBeenCalledTimes(1);
    });
  });
});
