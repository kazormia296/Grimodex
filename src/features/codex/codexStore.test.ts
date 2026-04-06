import { describe, it, expect, beforeEach, vi } from "vitest";
import { useCodexStore } from "./codexStore";
import type { CodexEntry } from "./api";

const mockEntry: CodexEntry = {
  id: "codex-1",
  projectId: "proj-1",
  parentId: null,
  type: "character",
  name: "アリス",
  summary: "主人公",
  content: "{}",
  icon: null,
  aliases: "[]",
  excludedAliases: "[]",
  tagsCache: "主人公,ファンタジー",
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: "msg-1",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const mockEntry2: CodexEntry = {
  id: "codex-2",
  projectId: "proj-1",
  parentId: null,
  type: "location",
  name: "不思議の国",
  summary: "舞台",
  content: "{}",
  icon: null,
  aliases: "[]",
  excludedAliases: "[]",
  tagsCache: "場所",
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: null,
  createdAt: "2024-01-02T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
};

vi.mock("./api", () => ({
  listCodexEntries: vi.fn(),
  createCodexEntry: vi.fn(),
  updateCodexEntry: vi.fn(),
  deleteCodexEntry: vi.fn(),
  listCodexEntriesByMessageId: vi.fn(),
}));

vi.mock("./search", () => ({
  searchCodexEntries: vi.fn(),
}));

import {
  listCodexEntries,
  createCodexEntry,
  updateCodexEntry,
  deleteCodexEntry,
} from "./api";
import { searchCodexEntries } from "./search";

const mockListCodexEntries = vi.mocked(listCodexEntries);
const mockCreateCodexEntry = vi.mocked(createCodexEntry);
const mockUpdateCodexEntry = vi.mocked(updateCodexEntry);
const mockDeleteCodexEntry = vi.mocked(deleteCodexEntry);
const mockSearchCodexEntries = vi.mocked(searchCodexEntries);

describe("codexStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCodexStore.setState({
      entries: [],
      searchQuery: "",
      filterType: null,
      isLoading: false,
    });
  });

  describe("loadEntries", () => {
    it("loads all entries when no filter is set", async () => {
      mockListCodexEntries.mockResolvedValue([mockEntry, mockEntry2]);

      await useCodexStore.getState().loadEntries();

      expect(mockListCodexEntries).toHaveBeenCalledWith(undefined);
      expect(useCodexStore.getState().entries).toEqual([mockEntry, mockEntry2]);
      expect(useCodexStore.getState().isLoading).toBe(false);
    });

    it("loads entries filtered by type", async () => {
      useCodexStore.setState({ filterType: "character" });
      mockListCodexEntries.mockResolvedValue([mockEntry]);

      await useCodexStore.getState().loadEntries();

      expect(mockListCodexEntries).toHaveBeenCalledWith("character");
      expect(useCodexStore.getState().entries).toEqual([mockEntry]);
    });

    it("sets isLoading during load", async () => {
      let resolvePromise: (value: CodexEntry[]) => void;
      mockListCodexEntries.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve;
        }),
      );

      const loadPromise = useCodexStore.getState().loadEntries();
      expect(useCodexStore.getState().isLoading).toBe(true);

      resolvePromise!([]);
      await loadPromise;
      expect(useCodexStore.getState().isLoading).toBe(false);
    });
  });

  describe("search", () => {
    it("searches entries and updates results", async () => {
      mockSearchCodexEntries.mockResolvedValue([mockEntry]);

      await useCodexStore.getState().search("アリス");

      expect(mockSearchCodexEntries).toHaveBeenCalledWith("アリス");
      expect(useCodexStore.getState().entries).toEqual([mockEntry]);
      expect(useCodexStore.getState().searchQuery).toBe("アリス");
    });

    it("loads all entries when query is empty", async () => {
      mockListCodexEntries.mockResolvedValue([mockEntry, mockEntry2]);

      await useCodexStore.getState().search("");

      expect(mockListCodexEntries).toHaveBeenCalled();
      expect(useCodexStore.getState().searchQuery).toBe("");
    });
  });

  describe("create", () => {
    it("creates an entry and reloads", async () => {
      mockCreateCodexEntry.mockResolvedValue(mockEntry);
      mockListCodexEntries.mockResolvedValue([mockEntry]);

      const result = await useCodexStore.getState().create({
        type: "character",
        name: "アリス",
        summary: "主人公",
        tagsCache: "主人公,ファンタジー",
        sourceChatMessageId: "msg-1",
      });

      expect(mockCreateCodexEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "character",
          name: "アリス",
          summary: "主人公",
          tagsCache: "主人公,ファンタジー",
          sourceChatMessageId: "msg-1",
          projectId: "default-project",
        }),
      );
      expect(result).toEqual(mockEntry);
    });

    it("adds entry immediately to store without triggering isLoading cycle", async () => {
      mockCreateCodexEntry.mockResolvedValue(mockEntry);

      await useCodexStore.getState().create({
        type: "character",
        name: "アリス",
      });

      // Entry must be in store immediately after create() resolves
      expect(useCodexStore.getState().entries).toContainEqual(mockEntry);
      // loadEntries must NOT have been called (no isLoading cycle)
      expect(mockListCodexEntries).not.toHaveBeenCalled();
      // isLoading must remain false
      expect(useCodexStore.getState().isLoading).toBe(false);
    });

    it("prepends new entry to existing entries", async () => {
      useCodexStore.setState({ entries: [mockEntry2] });
      mockCreateCodexEntry.mockResolvedValue(mockEntry);

      await useCodexStore
        .getState()
        .create({ type: "character", name: "アリス" });

      const entries = useCodexStore.getState().entries;
      expect(entries[0]).toEqual(mockEntry);
      expect(entries[1]).toEqual(mockEntry2);
    });

    it("does not add entry to store when filterType excludes its type", async () => {
      useCodexStore.setState({ filterType: "location" });
      mockCreateCodexEntry.mockResolvedValue(mockEntry); // type: "character"

      await useCodexStore
        .getState()
        .create({ type: "character", name: "アリス" });

      // "character" entry must NOT appear when filter is "location"
      expect(useCodexStore.getState().entries).not.toContainEqual(mockEntry);
    });

    it("adds entry to store when filterType matches its type", async () => {
      useCodexStore.setState({ filterType: "character" });
      mockCreateCodexEntry.mockResolvedValue(mockEntry); // type: "character"

      await useCodexStore
        .getState()
        .create({ type: "character", name: "アリス" });

      expect(useCodexStore.getState().entries).toContainEqual(mockEntry);
    });

    it("adds entry to store when filterType is null (no filter)", async () => {
      useCodexStore.setState({ filterType: null });
      mockCreateCodexEntry.mockResolvedValue(mockEntry2); // type: "location"

      await useCodexStore
        .getState()
        .create({ type: "location", name: "不思議の国" });

      expect(useCodexStore.getState().entries).toContainEqual(mockEntry2);
    });
  });

  describe("update", () => {
    it("updates an entry and reloads", async () => {
      const updated = { ...mockEntry, name: "アリス改" };
      mockUpdateCodexEntry.mockResolvedValue(updated);
      mockListCodexEntries.mockResolvedValue([updated]);

      await useCodexStore.getState().update("codex-1", { name: "アリス改" });

      expect(mockUpdateCodexEntry).toHaveBeenCalledWith("codex-1", {
        name: "アリス改",
      });
    });

    it("updates contextMode via store", async () => {
      const updated = { ...mockEntry, contextMode: "always" };
      mockUpdateCodexEntry.mockResolvedValue(updated);
      mockListCodexEntries.mockResolvedValue([updated]);

      await useCodexStore
        .getState()
        .update("codex-1", { contextMode: "always" });

      expect(mockUpdateCodexEntry).toHaveBeenCalledWith("codex-1", {
        contextMode: "always",
      });
    });
  });

  describe("remove", () => {
    it("deletes an entry and reloads", async () => {
      useCodexStore.setState({ entries: [mockEntry, mockEntry2] });
      mockDeleteCodexEntry.mockResolvedValue(undefined);
      mockListCodexEntries.mockResolvedValue([mockEntry2]);

      await useCodexStore.getState().remove("codex-1");

      expect(mockDeleteCodexEntry).toHaveBeenCalledWith("codex-1");
    });
  });

  describe("setFilterType", () => {
    it("sets filter type and reloads", async () => {
      mockListCodexEntries.mockResolvedValue([mockEntry]);

      await useCodexStore.getState().setFilterType("character");

      expect(useCodexStore.getState().filterType).toBe("character");
      expect(mockListCodexEntries).toHaveBeenCalledWith("character");
    });

    it("clears filter when set to null", async () => {
      mockListCodexEntries.mockResolvedValue([mockEntry, mockEntry2]);

      await useCodexStore.getState().setFilterType(null);

      expect(useCodexStore.getState().filterType).toBe(null);
      expect(mockListCodexEntries).toHaveBeenCalledWith(undefined);
    });
  });
});
