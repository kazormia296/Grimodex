import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./api", () => ({
  listPromptTemplates: vi.fn(() => Promise.resolve([])),
  getPromptTemplate: vi.fn(),
  createPromptTemplate: vi.fn(),
  updatePromptTemplate: vi.fn(),
  deletePromptTemplate: vi.fn(),
  incrementPromptTemplateUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: vi.fn(() => "default-project"),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("i18next", () => ({
  default: { t: (k: string) => k },
}));

import { usePromptLibraryStore } from "./promptLibraryStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import * as api from "./api";
import type { PromptTemplate } from "./api";

const mockProjectId = vi.mocked(getCurrentProjectId);
const mockList = vi.mocked(api.listPromptTemplates);
const mockCreate = vi.mocked(api.createPromptTemplate);
const mockUpdate = vi.mocked(api.updatePromptTemplate);
const mockDelete = vi.mocked(api.deletePromptTemplate);
const mockIncrement = vi.mocked(api.incrementPromptTemplateUsage);

const fakeTemplate = (
  overrides: Partial<PromptTemplate> = {},
): PromptTemplate => ({
  id: "tpl-1",
  projectId: "default-project",
  title: "テンプレ",
  content: "本文",
  usageCount: 0,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  ...overrides,
});

describe("promptLibraryStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks は mockReturnValue の上書きを消さないため毎回明示リセット。
    mockProjectId.mockReturnValue("default-project");
    usePromptLibraryStore.setState({
      templates: [],
      isLoading: false,
      loadedProjectId: null,
    });
  });

  it("load() fills templates and records loadedProjectId", async () => {
    mockList.mockResolvedValueOnce([fakeTemplate()]);
    await usePromptLibraryStore.getState().load();
    const s = usePromptLibraryStore.getState();
    expect(s.templates).toHaveLength(1);
    expect(s.loadedProjectId).toBe("default-project");
    expect(s.isLoading).toBe(false);
  });

  it("ensureLoaded() loads once then skips for the same project", async () => {
    mockList.mockResolvedValue([]);
    await usePromptLibraryStore.getState().ensureLoaded();
    await usePromptLibraryStore.getState().ensureLoaded();
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("create() prepends the new template", async () => {
    usePromptLibraryStore.setState({
      templates: [fakeTemplate({ id: "old" })],
    });
    mockCreate.mockResolvedValueOnce(fakeTemplate({ id: "new" }));
    const created = await usePromptLibraryStore
      .getState()
      .create("新タイトル", "新本文");
    expect(created?.id).toBe("new");
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "default-project",
        title: "新タイトル",
        content: "新本文",
      }),
    );
    expect(usePromptLibraryStore.getState().templates[0].id).toBe("new");
  });

  it("create() rejects blank titles without hitting the API", async () => {
    const created = await usePromptLibraryStore
      .getState()
      .create("   ", "本文");
    expect(created).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("create() rejects blank content without hitting the API", async () => {
    const created = await usePromptLibraryStore
      .getState()
      .create("タイトル", "   ");
    expect(created).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("load() discards stale results when the project switches mid-flight", async () => {
    // project A の load を開始（list を保留して切替を割り込ませる）。
    let resolveA: (v: PromptTemplate[]) => void = () => {};
    mockList.mockImplementationOnce(
      () =>
        new Promise<PromptTemplate[]>((r) => {
          resolveA = r;
        }),
    );
    const pending = usePromptLibraryStore.getState().load();
    // 非同期解決の前にプロジェクト B へ切替。
    mockProjectId.mockReturnValue("project-B");
    resolveA([fakeTemplate({ id: "stale-A" })]);
    await pending;
    const s = usePromptLibraryStore.getState();
    // stale な A の結果は state を汚染しない。
    expect(s.templates).toHaveLength(0);
    expect(s.loadedProjectId).toBeNull();
  });

  it("load() failure resets loadedProjectId so ensureLoaded can retry", async () => {
    mockList.mockResolvedValueOnce([fakeTemplate()]);
    await usePromptLibraryStore.getState().load();
    expect(usePromptLibraryStore.getState().loadedProjectId).toBe(
      "default-project",
    );
    // 再ロードが失敗 → loadedProjectId をリセットし再試行を可能にする。
    mockList.mockRejectedValueOnce(new Error("boom"));
    await usePromptLibraryStore.getState().load();
    const failed = usePromptLibraryStore.getState();
    expect(failed.isLoading).toBe(false);
    expect(failed.loadedProjectId).toBeNull();
    // ensureLoaded が再ロードを試みる。
    mockList.mockResolvedValueOnce([fakeTemplate({ id: "retry" })]);
    await usePromptLibraryStore.getState().ensureLoaded();
    expect(usePromptLibraryStore.getState().templates[0].id).toBe("retry");
  });

  it("update() replaces the matching template in place", async () => {
    usePromptLibraryStore.setState({ templates: [fakeTemplate()] });
    mockUpdate.mockResolvedValueOnce(
      fakeTemplate({ title: "更新後", content: "更新本文" }),
    );
    await usePromptLibraryStore
      .getState()
      .update("tpl-1", { title: "更新後", content: "更新本文" });
    expect(mockUpdate).toHaveBeenCalledWith("default-project", "tpl-1", {
      title: "更新後",
      content: "更新本文",
    });
    expect(usePromptLibraryStore.getState().templates[0].title).toBe("更新後");
  });

  it("remove() drops the template from state", async () => {
    usePromptLibraryStore.setState({ templates: [fakeTemplate()] });
    mockDelete.mockResolvedValueOnce(undefined);
    await usePromptLibraryStore.getState().remove("tpl-1");
    expect(mockDelete).toHaveBeenCalledWith("default-project", "tpl-1");
    expect(usePromptLibraryStore.getState().templates).toHaveLength(0);
  });

  it("incrementUsage() optimistically bumps usageCount and calls the API", async () => {
    usePromptLibraryStore.setState({
      templates: [fakeTemplate({ usageCount: 2 })],
    });
    await usePromptLibraryStore.getState().incrementUsage("tpl-1");
    expect(usePromptLibraryStore.getState().templates[0].usageCount).toBe(3);
    expect(mockIncrement).toHaveBeenCalledWith("default-project", "tpl-1");
  });
});
