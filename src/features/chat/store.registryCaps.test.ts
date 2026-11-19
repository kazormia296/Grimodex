// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetIpcQueueForTests } from "@/lib/ipcQueue";
import {
  __resetRegistryModelCapsForTests,
  getRegistryModelCaps,
  startRegistryModelCapsLoad,
} from "./agent/registryModelCaps";
import { useAiSettingsStore } from "./store";
import type { AiSettings } from "./types";

vi.mock("./api", () => ({
  getAiSettings: vi.fn(),
  saveAiSettings: vi.fn(),
  setModelInfoAutoUpdate: vi.fn(),
  saveApiKey: vi.fn(),
  hasApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  testAiConnection: vi.fn(),
  listAiModels: vi.fn(),
}));

vi.mock("./cliApi", () => ({
  detectCliBinary: vi.fn(),
  listCliModels: vi.fn(),
}));

vi.mock("./codexAppApi", () => ({
  listCodexAppModels: vi.fn(),
}));

import * as api from "./api";

/**
 * PR-C3：registry の写しは、AI 設定を読み込む最初の `loadSettings` で 1 回だけ読む。
 * 読めたら `modelCapsRevision` を 1 回上げ、描画済みの能力表の解決を引き直させる。
 */

const settings: AiSettings = {
  provider: "openai",
  model: "",
  ollamaEndpoint: "http://localhost:11434",
  thinkingEnabled: true,
  openaiCompatible: { baseUrl: "" },
};

const VIEW = {
  origin: "cache",
  source: "grimodex",
  generatedAt: "2026-11-18T15:28:51Z",
  models: { "openai/gpt-6-astra": { contextWindow: 1_050_000 } },
};

function installBridge(invoke: ReturnType<typeof vi.fn>): void {
  (window as unknown as Record<string, unknown>).grimodex = {
    shell: "electron",
    invoke,
  };
}

beforeEach(() => {
  resetIpcQueueForTests();
  __resetRegistryModelCapsForTests();
  useAiSettingsStore.setState({ settings: null, modelCapsRevision: 0 });
  vi.mocked(api.getAiSettings).mockResolvedValue(settings);
  vi.mocked(api.hasApiKey).mockResolvedValue(false);
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("loadSettings と registry の写し", () => {
  it("読めたら revision を 1 回だけ上げる（2 回目の loadSettings は読み直さず、上げない）", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: VIEW });
    installBridge(invoke);

    await useAiSettingsStore.getState().loadSettings();
    await startRegistryModelCapsLoad();
    expect(useAiSettingsStore.getState().modelCapsRevision).toBe(1);
    expect(getRegistryModelCaps("openai", "gpt-6-astra")).toEqual({
      contextWindow: 1_050_000,
    });

    await useAiSettingsStore.getState().loadSettings();
    await startRegistryModelCapsLoad();
    expect(useAiSettingsStore.getState().modelCapsRevision).toBe(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("読めなくても loadSettings は成功し、revision は上がらない（層が無いまま）", async () => {
    installBridge(vi.fn().mockRejectedValue(new Error("unavailable")));

    await expect(
      useAiSettingsStore.getState().loadSettings(),
    ).resolves.toBeUndefined();
    await startRegistryModelCapsLoad();
    expect(useAiSettingsStore.getState().settings).toEqual(settings);
    expect(useAiSettingsStore.getState().modelCapsRevision).toBe(0);
    expect(getRegistryModelCaps("openai", "gpt-6-astra")).toBeNull();
  });

  it("Web 版（Electron でない）：IPC を使わず、revision は上がらない", async () => {
    await useAiSettingsStore.getState().loadSettings();
    await startRegistryModelCapsLoad();
    expect(useAiSettingsStore.getState().settings).toEqual(settings);
    expect(useAiSettingsStore.getState().modelCapsRevision).toBe(0);
  });
});

describe("setModelInfoAutoUpdate と registry の写し", () => {
  const CACHE_VIEW = {
    ...VIEW,
    models: { "openai/gpt-6-astra": { contextWindow: 2_000_000 } },
  };
  const BUNDLED_VIEW = {
    ...VIEW,
    origin: "bundled",
    models: { "openai/gpt-6-astra": { contextWindow: 1_050_000 } },
  };

  it("無効にした後、この窓の写しを読み直して revision を上げる（cache 由来の値を持ち続けない）", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: CACHE_VIEW })
      .mockResolvedValueOnce({ ok: true, value: BUNDLED_VIEW });
    installBridge(invoke);
    vi.mocked(api.setModelInfoAutoUpdate).mockResolvedValue(undefined);
    await useAiSettingsStore.getState().loadSettings();
    await startRegistryModelCapsLoad();
    expect(getRegistryModelCaps("openai", "gpt-6-astra")).toEqual({
      contextWindow: 2_000_000,
    });
    expect(useAiSettingsStore.getState().modelCapsRevision).toBe(1);

    await useAiSettingsStore.getState().setModelInfoAutoUpdate(false);
    await vi.waitFor(() =>
      expect(useAiSettingsStore.getState().modelCapsRevision).toBe(2),
    );

    expect(vi.mocked(api.setModelInfoAutoUpdate)).toHaveBeenCalledWith(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(getRegistryModelCaps("openai", "gpt-6-astra")).toEqual({
      contextWindow: 1_050_000,
    });
  });

  it("切替の保存に失敗したら、読み直さない", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: CACHE_VIEW });
    installBridge(invoke);
    vi.mocked(api.setModelInfoAutoUpdate).mockRejectedValue(new Error("no"));
    await useAiSettingsStore.getState().loadSettings();
    await startRegistryModelCapsLoad();

    await expect(
      useAiSettingsStore.getState().setModelInfoAutoUpdate(false),
    ).rejects.toThrow("no");

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useAiSettingsStore.getState().modelCapsRevision).toBe(1);
    expect(getRegistryModelCaps("openai", "gpt-6-astra")).toEqual({
      contextWindow: 2_000_000,
    });
  });
});
