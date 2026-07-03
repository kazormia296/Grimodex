import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

import {
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
});
