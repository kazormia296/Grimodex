// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Profiler } from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { RoleModelRow } from "./RoleModelRow";
import {
  roleSettingKey,
  ROLE_PROVIDERS_KEY,
} from "@/features/chat/modelRouting";
import {
  __resetDynamicModelCapsForTests,
  registerDynamicModelCaps,
} from "@/features/chat/agent/dynamicModelCaps";
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
        activeProvider="anthropic"
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
    globalThis.localStorage?.removeItem("grimodex.modelCaps.v2");
    globalThis.localStorage?.removeItem("grimodex.openrouterModelCaps.v1");
    __resetDynamicModelCapsForTests();
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

describe("RoleModelRow — stale モデル値の可視化（プロバイダ切替の遺物）", () => {
  beforeEach(() => {
    useSettingsStore.setState({ cache: {} });
  });

  const gemma = { id: "gemma4:e2b", name: "Gemma 4 e2b" };

  function renderWithModels() {
    return render(
      <RoleModelRow
        // eslint-disable-next-line jsx-a11y/aria-role -- RoleModelRow の role は ARIA でなく AI モデルロール
        role="review"
        activeProvider="ollama"
        activeModels={[gemma]}
        sections={[]}
        isLoadingModels={false}
        catalogLoading={false}
      />,
    );
  }

  it("保存値が一覧に無いと警告とリセット導線を出し、リセットでクリアする", () => {
    // 実障害: Ollama がアクティブなのに別プロバイダ時代の値が残り、
    // controlled select 上は空選択に化けて見えないまま送信だけ壊れていた。
    useSettingsStore
      .getState()
      .set(roleSettingKey("review"), "~anthropic/claude-opus-latest");
    renderWithModels();

    expect(
      screen.getByText("settings.ai.roleModel.staleModel"),
    ).toBeInTheDocument();
    // 合成 option で実際の保存値が select 上に見える。
    const option = screen.getByRole("option", {
      name: "settings.ai.roleModel.staleModelOption",
    }) as HTMLOptionElement;
    expect(option.value).toBe("~anthropic/claude-opus-latest");

    fireEvent.click(screen.getByText("settings.ai.roleModel.reset"));
    expect(useSettingsStore.getState().get(roleSettingKey("review"), "")).toBe(
      "",
    );
  });

  it("保存値が一覧にあれば警告を出さない", () => {
    useSettingsStore.getState().set(roleSettingKey("review"), "gemma4:e2b");
    renderWithModels();
    expect(screen.queryByText("settings.ai.roleModel.staleModel")).toBeNull();
  });

  it("一覧が空（読み込み失敗等）のときは判定できないので警告しない", () => {
    useSettingsStore
      .getState()
      .set(roleSettingKey("review"), "~anthropic/claude-opus-latest");
    render(
      <RoleModelRow
        // eslint-disable-next-line jsx-a11y/aria-role -- RoleModelRow の role は ARIA でなく AI モデルロール
        role="review"
        activeProvider="ollama"
        activeModels={[]}
        sections={[]}
        isLoadingModels={false}
        catalogLoading={false}
      />,
    );
    expect(screen.queryByText("settings.ai.roleModel.staleModel")).toBeNull();
  });
});

describe("RoleModelRow — provider-scoped capability", () => {
  beforeEach(() => {
    useSettingsStore.setState({ cache: {} });
    globalThis.localStorage?.removeItem("grimodex.modelCaps.v2");
    globalThis.localStorage?.removeItem("grimodex.openrouterModelCaps.v1");
    __resetDynamicModelCapsForTests();
  });

  it("同名モデルでも選択セクションのproviderでAgent能力を判定する", () => {
    registerDynamicModelCaps("openrouter", [
      {
        id: "shared:latest",
        name: "OpenRouter shared",
        supportedParameters: ["tools"],
      },
    ]);
    registerDynamicModelCaps("ollama", [
      {
        id: "shared:latest",
        name: "Ollama shared",
        supportedParameters: [],
      },
    ]);
    useSettingsStore
      .getState()
      .set(
        ROLE_PROVIDERS_KEY,
        JSON.stringify({ agent: { provider: "ollama" } }),
      );

    render(
      <RoleModelRow
        // eslint-disable-next-line jsx-a11y/aria-role -- RoleModelRow の role は ARIA でなく AI モデルロール
        role="agent"
        activeProvider="openrouter"
        activeModels={[{ id: "shared:latest", name: "OpenRouter shared" }]}
        sections={[
          {
            provider: "ollama",
            models: [
              {
                id: "shared:latest",
                name: "Ollama shared",
                provider: "ollama",
                variant: null,
              },
            ],
          },
        ]}
        isLoadingModels={false}
        catalogLoading={false}
      />,
    );

    expect(screen.queryByRole("option", { name: "Ollama shared" })).toBeNull();
  });
});
