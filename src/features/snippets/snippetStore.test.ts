import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSnippetStore, setSnippetEditConflictHandler } from "./snippetStore";
import { SnippetVersionConflictError } from "./occ";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

vi.mock("./api", () => ({
  listSnippets: vi.fn(() => Promise.resolve([])),
  getSnippet: vi.fn(),
  createSnippet: vi.fn(),
  updateSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
  listSnippetsByMessageId: vi.fn(() => Promise.resolve([])),
}));

vi.mock("./search", () => ({
  searchSnippets: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/features/agent-writes/undoJournal", () => ({
  applyUndoJournal: vi.fn(() => Promise.resolve()),
}));

import * as snippetApi from "./api";
import * as snippetSearch from "./search";
import { applyUndoJournal } from "@/features/agent-writes/undoJournal";

const mockListSnippets = vi.mocked(snippetApi.listSnippets);
const mockCreateSnippet = vi.mocked(snippetApi.createSnippet);
const mockUpdateSnippet = vi.mocked(snippetApi.updateSnippet);
const mockDeleteSnippet = vi.mocked(snippetApi.deleteSnippet);
const mockGetSnippet = vi.mocked(snippetApi.getSnippet);
const mockSearchSnippets = vi.mocked(snippetSearch.searchSnippets);
const mockApplyUndoJournal = vi.mocked(applyUndoJournal);

const TEST_WRITE_RECEIPT = {
  changeEventUid: "snippet-change-event-1",
  maintenanceTransactionId: "snippet-maintenance-transaction-1",
  undoJournalId: "snippet-undo-journal-1",
};

const fakeSnippet = (
  overrides: Partial<snippetApi.Snippet> = {},
): snippetApi.Snippet => ({
  id: "snippet-1",
  projectId: "default-project",
  title: "テストスニペット",
  content: "スニペット内容",
  tagsCache: null,
  contentSource: null,
  sceneId: null,
  sourceChatMessageId: null,
  usageCount: 0,
  version: 0,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  ...overrides,
});

const fakeWriteSnippet = (
  overrides: Partial<snippetApi.Snippet> = {},
): snippetApi.SnippetWriteResult => {
  const snippet = fakeSnippet(overrides);
  Object.defineProperty(snippet, "__writeReceipt", {
    value: TEST_WRITE_RECEIPT,
    enumerable: false,
  });
  return snippet as snippetApi.SnippetWriteResult;
};

describe("snippetStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSnippetEditConflictHandler(() => {}); // reset to no-op between tests
    useGlobalHistoryStore.getState().clear();
    useSnippetStore.setState({
      entries: [],
      searchQuery: "",
      isLoading: false,
      selectedSnippet: null,
    });
  });

  describe("setSelectedSnippet", () => {
    it("値を直接セットできる", () => {
      const snippet = fakeSnippet({ id: "s1" });
      useSnippetStore.getState().setSelectedSnippet(snippet);
      expect(useSnippetStore.getState().selectedSnippet).toBe(snippet);
      useSnippetStore.getState().setSelectedSnippet(null);
      expect(useSnippetStore.getState().selectedSnippet).toBeNull();
    });

    it("updater 関数で前の選択を参照して更新できる", () => {
      const snippet = fakeSnippet({ id: "s1" });
      useSnippetStore.setState({ selectedSnippet: snippet });
      // 同一 id なら解除、別 id なら維持する SnippetPanel の toggle 相当
      useSnippetStore
        .getState()
        .setSelectedSnippet((prev) => (prev?.id === "s1" ? null : prev));
      expect(useSnippetStore.getState().selectedSnippet).toBeNull();
    });
  });

  describe("loadEntries", () => {
    it("loads all snippets and sets entries", async () => {
      const items = [
        fakeSnippet({ id: "snippet-1" }),
        fakeSnippet({ id: "snippet-2", title: "二つ目" }),
      ];
      mockListSnippets.mockResolvedValue(items);

      await useSnippetStore.getState().loadEntries();

      expect(mockListSnippets).toHaveBeenCalled();
      expect(useSnippetStore.getState().entries).toEqual(items);
      expect(useSnippetStore.getState().isLoading).toBe(false);
    });

    it("sets isLoading during fetch", async () => {
      let resolvePromise: (v: snippetApi.Snippet[]) => void;
      mockListSnippets.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve;
        }),
      );

      const promise = useSnippetStore.getState().loadEntries();
      expect(useSnippetStore.getState().isLoading).toBe(true);

      resolvePromise!([]);
      await promise;
      expect(useSnippetStore.getState().isLoading).toBe(false);
    });

    it("lets lifecycle strict callers observe a shared load failure", async () => {
      const failure = new Error("snippet optional hydrate failed");
      mockListSnippets.mockRejectedValueOnce(failure);

      const compatibleUiLoad = useSnippetStore.getState().loadEntries();
      const strictLifecycleLoad = useSnippetStore
        .getState()
        .loadEntries({ propagateError: true });
      const compatibleExpectation =
        expect(compatibleUiLoad).resolves.toBe(undefined);
      const strictExpectation =
        expect(strictLifecycleLoad).rejects.toBe(failure);

      await Promise.all([compatibleExpectation, strictExpectation]);
      expect(mockListSnippets).toHaveBeenCalledTimes(1);
      expect(useSnippetStore.getState().isLoading).toBe(false);
    });

    it("keeps a strict-first load authoritative when an ordinary caller joins", async () => {
      const failure = new Error("snippet strict-first hydrate failed");
      mockListSnippets.mockRejectedValueOnce(failure);

      const strictLifecycleLoad = useSnippetStore
        .getState()
        .loadEntries({ propagateError: true });
      const compatibleUiLoad = useSnippetStore.getState().loadEntries();
      const strictExpectation =
        expect(strictLifecycleLoad).rejects.toBe(failure);
      const compatibleExpectation =
        expect(compatibleUiLoad).resolves.toBe(undefined);

      await Promise.all([strictExpectation, compatibleExpectation]);
      expect(mockListSnippets).toHaveBeenCalledTimes(1);
      expect(useSnippetStore.getState().isLoading).toBe(false);
    });

    it("does not publish a load invalidated by a Project reset", async () => {
      let resolveOldLoad!: (value: snippetApi.Snippet[]) => void;
      const newSnippet = fakeSnippet({ id: "snippet-new" });
      mockListSnippets
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveOldLoad = resolve;
          }),
        )
        .mockResolvedValueOnce([newSnippet]);

      const oldLoad = useSnippetStore.getState().loadEntries();
      useSnippetStore.getState().resetForProject();
      await useSnippetStore.getState().loadEntries();
      resolveOldLoad([fakeSnippet({ id: "snippet-old" })]);
      await oldLoad;

      expect(useSnippetStore.getState().entries).toEqual([newSnippet]);
      expect(useSnippetStore.getState().isLoading).toBe(false);
    });
  });

  describe("search", () => {
    it("searches snippets and updates entries", async () => {
      const results = [fakeSnippet({ id: "snippet-3", title: "検索結果" })];
      mockSearchSnippets.mockResolvedValue(results);

      await useSnippetStore.getState().search("検索");

      expect(mockSearchSnippets).toHaveBeenCalledWith("検索");
      expect(useSnippetStore.getState().entries).toEqual(results);
      expect(useSnippetStore.getState().searchQuery).toBe("検索");
    });

    it("falls back to loadEntries when query is empty", async () => {
      const all = [fakeSnippet({ id: "snippet-1" })];
      mockListSnippets.mockResolvedValue(all);

      await useSnippetStore.getState().search("");

      expect(mockSearchSnippets).not.toHaveBeenCalled();
      expect(mockListSnippets).toHaveBeenCalled();
      expect(useSnippetStore.getState().searchQuery).toBe("");
    });
  });

  describe("create", () => {
    it("creates a snippet and adds it to entries", async () => {
      const created = fakeWriteSnippet({ id: "snippet-10", title: "新規" });
      mockCreateSnippet.mockResolvedValue(created);

      await useSnippetStore.getState().create({
        title: "新規",
        content: "内容",
        tagsCache: '["タグ"]',
        sourceChatMessageId: "msg-1",
      });

      expect(mockCreateSnippet).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "新規",
          content: "内容",
          tagsCache: '["タグ"]',
          sourceChatMessageId: "msg-1",
          projectId: "default-project",
        }),
      );
      expect(useSnippetStore.getState().entries).toContainEqual(created);
    });

    it("adds entry immediately without isLoading cycle when not loading", async () => {
      const created = fakeWriteSnippet({ id: "snippet-10", title: "新規" });
      mockCreateSnippet.mockResolvedValue(created);
      // isLoading starts as false (set in beforeEach)

      await useSnippetStore
        .getState()
        .create({ title: "新規", content: "内容" });

      expect(useSnippetStore.getState().entries).toContainEqual(created);
      // No background re-sync needed — listSnippets must not have been called
      expect(mockListSnippets).not.toHaveBeenCalled();
      expect(useSnippetStore.getState().isLoading).toBe(false);
    });

    it("triggers background re-sync when isLoading is true at create time", async () => {
      const created = fakeWriteSnippet({ id: "snippet-10", title: "新規" });
      const syncResult = [fakeSnippet({ id: "snippet-1" }), created];
      mockCreateSnippet.mockResolvedValue(created);
      mockListSnippets.mockResolvedValue(syncResult);
      // Simulate race: loadEntries() is in-flight when create() is called
      useSnippetStore.setState({ isLoading: true });

      await useSnippetStore
        .getState()
        .create({ title: "新規", content: "内容" });
      // Allow microtasks (the background .then()) to settle
      await Promise.resolve();

      expect(mockListSnippets).toHaveBeenCalled();
      // Store should reflect the re-synced result
      expect(useSnippetStore.getState().entries).toEqual(syncResult);
    });

    it("background re-sync does not overwrite active search results", async () => {
      const created = fakeWriteSnippet({ id: "snippet-10", title: "新規" });
      const searchResults = [
        fakeSnippet({ id: "snippet-99", title: "検索結果" }),
      ];
      mockCreateSnippet.mockResolvedValue(created);
      mockListSnippets.mockResolvedValue([created]);
      // Active search + in-flight load
      useSnippetStore.setState({
        isLoading: true,
        searchQuery: "検索",
        entries: searchResults,
      });

      await useSnippetStore
        .getState()
        .create({ title: "新規", content: "内容" });
      await Promise.resolve();

      // searchQuery is set, so re-sync must NOT overwrite entries
      expect(useSnippetStore.getState().entries).toContainEqual(
        expect.objectContaining({ id: "snippet-99" }),
      );
    });
  });

  describe("update", () => {
    it("updates a snippet in entries", async () => {
      const original = fakeSnippet({ id: "snippet-1", title: "元のタイトル" });
      const updated = fakeWriteSnippet({ ...original, title: "更新後" });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockResolvedValue(updated);

      await useSnippetStore.getState().update("snippet-1", { title: "更新後" });

      expect(mockUpdateSnippet).toHaveBeenCalledWith(
        "default-project",
        "snippet-1",
        {
          title: "更新後",
        },
        { baseVersion: 0 },
      );
      expect(useSnippetStore.getState().entries[0].title).toBe("更新後");
    });

    it("forwards a preexisting-draft permit to the snippet API", async () => {
      const original = fakeSnippet({ id: "snippet-1", version: 4 });
      const updated = fakeWriteSnippet({
        ...original,
        title: "ライフサイクル中の更新",
        version: 5,
      });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockResolvedValue(updated);

      await useSnippetStore
        .getState()
        .update(
          "snippet-1",
          { title: "ライフサイクル中の更新" },
          { preexistingDraft: true },
        );

      expect(mockUpdateSnippet).toHaveBeenCalledWith(
        "default-project",
        "snippet-1",
        { title: "ライフサイクル中の更新" },
        { baseVersion: 4, preexistingDraft: true },
      );
    });

    it("読み込み時点の version を baseVersion として渡す (OCC)", async () => {
      const original = fakeSnippet({ id: "snippet-1", version: 5 });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockResolvedValue(
        fakeWriteSnippet({ ...original, version: 6 }),
      );

      await useSnippetStore.getState().update("snippet-1", { content: "new" });

      expect(mockUpdateSnippet).toHaveBeenCalledWith(
        "default-project",
        "snippet-1",
        { content: "new" },
        { baseVersion: 5 },
      );
      // 返り値 (version=base+1) で entries を置き換えるので、連続保存でも
      // in-memory の version が DB に追従し自己衝突しない。
      expect(useSnippetStore.getState().entries[0].version).toBe(6);
    });

    it("OCC 衝突時は store を上書きせず conflict handler を id 付きで呼ぶ", async () => {
      const original = fakeSnippet({
        id: "snippet-1",
        content: "old",
        version: 2,
      });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockRejectedValueOnce(
        new SnippetVersionConflictError("snippet-1"),
      );
      const handler = vi.fn();
      setSnippetEditConflictHandler(handler);

      await useSnippetStore.getState().update("snippet-1", { content: "new" });

      expect(handler).toHaveBeenCalledWith("snippet-1");
      expect(useSnippetStore.getState().entries[0].content).toBe("old"); // 非破壊
      // 保存されていないので undo 履歴にも残さない
      expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
    });

    it("undo/redo は同じ Native Undo Journal を再生してfresh versionを同期する", async () => {
      const original = fakeSnippet({ id: "snippet-1", version: 3 });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockResolvedValue(
        fakeWriteSnippet({
          ...original,
          title: "更新後",
          version: 4,
        }),
      );

      await useSnippetStore.getState().update("snippet-1", { title: "更新後" });

      const cmd = useGlobalHistoryStore.getState().past.at(-1);
      expect(cmd).toBeTruthy();
      expect(cmd?.operationId).toBe(TEST_WRITE_RECEIPT.undoJournalId);

      mockUpdateSnippet.mockClear();
      mockGetSnippet.mockResolvedValueOnce({ ...original, version: 5 });
      await cmd!.undo();
      expect(mockApplyUndoJournal).toHaveBeenCalledWith(
        TEST_WRITE_RECEIPT.undoJournalId,
        "undo",
      );
      expect(mockUpdateSnippet).not.toHaveBeenCalled();
      expect(useSnippetStore.getState().entries[0].version).toBe(5);

      mockApplyUndoJournal.mockClear();
      mockGetSnippet.mockResolvedValueOnce({
        ...original,
        title: "更新後",
        version: 6,
      });
      await cmd!.redo();
      expect(mockApplyUndoJournal).toHaveBeenCalledWith(
        TEST_WRITE_RECEIPT.undoJournalId,
        "redo",
      );
      expect(useSnippetStore.getState().entries[0]).toMatchObject({
        title: "更新後",
        version: 6,
      });
    });

    it("does nothing if update returns undefined", async () => {
      const original = fakeSnippet({ id: "snippet-1" });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockResolvedValue(undefined);

      await useSnippetStore.getState().update("snippet-1", { title: "更新後" });

      expect(useSnippetStore.getState().entries[0].title).toBe(
        "テストスニペット",
      );
    });

    // 保存結果と新 version は戻り値で返す。EditorPane の snippet 保存は
    // これを見て dirty を維持する — 衝突を toast だけで握り潰して正常 resolve
    // すると、呼び出し側が dirty を誤クリアして編集が失われうる。
    it("成功時は persisted と新 version を返す", async () => {
      const original = fakeSnippet({ id: "snippet-1" });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockResolvedValue(
        fakeWriteSnippet({
          ...original,
          title: "新題",
          version: 1,
        }),
      );

      await expect(
        useSnippetStore.getState().update("snippet-1", { title: "新題" }),
      ).resolves.toEqual({ persisted: true, version: 1 });
    });

    it("OCC 衝突時は非保存を返す (呼び出し側が dirty を維持できる)", async () => {
      const original = fakeSnippet({ id: "snippet-1", version: 2 });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockRejectedValueOnce(
        new SnippetVersionConflictError("snippet-1"),
      );

      await expect(
        useSnippetStore.getState().update("snippet-1", { content: "new" }),
      ).resolves.toEqual({ persisted: false });
    });

    it("その他の失敗と行なし (undefined) も非保存を返す", async () => {
      const original = fakeSnippet({ id: "snippet-1" });
      useSnippetStore.setState({ entries: [original] });

      mockUpdateSnippet.mockRejectedValueOnce(new Error("boom"));
      await expect(
        useSnippetStore.getState().update("snippet-1", { title: "x" }),
      ).resolves.toEqual({ persisted: false });

      mockUpdateSnippet.mockResolvedValueOnce(undefined);
      await expect(
        useSnippetStore.getState().update("snippet-1", { title: "x" }),
      ).resolves.toEqual({ persisted: false });
    });

    it("行なし (削除済み/スコープmiss) の非保存でもトーストで通知する", async () => {
      // EditorPane は false → AlreadyNotifiedSaveError で「通知済み」を前提に
      // autoSave.failed トーストを抑止する。この経路が無音だと、削除済み
      // snippet を開いたまま編集したときの保存失敗が完全無音で継続する。
      const original = fakeSnippet({ id: "snippet-1" });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockResolvedValueOnce(undefined);

      await expect(
        useSnippetStore.getState().update("snippet-1", { title: "x" }),
      ).resolves.toEqual({ persisted: false });
      expect(toastError).toHaveBeenCalledTimes(1);
    });

    it("editor が渡した loadedVersion を store 内の行より優先する", async () => {
      const original = fakeSnippet({ id: "snippet-1", version: 9 });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockResolvedValue(
        fakeWriteSnippet({ ...original, version: 6 }),
      );

      await useSnippetStore
        .getState()
        .update("snippet-1", { content: "new" }, { baseVersion: 5 });

      expect(mockUpdateSnippet).toHaveBeenCalledWith(
        "default-project",
        "snippet-1",
        { content: "new" },
        { baseVersion: 5 },
      );
    });
  });

  describe("remove", () => {
    it("deletes a snippet and removes from entries", async () => {
      const s1 = fakeSnippet({ id: "snippet-1" });
      const s2 = fakeSnippet({ id: "snippet-2", title: "二つ目" });
      useSnippetStore.setState({ entries: [s1, s2] });
      mockDeleteSnippet.mockResolvedValue(undefined);

      await useSnippetStore.getState().remove("snippet-1");

      expect(mockDeleteSnippet).toHaveBeenCalledWith(
        "default-project",
        "snippet-1",
      );
      expect(useSnippetStore.getState().entries).toHaveLength(1);
      expect(useSnippetStore.getState().entries[0].id).toBe("snippet-2");
    });
  });
});
