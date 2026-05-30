import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSnippetStore } from "./snippetStore";

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

vi.mock("@/features/timelapse/recorder", () => ({
  recordChangeEvent: vi.fn(),
}));

import * as snippetApi from "./api";
import * as snippetSearch from "./search";
import { recordChangeEvent } from "@/features/timelapse/recorder";

const mockRecord = vi.mocked(recordChangeEvent);

function pmDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

const mockListSnippets = vi.mocked(snippetApi.listSnippets);
const mockCreateSnippet = vi.mocked(snippetApi.createSnippet);
const mockUpdateSnippet = vi.mocked(snippetApi.updateSnippet);
const mockDeleteSnippet = vi.mocked(snippetApi.deleteSnippet);
const mockSearchSnippets = vi.mocked(snippetSearch.searchSnippets);

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
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  ...overrides,
});

describe("snippetStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSnippetStore.setState({
      entries: [],
      searchQuery: "",
      isLoading: false,
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
      const created = fakeSnippet({ id: "snippet-10", title: "新規" });
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
      const created = fakeSnippet({ id: "snippet-10", title: "新規" });
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
      const created = fakeSnippet({ id: "snippet-10", title: "新規" });
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
      const created = fakeSnippet({ id: "snippet-10", title: "新規" });
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
      const updated = { ...original, title: "更新後" };
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockResolvedValue(updated);

      await useSnippetStore.getState().update("snippet-1", { title: "更新後" });

      expect(mockUpdateSnippet).toHaveBeenCalledWith("snippet-1", {
        title: "更新後",
      });
      expect(useSnippetStore.getState().entries[0].title).toBe("更新後");
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

    it("records snippet.update with a content diff over extracted text", async () => {
      const original = fakeSnippet({
        id: "snippet-1",
        content: pmDoc("alpha beta"),
      });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockResolvedValue({
        ...original,
        content: pmDoc("alpha gamma"),
      });

      await useSnippetStore
        .getState()
        .update("snippet-1", { content: pmDoc("alpha gamma") });

      const call = mockRecord.mock.calls.find(
        ([arg]) => arg.opType === "snippet.update",
      );
      expect(call).toBeTruthy();
      const payload = call![0].payload as {
        fields: string[];
        diffs?: { content?: { segments: [number, string][] } };
      };
      expect(payload.fields).toContain("content");
      const segs = payload.diffs?.content?.segments;
      expect(segs).toBeTruthy();
      // diff is over extracted plain text, not raw JSON
      const joined = segs!.map(([, t]) => t).join("");
      expect(joined).not.toContain("paragraph");
      // reconstruct both sides from the diff (segment boundaries are
      // diff-match-patch's choice; reconstruction is the stable invariant)
      const reconBefore = segs!
        .filter(([op]) => op !== 1)
        .map(([, t]) => t)
        .join("");
      const reconAfter = segs!
        .filter(([op]) => op !== -1)
        .map(([, t]) => t)
        .join("");
      expect(reconBefore).toBe("alpha beta");
      expect(reconAfter).toBe("alpha gamma");
    });

    it("omits diffs when no content field changed", async () => {
      const original = fakeSnippet({ id: "snippet-1" });
      useSnippetStore.setState({ entries: [original] });
      mockUpdateSnippet.mockResolvedValue({ ...original, title: "新題" });

      await useSnippetStore.getState().update("snippet-1", { title: "新題" });

      const call = mockRecord.mock.calls.find(
        ([arg]) => arg.opType === "snippet.update",
      );
      expect(call).toBeTruthy();
      const payload = call![0].payload as { fields: string[]; diffs?: unknown };
      expect(payload.fields).toContain("title");
      expect(payload.diffs).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("deletes a snippet and removes from entries", async () => {
      const s1 = fakeSnippet({ id: "snippet-1" });
      const s2 = fakeSnippet({ id: "snippet-2", title: "二つ目" });
      useSnippetStore.setState({ entries: [s1, s2] });
      mockDeleteSnippet.mockResolvedValue(undefined);

      await useSnippetStore.getState().remove("snippet-1");

      expect(mockDeleteSnippet).toHaveBeenCalledWith("snippet-1");
      expect(useSnippetStore.getState().entries).toHaveLength(1);
      expect(useSnippetStore.getState().entries[0].id).toBe("snippet-2");
    });
  });
});
