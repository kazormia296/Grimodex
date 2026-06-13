import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

import type { SemanticSearchHit } from "../semantic-search/api";
import {
  buildSemanticRecallQuery,
  selectSemanticRecallChunks,
  fetchSemanticRecall,
  recallParamsForLang,
  SEMANTIC_RECALL_MIN_SCORE,
  SEMANTIC_RECALL_MIN_SCORE_EN,
  SEMANTIC_RECALL_MAX_CHUNKS,
  SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS,
  SEMANTIC_RECALL_MAX_CHUNK_CHARS,
  SEMANTIC_RECALL_MAX_CHUNK_CHARS_EN,
} from "./semanticRecall";

function makeHit(over: Partial<SemanticSearchHit> = {}): SemanticSearchHit {
  return {
    sceneId: "scene-x",
    sceneTitle: "過去のシーン",
    chunkText: "海は荒れていた。",
    charStart: 0,
    charEnd: 8,
    score: 0.8,
    dialogueRatio: 0.1,
    ...over,
  };
}

describe("buildSemanticRecallQuery", () => {
  it("combines the user message and the scene body tail", () => {
    const q = buildSemanticRecallQuery({
      userMessage: "嵐のシーンの続きを相談したい",
      sceneBody: "太郎は窓の外を見つめていた。",
    });
    expect(q).toContain("嵐のシーンの続きを相談したい");
    expect(q).toContain("太郎は窓の外を見つめていた。");
  });

  it("returns only the user message when the body is empty (eco mode)", () => {
    const q = buildSemanticRecallQuery({
      userMessage: "嵐のシーン",
      sceneBody: "",
    });
    expect(q).toBe("嵐のシーン");
  });

  it("returns only the body tail when the user message is blank", () => {
    const q = buildSemanticRecallQuery({
      userMessage: "   ",
      sceneBody: "海辺の描写。",
    });
    expect(q).toBe("海辺の描写。");
  });

  it("returns an empty string when both inputs are blank", () => {
    expect(buildSemanticRecallQuery({ userMessage: "", sceneBody: "  " })).toBe(
      "",
    );
    expect(buildSemanticRecallQuery({ userMessage: "" })).toBe("");
  });

  it("keeps only the tail of a long scene body", () => {
    const head = "冒頭の目印テキスト。";
    const tail = "末尾の目印テキスト。";
    const filler = "あ".repeat(SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS);
    const q = buildSemanticRecallQuery({
      userMessage: "相談",
      sceneBody: head + filler + tail,
    });
    expect(q).toContain(tail);
    expect(q).not.toContain(head);
  });
});

describe("selectSemanticRecallChunks", () => {
  it("drops hits below the minimum score", () => {
    const hits = [
      makeHit({ sceneId: "a", score: SEMANTIC_RECALL_MIN_SCORE + 0.1 }),
      makeHit({ sceneId: "b", score: SEMANTIC_RECALL_MIN_SCORE - 0.1 }),
    ];
    const chunks = selectSemanticRecallChunks(hits, { excludeSceneIds: [] });
    expect(chunks.map((c) => c.sceneId)).toEqual(["a"]);
  });

  it("excludes the current scene and mentioned scenes", () => {
    const hits = [
      makeHit({ sceneId: "current" }),
      makeHit({ sceneId: "mentioned" }),
      makeHit({ sceneId: "other" }),
    ];
    const chunks = selectSemanticRecallChunks(hits, {
      excludeSceneIds: ["current", "mentioned"],
    });
    expect(chunks.map((c) => c.sceneId)).toEqual(["other"]);
  });

  it("caps the number of chunks", () => {
    const hits = Array.from(
      { length: SEMANTIC_RECALL_MAX_CHUNKS + 5 },
      (_, i) => makeHit({ sceneId: `s${i}`, score: 0.9 }),
    );
    const chunks = selectSemanticRecallChunks(hits, { excludeSceneIds: [] });
    expect(chunks).toHaveLength(SEMANTIC_RECALL_MAX_CHUNKS);
  });

  it("orders chunks by score descending", () => {
    const hits = [
      makeHit({ sceneId: "low", score: 0.6 }),
      makeHit({ sceneId: "high", score: 0.95 }),
      makeHit({ sceneId: "mid", score: 0.8 }),
    ];
    const chunks = selectSemanticRecallChunks(hits, { excludeSceneIds: [] });
    expect(chunks.map((c) => c.sceneId)).toEqual(["high", "mid", "low"]);
  });

  it("truncates over-long chunk text", () => {
    const long = "長".repeat(SEMANTIC_RECALL_MAX_CHUNK_CHARS + 200);
    const chunks = selectSemanticRecallChunks([makeHit({ chunkText: long })], {
      excludeSceneIds: [],
    });
    expect(chunks[0].chunkText.length).toBeLessThanOrEqual(
      SEMANTIC_RECALL_MAX_CHUNK_CHARS + 1,
    );
    expect(
      chunks[0].chunkText.startsWith(
        long.slice(0, SEMANTIC_RECALL_MAX_CHUNK_CHARS - 1),
      ),
    ).toBe(true);
  });

  it("keeps short chunk text untouched", () => {
    const chunks = selectSemanticRecallChunks(
      [makeHit({ chunkText: "短い抜粋。" })],
      { excludeSceneIds: [] },
    );
    expect(chunks[0].chunkText).toBe("短い抜粋。");
  });

  it("returns an empty array for no hits", () => {
    expect(selectSemanticRecallChunks([], { excludeSceneIds: [] })).toEqual([]);
  });
});

describe("recallParamsForLang", () => {
  it("ja uses the ruri baseline params", () => {
    expect(recallParamsForLang("ja")).toEqual({
      minScore: SEMANTIC_RECALL_MIN_SCORE,
      maxChunkChars: SEMANTIC_RECALL_MAX_CHUNK_CHARS,
    });
  });

  it("en uses the English model params with a wider chunk cap", () => {
    expect(recallParamsForLang("en")).toEqual({
      minScore: SEMANTIC_RECALL_MIN_SCORE_EN,
      maxChunkChars: SEMANTIC_RECALL_MAX_CHUNK_CHARS_EN,
    });
    expect(SEMANTIC_RECALL_MAX_CHUNK_CHARS_EN).toBeGreaterThan(
      SEMANTIC_RECALL_MAX_CHUNK_CHARS,
    );
  });

  it("unknown languages fall back to ja params", () => {
    expect(recallParamsForLang("zh").minScore).toBe(SEMANTIC_RECALL_MIN_SCORE);
  });
});

describe("fetchSemanticRecall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns [] without invoking when the query is blank", async () => {
    const chunks = await fetchSemanticRecall({
      projectId: "p1",
      query: "   ",
      excludeSceneIds: [],
    });
    expect(chunks).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes semantic_search scoped to the project and filters the hits", async () => {
    mockInvoke.mockResolvedValueOnce([
      makeHit({ sceneId: "current", score: 0.99 }),
      makeHit({ sceneId: "good", score: 0.9, chunkText: "良い抜粋。" }),
      makeHit({ sceneId: "weak", score: 0.1 }),
    ]);
    const chunks = await fetchSemanticRecall({
      projectId: "p1",
      query: "嵐の描写",
      excludeSceneIds: ["current"],
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [cmd, payload] = mockInvoke.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cmd).toBe("semantic_search");
    expect(payload.projectId).toBe("p1");
    expect(payload.query).toBe("嵐の描写");
    // 後段フィルタで間引かれる分を見込んで、表示上限より多めに取得する
    expect(payload.limit as number).toBeGreaterThan(SEMANTIC_RECALL_MAX_CHUNKS);
    expect(chunks.map((c) => c.sceneId)).toEqual(["good"]);
    expect(chunks[0].chunkText).toBe("良い抜粋。");
  });

  it("returns [] when the invoke fails (feature-gated build / model missing)", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("command not found"));
    const chunks = await fetchSemanticRecall({
      projectId: "p1",
      query: "嵐",
      excludeSceneIds: [],
    });
    expect(chunks).toEqual([]);
  });
});
