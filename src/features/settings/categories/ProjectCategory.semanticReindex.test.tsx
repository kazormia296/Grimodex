// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * B5 回帰ガード: 意味検索インデックスの全件再構築ボタン。
 * インデックス投入はシーン保存時の逐次更新しか経路が無く、全件再構築の
 * 発火点が UI に存在しなかった（semanticReindexAll の呼び出し元ゼロ）ため、
 * 既存プロジェクトでは Semantic RAG が一切注入されなかった。
 */

const apiMock = vi.hoisted(() => ({
  semanticReindexAll: vi.fn(() => Promise.resolve(42)),
  semanticIndexStatus: vi.fn(() =>
    Promise.resolve({
      indexedChunkCount: 12,
      staleChunkCount: 0,
      indexedSceneCount: 3,
      currentModelId: "ruri-v3-30m",
      currentEmbeddingDim: 256,
      currentChunkerVersion: "v1",
    }),
  ),
}));
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/features/semantic-search/api", () => apiMock);
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "proj-test",
}));
vi.mock("../hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    project: {
      id: "proj-test",
      aiPolicy: null,
      genre: "",
      language: "ja",
      phaseResolutionMode: "auto",
    },
    isLoading: false,
    updateField: vi.fn(),
  }),
}));
vi.mock("../useSettingControl", () => ({
  useSettingControl: () => ({ value: "", setValue: vi.fn() }),
  useSettingBoolean: () => ({ value: false, setValue: vi.fn() }),
  useSettingNumber: () => ({ value: 60, setValue: vi.fn() }),
}));
vi.mock("../api", () => ({
  getAllProjectSettings: vi.fn(() => Promise.resolve({})),
}));
vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: { getState: () => ({ setResolutionMode: vi.fn() }) },
}));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ updateProjectDefaults: vi.fn() }),
}));
vi.mock("./TimelapseSettings", () => ({
  TimelapseSettings: () => null,
}));

import { ProjectCategory } from "./ProjectCategory";
import {
  useReindexProgressStore,
  _resetReindexProgressForTests,
} from "@/features/semantic-search/reindexProgressStore";

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.semanticReindexAll.mockResolvedValue(42);
  _resetReindexProgressForTests();
});

describe("ProjectCategory semantic reindex", () => {
  it("再構築ボタンが現在のプロジェクトで semantic_reindex_all を呼ぶ", async () => {
    render(<ProjectCategory />);
    const btn = screen.getByRole("button", { name: "再構築" });

    fireEvent.click(btn);

    await waitFor(() =>
      expect(apiMock.semanticReindexAll).toHaveBeenCalledWith("proj-test"),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
  });

  // 「再構築したのに注入されない」の切り分け用。0 件ならインデックス側、
  // 非 0 なら検索/スコア側の問題と即断できる。
  it("インデックス状態（シーン数/チャンク数）を表示する", async () => {
    render(<ProjectCategory />);
    await waitFor(() =>
      expect(apiMock.semanticIndexStatus).toHaveBeenCalledWith("proj-test"),
    );
    await screen.findByText("3 シーン / 12 チャンク");
  });

  it("実行中はボタンが disabled になり二重起動しない", async () => {
    let resolveReindex: (n: number) => void = () => {};
    apiMock.semanticReindexAll.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveReindex = resolve;
        }),
    );
    render(<ProjectCategory />);
    const btn = screen.getByRole("button", { name: "再構築" });

    fireEvent.click(btn);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "再構築中…" })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "再構築中…" }));
    expect(apiMock.semanticReindexAll).toHaveBeenCalledTimes(1);

    resolveReindex(7);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "再構築" })).toBeEnabled(),
    );
  });

  // 多重起動ガードはコンポーネントローカルだと設定パネルの閉じ開き
  // (再マウント) で外れる。グローバル store (running) で持続することを gate。
  it("再マウントしても実行中ガードが持続する", async () => {
    apiMock.semanticReindexAll.mockImplementation(
      () => new Promise<number>(() => {}),
    );
    const first = render(<ProjectCategory />);
    fireEvent.click(screen.getByRole("button", { name: "再構築" }));
    await waitFor(() =>
      expect(useReindexProgressStore.getState().running).toBe(true),
    );
    first.unmount();

    render(<ProjectCategory />);
    const btn = screen.getByRole("button", { name: "再構築中…" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(apiMock.semanticReindexAll).toHaveBeenCalledTimes(1);
  });

  it("失敗時は progress 表示を片付けて error toast を出す", async () => {
    apiMock.semanticReindexAll.mockRejectedValueOnce(new Error("boom"));
    const clearSpy = vi.spyOn(useReindexProgressStore.getState(), "clear");
    render(<ProjectCategory />);
    const btn = screen.getByRole("button", { name: "再構築" });

    fireEvent.click(btn);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(clearSpy).toHaveBeenCalled();
    expect(useReindexProgressStore.getState().running).toBe(false);
  });
});
