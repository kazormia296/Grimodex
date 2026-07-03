// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const apiMock = vi.hoisted(() => ({
  semanticReindexAll: vi.fn(() => Promise.resolve(42)),
}));
const autoIndexMock = vi.hoisted(() => ({
  ensureSemanticIndexesOnOpen: vi.fn(() => Promise.resolve()),
  resetIndexGuards: vi.fn(),
}));
const toastMock = vi.hoisted(() => {
  const fn = vi.fn();
  return Object.assign(fn, { success: vi.fn(), error: vi.fn() });
});

vi.mock("./api", () => apiMock);
vi.mock("./autoIndex", () => autoIndexMock);
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "proj-test",
}));

import {
  runSemanticReindex,
  notifyLanguageChangedReindex,
} from "./reindexActions";
import {
  useReindexProgressStore,
  _resetReindexProgressForTests,
} from "./reindexProgressStore";

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.semanticReindexAll.mockResolvedValue(42);
  _resetReindexProgressForTests();
});

describe("runSemanticReindex", () => {
  it("現在プロジェクトを再構築し success toast を出す", async () => {
    await runSemanticReindex();
    expect(apiMock.semanticReindexAll).toHaveBeenCalledWith("proj-test");
    expect(toastMock.success).toHaveBeenCalled();
    expect(useReindexProgressStore.getState().running).toBe(false);
  });

  it("実行中なら二重起動しない", async () => {
    useReindexProgressStore.getState().setRunning(true);
    await runSemanticReindex();
    expect(apiMock.semanticReindexAll).not.toHaveBeenCalled();
  });

  it("失敗時は clear して error toast", async () => {
    apiMock.semanticReindexAll.mockRejectedValueOnce(new Error("boom"));
    const clearSpy = vi.spyOn(useReindexProgressStore.getState(), "clear");
    await runSemanticReindex();
    expect(toastMock.error).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
    expect(useReindexProgressStore.getState().running).toBe(false);
  });
});

describe("notifyLanguageChangedReindex", () => {
  it("ガードを解除し、確認トーストを出す（トグル時は重い処理を起こさない）", () => {
    notifyLanguageChangedReindex("proj-test");
    // 1セッションガードを解除（次の open / DL 完了 / トースト操作で再インデックス可）。
    expect(autoIndexMock.resetIndexGuards).toHaveBeenCalledWith("proj-test");
    // トグル時点では reindex/DL を起動しない。
    expect(apiMock.semanticReindexAll).not.toHaveBeenCalled();
    expect(autoIndexMock.ensureSemanticIndexesOnOpen).not.toHaveBeenCalled();
    // 確認トーストが action 付きで出る。
    expect(toastMock).toHaveBeenCalledTimes(1);
    const opts = toastMock.mock.calls[0][1] as {
      action?: { onClick: () => void };
    };
    expect(opts.action).toBeTruthy();
  });

  it("トーストの action を押すと ensureSemanticIndexesOnOpen が走る", () => {
    notifyLanguageChangedReindex("proj-test");
    const opts = toastMock.mock.calls[0][1] as {
      action: { onClick: () => void };
    };
    opts.action.onClick();
    expect(autoIndexMock.ensureSemanticIndexesOnOpen).toHaveBeenCalledWith(
      "proj-test",
    );
  });

  it("projectId が空なら何もしない", () => {
    notifyLanguageChangedReindex("");
    expect(autoIndexMock.resetIndexGuards).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });
});
