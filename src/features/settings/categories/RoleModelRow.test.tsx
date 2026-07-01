// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Profiler } from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { RoleModelRow } from "./RoleModelRow";
import {
  roleSettingKey,
  ROLE_PROVIDERS_KEY,
} from "@/features/chat/modelRouting";
import { useSettingsStore } from "../settingsStore";

// i18n は key をそのまま返すモック（文言ではなく購読挙動を検証する）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// 永続化 I/O を切り離した in-memory 版 settingsStore。
// selector 購読（必要キーのみ再描画）を実ストアと同じ zustand 契約で検証する。
vi.mock("../settingsStore", async () => {
  const { create } = await import("zustand");
  interface TestState {
    cache: Record<string, string>;
    get: (key: string, defaultValue?: string) => string;
    set: (key: string, value: string) => void;
  }
  const useSettingsStore = create<TestState>()((set, get) => ({
    cache: {},
    get: (key, defaultValue) => get().cache[key] ?? defaultValue ?? "",
    set: (key, value) => set((s) => ({ cache: { ...s.cache, [key]: value } })),
  }));
  return { useSettingsStore };
});

function renderRow(onCommit: () => void) {
  return render(
    <Profiler id="role-row" onRender={onCommit}>
      <RoleModelRow
        // eslint-disable-next-line jsx-a11y/aria-role -- RoleModelRow の role は ARIA でなく AI モデルロール
        role="review"
        activeModels={[]}
        sections={[]}
        isLoadingModels={false}
        catalogLoading={false}
      />
    </Profiler>,
  );
}

describe("RoleModelRow — settings 購読の絞り込み", () => {
  beforeEach(() => {
    useSettingsStore.setState({ cache: {} });
  });

  it("無関係な設定キーの set では再レンダーしない", () => {
    let commits = 0;
    renderRow(() => {
      commits += 1;
    });
    const initial = commits;

    act(() => {
      useSettingsStore.getState().set("chat.contextBudget", "4000");
      useSettingsStore.getState().set("display.uiFontFamily", "serif");
    });

    expect(commits).toBe(initial);
  });

  it("自ロールのモデルキー / roleProviders の変更では再レンダーして反映する", () => {
    let commits = 0;
    renderRow(() => {
      commits += 1;
    });
    const initial = commits;

    act(() => {
      useSettingsStore.getState().set(roleSettingKey("review"), "model-x");
    });
    expect(commits).toBeGreaterThan(initial);

    const afterModel = commits;
    act(() => {
      useSettingsStore
        .getState()
        .set(ROLE_PROVIDERS_KEY, JSON.stringify({ review: {} }));
    });
    expect(commits).toBeGreaterThan(afterModel);
  });

  it("他ロールのモデルキー変更では再レンダーしない", () => {
    let commits = 0;
    renderRow(() => {
      commits += 1;
    });
    const initial = commits;

    act(() => {
      useSettingsStore.getState().set(roleSettingKey("inline"), "model-y");
    });

    expect(commits).toBe(initial);
  });

  it("プロバイダ変更で roleProviders と自ロールのモデルキーを書き込む", () => {
    useSettingsStore.getState().set(roleSettingKey("review"), "old-model");
    renderRow(() => {});

    const select = screen.getByLabelText("settings.ai.roleModel.providerLabel");
    fireEvent.change(select, { target: { value: "" } });

    const cache = useSettingsStore.getState().cache;
    expect(cache[ROLE_PROVIDERS_KEY]).toBe(JSON.stringify({}));
    expect(cache[roleSettingKey("review")]).toBe("");
  });
});
