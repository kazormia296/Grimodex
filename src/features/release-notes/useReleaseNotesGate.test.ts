// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { EULA_VERSION } from "@/features/legal/constants";
import { evaluateReleaseNotesGate } from "./fetchReleaseNotes";
import { useReleaseNotesGate } from "./useReleaseNotesGate";
import {
  useReleaseNotesStore,
  _resetReleaseNotesStoreForTests,
} from "./releaseNotesStore";

const updateGlobalSettings = vi.fn();
let mockGlobalSettings:
  | import("@/features/workspace/store").GlobalSettings
  | null = null;

vi.mock("@/lib/appInfo", () => ({
  getVersion: vi.fn(async () => "0.10.4"),
}));

vi.mock("@/features/updater/useUpdateChecker", () => ({
  shouldSkipTauriProductionGate: () => false,
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      globalSettings: mockGlobalSettings,
      updateGlobalSettings,
    }),
}));

describe("evaluateReleaseNotesGate", () => {
  beforeEach(() => {
    _resetReleaseNotesStoreForTests();
    updateGlobalSettings.mockReset();
    updateGlobalSettings.mockResolvedValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: String(url).includes(".ja.md"),
      })) as unknown as typeof fetch,
    );
  });

  it("silently initializes on first install", async () => {
    mockGlobalSettings = {
      acceptedEulaVersion: EULA_VERSION,
    } as import("@/features/workspace/store").GlobalSettings;
    await evaluateReleaseNotesGate({
      globalSettings: mockGlobalSettings,
      updateGlobalSettings,
      uiLanguage: "ja",
      isCancelled: () => false,
    });
    expect(updateGlobalSettings).toHaveBeenCalledWith({
      lastSeenReleaseNotesVersion: "0.10.4",
    });
    expect(useReleaseNotesStore.getState().isOpen).toBe(false);
  });

  it("opens auto dialog after upgrade when ja exists", async () => {
    mockGlobalSettings = {
      acceptedEulaVersion: EULA_VERSION,
      lastSeenReleaseNotesVersion: "0.10.3",
    } as import("@/features/workspace/store").GlobalSettings;
    await evaluateReleaseNotesGate({
      globalSettings: mockGlobalSettings,
      updateGlobalSettings,
      uiLanguage: "ja",
      isCancelled: () => false,
    });
    expect(useReleaseNotesStore.getState().isOpen).toBe(true);
    expect(useReleaseNotesStore.getState().mode).toBe("auto");
  });

  it("skips when ja missing and advances lastSeen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })) as unknown as typeof fetch,
    );
    mockGlobalSettings = {
      acceptedEulaVersion: EULA_VERSION,
      lastSeenReleaseNotesVersion: "0.10.3",
    } as import("@/features/workspace/store").GlobalSettings;
    await evaluateReleaseNotesGate({
      globalSettings: mockGlobalSettings,
      updateGlobalSettings,
      uiLanguage: "ja",
      isCancelled: () => false,
    });
    expect(updateGlobalSettings).toHaveBeenCalledWith({
      lastSeenReleaseNotesVersion: "0.10.4",
    });
    expect(useReleaseNotesStore.getState().isOpen).toBe(false);
  });

  it("waits until EULA accepted", async () => {
    mockGlobalSettings = {
      acceptedEulaVersion: "0.0",
    } as import("@/features/workspace/store").GlobalSettings;
    await evaluateReleaseNotesGate({
      globalSettings: mockGlobalSettings,
      updateGlobalSettings,
      uiLanguage: "ja",
      isCancelled: () => false,
    });
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });
});

describe("useReleaseNotesGate", () => {
  beforeEach(() => {
    mockGlobalSettings = {
      acceptedEulaVersion: EULA_VERSION,
    } as import("@/features/workspace/store").GlobalSettings;
    updateGlobalSettings.mockResolvedValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: String(url).includes(".ja.md"),
      })) as unknown as typeof fetch,
    );
  });

  it("re-runs when globalSettings changes after EULA", async () => {
    mockGlobalSettings = {
      acceptedEulaVersion: "0.0",
    } as import("@/features/workspace/store").GlobalSettings;
    const { rerender } = renderHook(() => useReleaseNotesGate());
    await waitFor(() => expect(updateGlobalSettings).not.toHaveBeenCalled());

    mockGlobalSettings = {
      acceptedEulaVersion: EULA_VERSION,
      lastSeenReleaseNotesVersion: "0.10.3",
    } as import("@/features/workspace/store").GlobalSettings;
    rerender();
    await waitFor(() =>
      expect(useReleaseNotesStore.getState().isOpen).toBe(true),
    );
  });
});
