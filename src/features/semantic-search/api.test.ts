import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

import {
  chatIndexMessage,
  chatIndexStatus,
  chatMessageSearch,
  chatReindexAll,
  codexIndexEntry,
  codexIndexStatus,
  codexReindexAll,
  codexSemanticSearch,
  downloadSemanticModel,
  eventsIndexEntry,
  eventsIndexStatus,
  eventsReindexAll,
  eventsSemanticSearch,
  getSemanticChunkContext,
  semanticDebugDump,
  semanticCancelBackground,
  semanticIndexScene,
  semanticIndexStatus,
  semanticReindexAll,
  semanticSearch,
  type SemanticIndexStatus,
  type SemanticSearchHit,
} from "./api";

describe("semantic-search/api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("semanticCancelBackground", () => {
    it("invokes semantic_cancel_background without project-scoped payload", async () => {
      mockInvoke.mockResolvedValueOnce(7);
      await expect(semanticCancelBackground()).resolves.toBe(7);
      expect(mockInvoke).toHaveBeenCalledWith("semantic_cancel_background", {});
    });
  });

  describe("semanticIndexScene", () => {
    it("invokes semantic_index_scene with sceneId payload", async () => {
      mockInvoke.mockResolvedValueOnce(7);
      const n = await semanticIndexScene("scene-abc");
      expect(mockInvoke).toHaveBeenCalledWith("semantic_index_scene", {
        sceneId: "scene-abc",
      });
      expect(n).toBe(7);
    });
  });

  describe("semanticSearch", () => {
    it("passes all parameters with null/false defaults when omitted", async () => {
      mockInvoke.mockResolvedValueOnce([]);
      await semanticSearch({
        projectId: "p1",
        query: "嵐の描写",
        limit: 5,
      });
      expect(mockInvoke).toHaveBeenCalledWith("semantic_search", {
        projectId: "p1",
        query: "嵐の描写",
        limit: 5,
        sceneScope: null,
        descriptionMode: false,
      });
    });

    it("passes sceneScope and descriptionMode when provided", async () => {
      mockInvoke.mockResolvedValueOnce([]);
      await semanticSearch({
        projectId: "p1",
        query: "q",
        limit: 3,
        sceneScope: "scene-xyz",
        descriptionMode: true,
      });
      expect(mockInvoke).toHaveBeenCalledWith("semantic_search", {
        projectId: "p1",
        query: "q",
        limit: 3,
        sceneScope: "scene-xyz",
        descriptionMode: true,
      });
    });

    it("returns the typed hit list from Rust", async () => {
      const hits: SemanticSearchHit[] = [
        {
          sceneId: "s1",
          sceneTitle: "第三章",
          chunkText: "雨が窓を叩いていた。",
          charStart: 0,
          charEnd: 11,
          score: 0.87,
          dialogueRatio: 0.0,
        },
      ];
      mockInvoke.mockResolvedValueOnce(hits);
      const result = await semanticSearch({
        projectId: "p1",
        query: "嵐",
        limit: 5,
      });
      expect(result).toEqual(hits);
    });
  });

  describe("semanticReindexAll", () => {
    it("invokes semantic_reindex_all with projectId payload", async () => {
      mockInvoke.mockResolvedValueOnce(42);
      const n = await semanticReindexAll("p1");
      expect(mockInvoke).toHaveBeenCalledWith("semantic_reindex_all", {
        projectId: "p1",
      });
      expect(n).toBe(42);
    });

    it("passes an optional runId without changing the numeric return contract", async () => {
      mockInvoke.mockResolvedValueOnce(9);
      await expect(semanticReindexAll("p1", "run-123")).resolves.toBe(9);
      expect(mockInvoke).toHaveBeenCalledWith("semantic_reindex_all", {
        projectId: "p1",
        runId: "run-123",
      });
    });
  });

  describe("semanticIndexStatus", () => {
    it("invokes semantic_index_status and returns typed report", async () => {
      const report: SemanticIndexStatus = {
        indexedChunkCount: 100,
        staleChunkCount: 10,
        indexedSceneCount: 8,
        nonemptySceneCount: 8,
        currentModelId: "cl-nagoya/ruri-v3-30m@local/model_int8.onnx/prefix-v1",
        currentEmbeddingDim: 256,
        currentChunkerVersion: "semantic-prose-chunker-v1",
      };
      mockInvoke.mockResolvedValueOnce(report);
      const result = await semanticIndexStatus("p1");
      expect(mockInvoke).toHaveBeenCalledWith("semantic_index_status", {
        projectId: "p1",
      });
      expect(result).toEqual(report);
    });
  });

  describe("remaining semantic command wrappers", () => {
    it.each([
      {
        name: "semantic_download_model",
        call: () => downloadSemanticModel("ja"),
        args: { language: "ja" },
      },
      {
        name: "codex_semantic_search",
        call: () =>
          codexSemanticSearch({ projectId: "p1", query: "hero", limit: 5 }),
        args: { projectId: "p1", query: "hero", limit: 5 },
      },
      {
        name: "codex_index_entry",
        call: () => codexIndexEntry("entry-1"),
        args: { entryId: "entry-1" },
      },
      {
        name: "codex_index_status",
        call: () => codexIndexStatus("p1"),
        args: { projectId: "p1" },
      },
      {
        name: "codex_reindex_all",
        call: () => codexReindexAll("p1"),
        args: { projectId: "p1" },
      },
      {
        name: "events_semantic_search",
        call: () =>
          eventsSemanticSearch({ projectId: "p1", query: "storm", limit: 6 }),
        args: { projectId: "p1", query: "storm", limit: 6 },
      },
      {
        name: "events_index_entry",
        call: () => eventsIndexEntry("event-1"),
        args: { eventId: "event-1" },
      },
      {
        name: "events_index_status",
        call: () => eventsIndexStatus("p1"),
        args: { projectId: "p1" },
      },
      {
        name: "events_reindex_all",
        call: () => eventsReindexAll("p1"),
        args: { projectId: "p1" },
      },
      {
        name: "chat_message_search",
        call: () =>
          chatMessageSearch({ projectId: "p1", query: "memory", limit: 7 }),
        args: { projectId: "p1", query: "memory", limit: 7 },
      },
      {
        name: "chat_index_message",
        call: () => chatIndexMessage("message-1"),
        args: { messageId: "message-1" },
      },
      {
        name: "chat_index_status",
        call: () => chatIndexStatus("p1"),
        args: { projectId: "p1" },
      },
      {
        name: "chat_reindex_all",
        call: () => chatReindexAll("p1"),
        args: { projectId: "p1" },
      },
      {
        name: "semantic_chunk_context",
        call: () =>
          getSemanticChunkContext({
            sceneId: "scene-1",
            charStart: 2,
            charEnd: 9,
            padding: 100,
          }),
        args: {
          sceneId: "scene-1",
          charStart: 2,
          charEnd: 9,
          padding: 100,
        },
      },
      {
        name: "semantic_debug_dump",
        call: () => semanticDebugDump({ projectId: "p1" }),
        args: { projectId: "p1", sceneId: null, limit: null },
      },
    ])(
      "maps $name with the exact camelCase payload",
      async ({ name, call, args }) => {
        mockInvoke.mockResolvedValueOnce(null);
        await call();
        expect(mockInvoke).toHaveBeenCalledWith(name, args);
      },
    );
  });
});
