// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

/**
 * B5 回帰ガード（AI タブ → Data タブへ移設）: 意味検索インデックスの全件再構築ボタン。
 * インデックス投入はシーン保存時の逐次更新しか経路が無く、全件再構築の発火点が UI に
 * 無かった（semanticReindexAll の呼び出し元ゼロ）ため、既存プロジェクトで Semantic RAG が
 * 一切注入されなかった。再構築ロジックは reindexActions.runSemanticReindex に集約済み。
 */

const apiMock = vi.hoisted(() => ({
  semanticReindexAll: vi.fn(() => Promise.resolve(42)),
  semanticDebugDump: vi.fn(() => Promise.resolve({})),
  semanticIndexStatus: vi.fn(() =>
    Promise.resolve({
      indexedChunkCount: 12,
      staleChunkCount: 0,
      indexedSceneCount: 3,
      nonemptySceneCount: 3,
      currentModelId: "ruri-v3-30m",
      currentEmbeddingDim: 256,
      currentChunkerVersion: "v1",
    }),
  ),
}));
const toastMock = vi.hoisted(() => {
  const fn = vi.fn();
  return Object.assign(fn, { success: vi.fn(), error: vi.fn() });
});

vi.mock("@/features/semantic-search/api", () => apiMock);
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "proj-test",
  getCurrentProjectLanguage: () => "ja",
  useProjectStore: {
    getState: () => ({ currentProjectId: "proj-test" }),
  },
}));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      activeWorkspacePath: "/workspace/test",
      workspaceOpenRevision: 1,
      workspaceSwitchInProgress: false,
      workspaceHydrated: true,
    }),
  },
}));

import { SemanticIndexSection } from "./SemanticIndexSection";
import {
  useReindexProgressStore,
  _resetReindexProgressForTests,
} from "@/features/semantic-search/reindexProgressStore";

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.semanticReindexAll.mockResolvedValue(42);
  _resetReindexProgressForTests();
});

describe("SemanticIndexSection (Data タブ)", () => {
  it("再構築ボタンが現在のプロジェクトで semantic_reindex_all を呼ぶ", async () => {
    render(<SemanticIndexSection />);
    const btn = screen.getByRole("button", { name: "再構築" });

    fireEvent.click(btn);

    await waitFor(() =>
      expect(apiMock.semanticReindexAll).toHaveBeenCalledWith(
        "proj-test",
        expect.any(String),
      ),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
  });

  it("インデックス状態（シーン数/チャンク数）を表示する", async () => {
    render(<SemanticIndexSection />);
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
    render(<SemanticIndexSection />);
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

  it("再マウントしても実行中ガードが持続する", async () => {
    apiMock.semanticReindexAll.mockImplementation(
      () => new Promise<number>(() => {}),
    );
    const first = render(<SemanticIndexSection />);
    fireEvent.click(screen.getByRole("button", { name: "再構築" }));
    await waitFor(() =>
      expect(useReindexProgressStore.getState().running).toBe(true),
    );
    first.unmount();

    render(<SemanticIndexSection />);
    const btn = screen.getByRole("button", { name: "再構築中…" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(apiMock.semanticReindexAll).toHaveBeenCalledTimes(1);
  });

  it("失敗時は progress 表示を片付けて error toast を出す", async () => {
    apiMock.semanticReindexAll.mockRejectedValueOnce(new Error("boom"));
    const failSpy = vi.spyOn(useReindexProgressStore.getState(), "fail");
    render(<SemanticIndexSection />);
    const btn = screen.getByRole("button", { name: "再構築" });

    fireEvent.click(btn);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(failSpy).toHaveBeenCalledWith(expect.any(String));
    expect(useReindexProgressStore.getState().running).toBe(false);
  });
});
