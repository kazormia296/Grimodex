import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCodexEditConflictHandler, useCodexStore } from "./codexStore";
import type { CodexEntry, CodexMatchRow } from "./api";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useProjectStore } from "@/features/project/projectStore";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";

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
  readings: null,
  tagsCache: "主人公,ファンタジー",
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: "msg-1",
  notes: null,
  version: 0,
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
  readings: null,
  tagsCache: "場所",
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: null,
  notes: null,
  version: 0,
  createdAt: "2024-01-02T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
};

const { mockBlockIfUnlicensed } = vi.hoisted(() => ({
  mockBlockIfUnlicensed: vi.fn(() => false),
}));

vi.mock("@/features/license/gate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/license/gate")>();
  return { ...actual, blockIfUnlicensed: mockBlockIfUnlicensed };
});

vi.mock("./api", () => ({
  listCodexEntries: vi.fn(),
  listCodexMatchTargets: vi.fn(),
  getCodexEntry: vi.fn(),
  createCodexEntry: vi.fn(),
  updateCodexEntry: vi.fn(),
  deleteCodexEntry: vi.fn(),
  listCodexEntriesByMessageId: vi.fn(),
}));

vi.mock("./search", () => ({
  searchCodexEntries: vi.fn(),
}));

vi.mock("@/features/timelapse/recorder", () => ({
  recordChangeEvent: vi.fn(),
}));

vi.mock("@/lib/a11y/announcer", () => ({
  announce: vi.fn(),
}));

const { mockOnCodexAnchorDeleted } = vi.hoisted(() => ({
  mockOnCodexAnchorDeleted: vi.fn(),
}));

vi.mock("@/features/chat/chatStore", () => ({
  useChatStore: {
    getState: () => ({ onCodexAnchorDeleted: mockOnCodexAnchorDeleted }),
  },
}));

import {
  listCodexEntries,
  listCodexMatchTargets,
  getCodexEntry,
  createCodexEntry,
  updateCodexEntry,
  deleteCodexEntry,
} from "./api";
import { searchCodexEntries } from "./search";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { announce } from "@/lib/a11y/announcer";

const mockListCodexEntries = vi.mocked(listCodexEntries);
const mockListCodexMatchTargets = vi.mocked(listCodexMatchTargets);
const mockGetCodexEntry = vi.mocked(getCodexEntry);
const mockCreateCodexEntry = vi.mocked(createCodexEntry);
const mockUpdateCodexEntry = vi.mocked(updateCodexEntry);
const mockDeleteCodexEntry = vi.mocked(deleteCodexEntry);
const mockSearchCodexEntries = vi.mocked(searchCodexEntries);
const mockRecord = vi.mocked(recordChangeEvent);
const mockAnnounce = vi.mocked(announce);

function pmDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

function completionTarget(entry: CodexEntry): CodexMatchRow {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    aliases: entry.aliases,
    excludedAliases: entry.excludedAliases,
    readings: entry.readings,
  };
}

const allCompletionTargets = [
  completionTarget(mockEntry),
  completionTarget(mockEntry2),
];

function findCodexUpdateEvent() {
  return mockRecord.mock.calls.find(([arg]) => arg.opType === "entry.update");
}

describe("codexStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBlockIfUnlicensed.mockReturnValue(false);
    setCodexEditConflictHandler(() => {});
    useProjectStore.setState({ currentProjectId: null });
    setCurrentWorkspaceIdentity(null);
    useGlobalHistoryStore.getState().clear();
    useExternalWriteStore.getState().clear();
    useCodexStore.setState({
      entries: [],
      completionTargets: [],
      selectedEntry: null,
      searchQuery: "",
      filterType: null,
      isLoading: false,
      sortOrder: "name-asc",
    });
    mockListCodexMatchTargets.mockResolvedValue(allCompletionTargets);
  });

  afterEach(() => {
    useExternalWriteStore.getState().clear();
    useProjectStore.setState({ currentProjectId: null });
    setCurrentWorkspaceIdentity(null);
  });

  describe("conflict owner lifecycle", () => {
    it("Phase conflict 中は entry/preview 切替で paused draft owner を外さない", () => {
      useCodexStore.setState({
        selectedEntry: mockEntry,
        previewPhaseByEntry: {},
      });
      useExternalWriteStore.getState().pushConflict({
        documentKey: {
          kind: "codex",
          id: mockEntry.id,
          phaseId: "phase-1",
        },
        sceneId: mockEntry.id,
        domain: "codex",
        opType: "phase.update",
        entityId: "phase-1",
      });

      useCodexStore.getState().setSelectedEntry(mockEntry2);
      useCodexStore.getState().setPreviewPhase(mockEntry.id, "__base__");

      expect(useCodexStore.getState().selectedEntry).toEqual(mockEntry);
      expect(
        useCodexStore.getState().previewPhaseByEntry[mockEntry.id],
      ).toBeUndefined();
    });
  });

  describe("loadEntries", () => {
    it("loads all entries when no filter is set", async () => {
      mockListCodexEntries.mockResolvedValue([mockEntry, mockEntry2]);

      await useCodexStore.getState().loadEntries();

      expect(mockListCodexEntries).toHaveBeenCalledWith(
        "default-project",
        undefined,
      );
      expect(useCodexStore.getState().entries).toEqual([mockEntry, mockEntry2]);
      expect(useCodexStore.getState().completionTargets).toEqual(
        allCompletionTargets,
      );
      expect(useCodexStore.getState().isLoading).toBe(false);
    });

    it("loads entries filtered by type", async () => {
      useCodexStore.setState({ filterType: "character" });
      mockListCodexEntries.mockResolvedValue([mockEntry]);

      await useCodexStore.getState().loadEntries();

      expect(mockListCodexEntries).toHaveBeenCalledWith(
        "default-project",
        "character",
      );
      expect(useCodexStore.getState().entries).toEqual([mockEntry]);
      expect(useCodexStore.getState().completionTargets).toEqual(
        allCompletionTargets,
      );
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
      useCodexStore.setState({ completionTargets: allCompletionTargets });
      mockSearchCodexEntries.mockResolvedValue([mockEntry]);

      await useCodexStore.getState().search("アリス");

      // 検索は現在プロジェクトにスコープされる（cross-project 行が store に入らない）
      expect(mockSearchCodexEntries).toHaveBeenCalledWith(
        "アリス",
        expect.any(String),
      );
      expect(useCodexStore.getState().entries).toEqual([mockEntry]);
      expect(useCodexStore.getState().searchQuery).toBe("アリス");
      expect(useCodexStore.getState().completionTargets).toEqual(
        allCompletionTargets,
      );
    });

    it("loads all entries when query is empty", async () => {
      mockListCodexEntries.mockResolvedValue([mockEntry, mockEntry2]);

      await useCodexStore.getState().search("");

      expect(mockListCodexEntries).toHaveBeenCalled();
      expect(useCodexStore.getState().searchQuery).toBe("");
    });

    it("announces the result count once after a successful search", async () => {
      mockSearchCodexEntries.mockResolvedValue([mockEntry]);

      await useCodexStore.getState().search("アリス");

      expect(mockAnnounce).toHaveBeenCalledTimes(1);
    });

    it("does not announce when the query is empty", async () => {
      mockListCodexEntries.mockResolvedValue([mockEntry, mockEntry2]);

      await useCodexStore.getState().search("");

      expect(mockAnnounce).not.toHaveBeenCalled();
    });

    it("does not announce when the search fails", async () => {
      mockSearchCodexEntries.mockRejectedValue(new Error("boom"));

      await useCodexStore.getState().search("アリス");

      expect(mockAnnounce).not.toHaveBeenCalled();
    });

    it("does not announce a stale result after a newer search starts", async () => {
      let resolveFirst!: (value: CodexEntry[]) => void;
      mockSearchCodexEntries
        .mockImplementationOnce(
          () =>
            new Promise<CodexEntry[]>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValueOnce([mockEntry]);

      const first = useCodexStore.getState().search("ア");
      const second = useCodexStore.getState().search("アリス");
      await second;
      resolveFirst([mockEntry, mockEntry2]);
      await first;

      // 後発の「アリス」の分だけ読み上げ、先発の stale な件数は読まない
      expect(mockAnnounce).toHaveBeenCalledTimes(1);
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
      expect(useCodexStore.getState().completionTargets).toContainEqual(
        completionTarget(mockEntry),
      );
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

    it("遅延作成中にproject/workspace authorityが変われば新scopeを汚染せずstaleを通知する", async () => {
      const currentScopeEntry = {
        ...mockEntry2,
        projectId: "project-b",
        summary: "新 scope の entry",
      };
      let resolveCreate: ((entry: CodexEntry) => void) | undefined;
      setCurrentWorkspaceIdentity({
        path: "/workspace/a.sqlite",
        openRevision: 1,
      });
      mockCreateCodexEntry.mockImplementationOnce(
        () =>
          new Promise<CodexEntry>((resolve) => {
            resolveCreate = resolve;
          }),
      );

      const creation = useCodexStore.getState().create({
        type: "character",
        name: "旧 scope の entry",
      });
      await vi.waitFor(() =>
        expect(mockCreateCodexEntry).toHaveBeenCalledOnce(),
      );

      useProjectStore.setState({ currentProjectId: "project-b" });
      setCurrentWorkspaceIdentity({
        path: "/workspace/b.sqlite",
        openRevision: 2,
      });
      useCodexStore.setState({
        entries: [currentScopeEntry],
        selectedEntry: currentScopeEntry,
        completionTargets: [completionTarget(currentScopeEntry)],
      });
      resolveCreate?.({
        ...mockEntry,
        projectId: "default-project",
        name: "旧 scope の entry",
      });

      await expect(creation).rejects.toThrow("codex create authority changed");
      expect(useCodexStore.getState().entries).toEqual([currentScopeEntry]);
      expect(useCodexStore.getState().selectedEntry).toEqual(currentScopeEntry);
      expect(useCodexStore.getState().completionTargets).toEqual([
        completionTarget(currentScopeEntry),
      ]);
      expect(useGlobalHistoryStore.getState().past).toEqual([]);
      expect(
        mockRecord.mock.calls.some(
          ([event]) => event.opType === "entry.create",
        ),
      ).toBe(false);
    });
  });

  describe("update", () => {
    it("calls updateCodexEntry with the given data", async () => {
      const updated = { ...mockEntry, name: "アリス改" };
      mockUpdateCodexEntry.mockResolvedValue(updated);

      await useCodexStore.getState().update("codex-1", { name: "アリス改" });

      expect(mockUpdateCodexEntry).toHaveBeenCalledWith(
        "default-project",
        "codex-1",
        {
          name: "アリス改",
        },
      );
    });

    it("optimistically updates entries in store without reloading", async () => {
      useCodexStore.setState({
        entries: [mockEntry],
        completionTargets: [completionTarget(mockEntry)],
      });
      const updated = { ...mockEntry, name: "アリス改" };
      mockUpdateCodexEntry.mockResolvedValue(updated);

      await useCodexStore.getState().update("codex-1", { name: "アリス改" });

      expect(useCodexStore.getState().entries[0].name).toBe("アリス改");
      expect(useCodexStore.getState().completionTargets[0].name).toBe(
        "アリス改",
      );
      expect(mockListCodexEntries).not.toHaveBeenCalled();
    });

    it("uses an editor session baseVersion and returns the persisted version", async () => {
      const before = { ...mockEntry, version: 4 };
      const updated = { ...before, name: "アリス改", version: 5 };
      useCodexStore.setState({ entries: [before] });
      mockUpdateCodexEntry.mockResolvedValue(updated);

      await expect(
        useCodexStore
          .getState()
          .update("codex-1", { name: "アリス改" }, { baseVersion: 4 }),
      ).resolves.toEqual({ persisted: true, version: 5 });

      expect(mockUpdateCodexEntry).toHaveBeenCalledWith(
        "default-project",
        "codex-1",
        { name: "アリス改" },
        { baseVersion: 4 },
      );
    });

    it("returns non-persisted for an editor session OCC conflict", async () => {
      const before = { ...mockEntry, version: 4 };
      useCodexStore.setState({ entries: [before] });
      const conflictHandler = vi.fn();
      setCodexEditConflictHandler(conflictHandler);
      const { CodexVersionConflictError } = await import("./occ");
      mockUpdateCodexEntry.mockRejectedValue(
        new CodexVersionConflictError("codex-1"),
      );

      await expect(
        useCodexStore
          .getState()
          .update("codex-1", { name: "競合" }, { baseVersion: 4 }),
      ).resolves.toEqual({ persisted: false });
      expect(conflictHandler).toHaveBeenCalledWith("codex-1");
    });

    it("keeps a filtered-out selected entry current after a structural edit", async () => {
      useCodexStore.setState({
        entries: [],
        selectedEntry: mockEntry,
      });
      const updated = { ...mockEntry, type: "location" };
      mockUpdateCodexEntry.mockResolvedValue(updated);

      await useCodexStore.getState().update("codex-1", { type: "location" });

      expect(useCodexStore.getState().entries).toEqual([]);
      expect(useCodexStore.getState().selectedEntry).toEqual(updated);
    });

    it("読みの更新を全プロジェクト用の照合 target に反映する", async () => {
      useCodexStore.setState({
        entries: [mockEntry],
        completionTargets: [completionTarget(mockEntry)],
      });
      const readings = '{"アリス":["ありす"]}';
      mockUpdateCodexEntry.mockResolvedValue({ ...mockEntry, readings });

      await useCodexStore.getState().update("codex-1", { readings });

      expect(useCodexStore.getState().completionTargets[0].readings).toBe(
        readings,
      );
    });

    it("updates contextMode via store", async () => {
      const updated = { ...mockEntry, contextMode: "always" };
      mockUpdateCodexEntry.mockResolvedValue(updated);

      await useCodexStore
        .getState()
        .update("codex-1", { contextMode: "always" });

      expect(mockUpdateCodexEntry).toHaveBeenCalledWith(
        "default-project",
        "codex-1",
        {
          contextMode: "always",
        },
      );
    });

    it("supports updating content field", async () => {
      const updated = { ...mockEntry, content: '{"type":"doc","content":[]}' };
      mockUpdateCodexEntry.mockResolvedValue(updated);

      await useCodexStore.getState().update("codex-1", {
        content: '{"type":"doc","content":[]}',
      });

      expect(mockUpdateCodexEntry).toHaveBeenCalledWith(
        "default-project",
        "codex-1",
        {
          content: '{"type":"doc","content":[]}',
        },
      );
    });

    it("supports updating aliases field", async () => {
      const updated = { ...mockEntry, aliases: '["エララ","the apprentice"]' };
      mockUpdateCodexEntry.mockResolvedValue(updated);

      await useCodexStore
        .getState()
        .update("codex-1", { aliases: '["エララ","the apprentice"]' });

      expect(mockUpdateCodexEntry).toHaveBeenCalledWith(
        "default-project",
        "codex-1",
        {
          aliases: '["エララ","the apprentice"]',
        },
      );
    });
  });

  describe("saveTypeAndSummary", () => {
    it("type と summary を単一 OCC 更新し、全キャッシュ・履歴・summary diff を同期する", async () => {
      const before = { ...mockEntry, version: 7, summary: "古い要約" };
      const updated = {
        ...before,
        type: "location" as const,
        summary: "新しい要約",
        version: 8,
      };
      useCodexStore.setState({
        entries: [before],
        selectedEntry: before,
        completionTargets: [completionTarget(before)],
      });
      mockUpdateCodexEntry.mockResolvedValueOnce(updated);

      await expect(
        useCodexStore.getState().saveTypeAndSummary("codex-1", {
          type: "location",
          summary: "新しい要約",
        }),
      ).resolves.toBe(true);

      expect(mockUpdateCodexEntry).toHaveBeenCalledTimes(1);
      expect(mockUpdateCodexEntry).toHaveBeenCalledWith(
        "default-project",
        "codex-1",
        { type: "location", summary: "新しい要約" },
        { baseVersion: 7 },
      );
      expect(useCodexStore.getState().entries[0]).toEqual(updated);
      expect(useCodexStore.getState().selectedEntry).toEqual(updated);
      expect(useCodexStore.getState().completionTargets[0].type).toBe(
        "location",
      );
      expect(useGlobalHistoryStore.getState().past).toHaveLength(1);

      const event = findCodexUpdateEvent();
      expect(event).toBeTruthy();
      const payload = event![0].payload as {
        fields: string[];
        diffs: Record<string, { segments: [number, string][] }>;
      };
      expect(payload.fields).toEqual(["type", "summary"]);
      const summarySegments = payload.diffs.summary.segments;
      expect(
        summarySegments
          .filter(([operation]) => operation !== 1)
          .map(([, text]) => text)
          .join(""),
      ).toBe("古い要約");
      expect(
        summarySegments
          .filter(([operation]) => operation !== -1)
          .map(([, text]) => text)
          .join(""),
      ).toBe("新しい要約");
    });

    it("undo と redo でも entries・selectedEntry・completionTargets を同期する", async () => {
      const before = { ...mockEntry, version: 3, summary: "古い要約" };
      const updated = {
        ...before,
        type: "location" as const,
        summary: "新しい要約",
        version: 4,
      };
      const restored = { ...before, version: 5 };
      const reapplied = { ...updated, version: 6 };
      useCodexStore.setState({
        entries: [before],
        selectedEntry: before,
        completionTargets: [completionTarget(before)],
      });
      mockUpdateCodexEntry
        .mockResolvedValueOnce(updated)
        .mockResolvedValueOnce(restored)
        .mockResolvedValueOnce(reapplied);

      await useCodexStore.getState().saveTypeAndSummary("codex-1", {
        type: "location",
        summary: "新しい要約",
      });
      await useGlobalHistoryStore.getState().undo();

      expect(useCodexStore.getState().entries[0]).toEqual(restored);
      expect(useCodexStore.getState().selectedEntry).toEqual(restored);
      expect(useCodexStore.getState().completionTargets[0].type).toBe(
        "character",
      );

      await useGlobalHistoryStore.getState().redo();

      expect(useCodexStore.getState().entries[0]).toEqual(reapplied);
      expect(useCodexStore.getState().selectedEntry).toEqual(reapplied);
      expect(useCodexStore.getState().completionTargets[0].type).toBe(
        "location",
      );
    });

    it("遅延保存中に project が切り替わっても新 project の store・履歴・timelapse を汚染しない", async () => {
      const before = {
        ...mockEntry,
        projectId: "default-project",
        version: 7,
        summary: "旧 project の要約",
      };
      const updated = {
        ...before,
        type: "location" as const,
        summary: "保存済みの要約",
        version: 8,
      };
      const currentProjectEntry = {
        ...mockEntry,
        projectId: "project-b",
        summary: "新 project の要約",
      };
      let resolveWrite: ((entry: CodexEntry | undefined) => void) | undefined;
      mockUpdateCodexEntry.mockImplementationOnce(
        () =>
          new Promise<CodexEntry | undefined>((resolve) => {
            resolveWrite = resolve;
          }),
      );
      useCodexStore.setState({
        entries: [before],
        selectedEntry: before,
        completionTargets: [completionTarget(before)],
      });

      const save = useCodexStore.getState().saveTypeAndSummary("codex-1", {
        type: "location",
        summary: "保存済みの要約",
      });
      await vi.waitFor(() =>
        expect(mockUpdateCodexEntry).toHaveBeenCalledOnce(),
      );

      useProjectStore.setState({ currentProjectId: "project-b" });
      useCodexStore.setState({
        entries: [currentProjectEntry],
        selectedEntry: currentProjectEntry,
        completionTargets: [completionTarget(currentProjectEntry)],
      });
      resolveWrite?.(updated);

      await expect(save).resolves.toBe(true);
      expect(useCodexStore.getState().entries).toEqual([currentProjectEntry]);
      expect(useCodexStore.getState().selectedEntry).toEqual(
        currentProjectEntry,
      );
      expect(useCodexStore.getState().completionTargets).toEqual([
        completionTarget(currentProjectEntry),
      ]);
      expect(useGlobalHistoryStore.getState().past).toEqual([]);
      expect(findCodexUpdateEvent()).toBeFalsy();
    });

    it("captured project の undo・redo は永続化しても別 project の renderer を同期しない", async () => {
      const before = {
        ...mockEntry,
        projectId: "project-a",
        version: 3,
        summary: "旧要約",
      };
      const updated = {
        ...before,
        type: "location" as const,
        summary: "新要約",
        version: 4,
      };
      const restored = { ...before, version: 5 };
      const reapplied = { ...updated, version: 6 };
      const currentProjectEntry = {
        ...mockEntry,
        projectId: "project-b",
        summary: "project-b の要約",
      };
      useProjectStore.setState({ currentProjectId: "project-a" });
      useCodexStore.setState({
        entries: [before],
        selectedEntry: before,
        completionTargets: [completionTarget(before)],
      });
      mockUpdateCodexEntry
        .mockResolvedValueOnce(updated)
        .mockResolvedValueOnce(restored)
        .mockResolvedValueOnce(reapplied);

      await useCodexStore.getState().saveTypeAndSummary("codex-1", {
        type: "location",
        summary: "新要約",
      });
      const command = useGlobalHistoryStore.getState().past.at(-1);
      expect(command).toBeDefined();

      useProjectStore.setState({ currentProjectId: "project-b" });
      useCodexStore.setState({
        entries: [currentProjectEntry],
        selectedEntry: currentProjectEntry,
        completionTargets: [completionTarget(currentProjectEntry)],
      });

      await command!.undo();
      await command!.redo();

      expect(mockUpdateCodexEntry).toHaveBeenNthCalledWith(
        2,
        "project-a",
        "codex-1",
        { type: "character", summary: "旧要約" },
        { baseVersion: 4 },
      );
      expect(mockUpdateCodexEntry).toHaveBeenNthCalledWith(
        3,
        "project-a",
        "codex-1",
        { type: "location", summary: "新要約" },
        { baseVersion: 5 },
      );
      expect(useCodexStore.getState().entries).toEqual([currentProjectEntry]);
      expect(useCodexStore.getState().selectedEntry).toEqual(
        currentProjectEntry,
      );
      expect(useCodexStore.getState().completionTargets).toEqual([
        completionTarget(currentProjectEntry),
      ]);
    });

    it("同一 project id でも遅延保存中に workspace が切り替われば新 workspace を汚染しない", async () => {
      const before = {
        ...mockEntry,
        projectId: "default-project",
        version: 7,
        summary: "旧 workspace の要約",
      };
      const updated = {
        ...before,
        summary: "旧 workspace へ保存済み",
        version: 8,
      };
      const currentWorkspaceEntry = {
        ...mockEntry,
        projectId: "default-project",
        summary: "新 workspace の要約",
      };
      let resolveWrite: ((entry: CodexEntry | undefined) => void) | undefined;
      setCurrentWorkspaceIdentity({
        path: "/workspace/a.sqlite",
        openRevision: 1,
      });
      mockUpdateCodexEntry.mockImplementationOnce(
        () =>
          new Promise<CodexEntry | undefined>((resolve) => {
            resolveWrite = resolve;
          }),
      );
      useCodexStore.setState({
        entries: [before],
        selectedEntry: before,
        completionTargets: [completionTarget(before)],
      });

      const save = useCodexStore.getState().saveTypeAndSummary("codex-1", {
        type: "character",
        summary: "旧 workspace へ保存済み",
      });
      await vi.waitFor(() =>
        expect(mockUpdateCodexEntry).toHaveBeenCalledOnce(),
      );

      setCurrentWorkspaceIdentity({
        path: "/workspace/b.sqlite",
        openRevision: 2,
      });
      useCodexStore.setState({
        entries: [currentWorkspaceEntry],
        selectedEntry: currentWorkspaceEntry,
        completionTargets: [completionTarget(currentWorkspaceEntry)],
      });
      resolveWrite?.(updated);

      await expect(save).resolves.toBe(true);
      expect(useCodexStore.getState().entries).toEqual([currentWorkspaceEntry]);
      expect(useCodexStore.getState().selectedEntry).toEqual(
        currentWorkspaceEntry,
      );
      expect(useCodexStore.getState().completionTargets).toEqual([
        completionTarget(currentWorkspaceEntry),
      ]);
      expect(useGlobalHistoryStore.getState().past).toEqual([]);
      expect(findCodexUpdateEvent()).toBeFalsy();
    });

    it("OCC 競合時は false を返し、store・履歴・timelapse を変更しない", async () => {
      const before = { ...mockEntry, version: 5 };
      const conflictHandler = vi.fn();
      setCodexEditConflictHandler(conflictHandler);
      useCodexStore.setState({
        entries: [before],
        selectedEntry: before,
        completionTargets: [completionTarget(before)],
      });
      const { CodexVersionConflictError } = await import("./occ");
      mockUpdateCodexEntry.mockRejectedValueOnce(
        new CodexVersionConflictError("codex-1"),
      );

      await expect(
        useCodexStore.getState().saveTypeAndSummary("codex-1", {
          type: "location",
          summary: "競合する要約",
        }),
      ).resolves.toBe(false);

      expect(conflictHandler).toHaveBeenCalledWith("codex-1");
      expect(useCodexStore.getState().entries).toEqual([before]);
      expect(useCodexStore.getState().selectedEntry).toEqual(before);
      expect(useCodexStore.getState().completionTargets).toEqual([
        completionTarget(before),
      ]);
      expect(useGlobalHistoryStore.getState().past).toEqual([]);
      expect(findCodexUpdateEvent()).toBeFalsy();
    });

    it("通常エラーと行不在は false を返し、副作用を記録しない", async () => {
      useCodexStore.setState({
        entries: [mockEntry],
        selectedEntry: mockEntry,
      });
      mockUpdateCodexEntry.mockRejectedValueOnce(new Error("write failed"));

      await expect(
        useCodexStore.getState().saveTypeAndSummary("codex-1", {
          type: "location",
          summary: "保存されない要約",
        }),
      ).resolves.toBe(false);
      expect(useGlobalHistoryStore.getState().past).toEqual([]);
      expect(findCodexUpdateEvent()).toBeFalsy();

      vi.clearAllMocks();
      mockUpdateCodexEntry.mockResolvedValueOnce(undefined);
      await expect(
        useCodexStore.getState().saveTypeAndSummary("codex-1", {
          type: "location",
          summary: "保存されない要約",
        }),
      ).resolves.toBe(false);
      expect(useGlobalHistoryStore.getState().past).toEqual([]);
      expect(findCodexUpdateEvent()).toBeFalsy();
    });
  });

  describe("registerRubyReading", () => {
    it("ライセンス書き込み制限中は DB を読み書きしない", async () => {
      mockBlockIfUnlicensed.mockReturnValue(true);
      mockListCodexMatchTargets.mockResolvedValue([
        completionTarget(mockEntry),
      ]);
      mockGetCodexEntry.mockResolvedValue(mockEntry);
      mockUpdateCodexEntry.mockResolvedValue({
        ...mockEntry,
        readings: '{"アリス":["ありす"]}',
      });

      await expect(
        useCodexStore
          .getState()
          .registerRubyReading("codex-1", "アリス", "ありす"),
      ).resolves.toBe(false);

      expect(mockBlockIfUnlicensed).toHaveBeenCalledTimes(1);
      expect(mockListCodexMatchTargets).not.toHaveBeenCalled();
      expect(mockGetCodexEntry).not.toHaveBeenCalled();
      expect(mockUpdateCodexEntry).not.toHaveBeenCalled();
    });

    it("DB の最新 readings にマージし、最新 version で OCC 更新する", async () => {
      const latest = {
        ...mockEntry,
        aliases: '["白兎"]',
        readings: '{"アリス":["ありす"]}',
        version: 7,
      };
      const savedReadings = '{"アリス":["ありす"],"白兎":["しろうさぎ"]}';
      mockListCodexMatchTargets.mockResolvedValue([completionTarget(latest)]);
      mockGetCodexEntry.mockResolvedValue(latest);
      mockUpdateCodexEntry.mockResolvedValue({
        ...latest,
        readings: savedReadings,
        version: 8,
      });
      useCodexStore.setState({
        entries: [mockEntry],
        completionTargets: [completionTarget(mockEntry)],
      });

      await expect(
        useCodexStore
          .getState()
          .registerRubyReading("codex-1", "白兎", "しろうさぎ"),
      ).resolves.toBe(true);

      expect(mockUpdateCodexEntry).toHaveBeenCalledWith(
        "default-project",
        "codex-1",
        { readings: savedReadings },
        {
          baseVersion: 7,
          baseSurface: {
            name: "アリス",
            aliases: '["白兎"]',
            excludedAliases: "[]",
            readings: '{"アリス":["ありす"]}',
          },
        },
      );
      expect(useCodexStore.getState().completionTargets[0].readings).toBe(
        savedReadings,
      );
    });

    it("外部更新で同じ表記に読みが保存済みなら上書きしない", async () => {
      const latest = {
        ...mockEntry,
        readings: '{"アリス":["えーあいす"]}',
        version: 4,
      };
      mockListCodexMatchTargets.mockResolvedValue([completionTarget(latest)]);
      mockGetCodexEntry.mockResolvedValue(latest);

      await expect(
        useCodexStore
          .getState()
          .registerRubyReading("codex-1", "アリス", "ありす"),
      ).resolves.toBe(false);

      expect(mockUpdateCodexEntry).not.toHaveBeenCalled();
    });

    it("OCC 競合時は外部変更を壊さず conflict handler を呼ぶ", async () => {
      const latest = { ...mockEntry, version: 5 };
      mockListCodexMatchTargets.mockResolvedValue([completionTarget(latest)]);
      mockGetCodexEntry.mockResolvedValue(latest);
      const { CodexVersionConflictError } = await import("./occ");
      mockUpdateCodexEntry.mockRejectedValue(
        new CodexVersionConflictError("codex-1"),
      );
      const conflictHandler = vi.fn();
      const { setCodexEditConflictHandler } = await import("./codexStore");
      setCodexEditConflictHandler(conflictHandler);

      await expect(
        useCodexStore
          .getState()
          .registerRubyReading("codex-1", "アリス", "ありす"),
      ).resolves.toBe(false);

      expect(conflictHandler).toHaveBeenCalledWith("codex-1");
      expect(useCodexStore.getState().completionTargets).toEqual([]);
    });
  });

  describe("remove", () => {
    it("deletes an entry and reloads", async () => {
      useCodexStore.setState({ entries: [mockEntry, mockEntry2] });
      mockDeleteCodexEntry.mockResolvedValue(undefined);
      mockListCodexEntries.mockResolvedValue([mockEntry2]);

      await useCodexStore.getState().remove("codex-1");

      expect(mockDeleteCodexEntry).toHaveBeenCalledWith(
        "default-project",
        "codex-1",
      );
    });

    it("notifies chat store when codex anchor entry is deleted", async () => {
      useCodexStore.setState({ entries: [mockEntry] });
      mockDeleteCodexEntry.mockResolvedValue(undefined);
      mockListCodexEntries.mockResolvedValue([]);

      await useCodexStore.getState().remove("codex-1");

      expect(mockOnCodexAnchorDeleted).toHaveBeenCalledWith("codex-1");
    });
  });

  describe("setFilterType", () => {
    it("sets filter type and reloads", async () => {
      useCodexStore.setState({ completionTargets: allCompletionTargets });
      mockListCodexEntries.mockResolvedValue([mockEntry]);

      await useCodexStore.getState().setFilterType("character");

      expect(useCodexStore.getState().filterType).toBe("character");
      expect(mockListCodexEntries).toHaveBeenCalledWith(
        "default-project",
        "character",
      );
      expect(useCodexStore.getState().completionTargets).toEqual(
        allCompletionTargets,
      );
    });

    it("clears filter when set to null", async () => {
      mockListCodexEntries.mockResolvedValue([mockEntry, mockEntry2]);

      await useCodexStore.getState().setFilterType(null);

      expect(useCodexStore.getState().filterType).toBe(null);
      expect(mockListCodexEntries).toHaveBeenCalledWith(
        "default-project",
        undefined,
      );
    });
  });

  describe("setSort", () => {
    it("sets sort order", () => {
      useCodexStore.getState().setSort("name-desc");
      expect(useCodexStore.getState().sortOrder).toBe("name-desc");
    });

    it("defaults to name-asc", () => {
      expect(useCodexStore.getState().sortOrder).toBe("name-asc");
    });

    it("supports all sort options", () => {
      for (const order of [
        "name-asc",
        "name-desc",
        "updated",
        "created",
      ] as const) {
        useCodexStore.getState().setSort(order);
        expect(useCodexStore.getState().sortOrder).toBe(order);
      }
    });
  });

  describe("updateText timelapse capture", () => {
    const baseEntry: CodexEntry = {
      ...mockEntry,
      content: pmDoc("old body"),
      summary: "old sum",
      notes: "old notes",
    };

    it("records entry.update with content + summary diffs, excluding notes", async () => {
      useCodexStore.setState({ entries: [baseEntry] });
      mockUpdateCodexEntry.mockResolvedValue({
        ...baseEntry,
        content: pmDoc("new body"),
        summary: "new sum",
        notes: "new notes",
      });

      await useCodexStore.getState().updateText("codex-1", {
        content: pmDoc("new body"),
        summary: "new sum",
        notes: "new notes",
      });

      const call = findCodexUpdateEvent();
      expect(call).toBeTruthy();
      const payload = call![0].payload as {
        fields: string[];
        diffs: Record<string, { segments: [number, string][] }>;
      };
      expect([...payload.fields].sort()).toEqual(["content", "summary"]);
      expect(payload.diffs.notes).toBeUndefined();

      // content diff is over extracted text, not raw JSON
      const cseg = payload.diffs.content.segments;
      const cjoined = cseg.map(([, t]) => t).join("");
      expect(cjoined).not.toContain("paragraph");
      const cBefore = cseg
        .filter(([op]) => op !== 1)
        .map(([, t]) => t)
        .join("");
      const cAfter = cseg
        .filter(([op]) => op !== -1)
        .map(([, t]) => t)
        .join("");
      expect(cBefore).toBe("old body");
      expect(cAfter).toBe("new body");

      // summary diff is over plain text
      const sseg = payload.diffs.summary.segments;
      const sBefore = sseg
        .filter(([op]) => op !== 1)
        .map(([, t]) => t)
        .join("");
      const sAfter = sseg
        .filter(([op]) => op !== -1)
        .map(([, t]) => t)
        .join("");
      expect(sBefore).toBe("old sum");
      expect(sAfter).toBe("new sum");
    });

    it("records nothing when only notes change", async () => {
      useCodexStore.setState({ entries: [baseEntry] });
      mockUpdateCodexEntry.mockResolvedValue({
        ...baseEntry,
        notes: "new notes",
      });

      await useCodexStore
        .getState()
        .updateText("codex-1", { notes: "new notes" });

      expect(findCodexUpdateEvent()).toBeFalsy();
    });

    it("records nothing when a body field is set but unchanged", async () => {
      useCodexStore.setState({ entries: [baseEntry] });
      mockUpdateCodexEntry.mockResolvedValue(baseEntry);

      await useCodexStore
        .getState()
        .updateText("codex-1", { content: pmDoc("old body") });

      expect(findCodexUpdateEvent()).toBeFalsy();
    });
  });
});
