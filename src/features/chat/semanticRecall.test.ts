import { describe, it, expect, beforeEach, vi } from "vitest";

const rerankerMocks = vi.hoisted(() => ({
  apply: vi.fn(),
  scheduleShadow: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

vi.mock("./semanticRerankerApply", () => ({
  applySemanticReranker: rerankerMocks.apply,
}));

vi.mock("./semanticRerankerShadow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./semanticRerankerShadow")>()),
  scheduleSemanticRerankerShadow: rerankerMocks.scheduleShadow,
}));

import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

import type { SemanticSearchHit } from "../semantic-search/api";
import {
  buildSemanticRecallQuery,
  selectSemanticRecallChunks,
  selectHybridRecallHits,
  selectHybridRecallChunks,
  fetchSemanticRecall,
  recallParamsForLang,
  SEMANTIC_RECALL_MIN_SCORE,
  SEMANTIC_RECALL_MIN_SCORE_EN,
  SEMANTIC_RECALL_TOP1_GATE,
  SEMANTIC_RECALL_TOP1_GATE_EN,
  SEMANTIC_RECALL_MAX_CHUNKS,
  SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS,
  SEMANTIC_RECALL_MAX_CHUNK_CHARS,
  SEMANTIC_RECALL_MAX_CHUNK_CHARS_EN,
  SEMANTIC_RECALL_RESCUE_MARGIN,
  SEMANTIC_RECALL_HYBRID_FETCH_LIMIT,
  SEMANTIC_RECALL_SPARSE_LIMIT,
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

  it("injects nothing when the best hit is below the top-1 gate", () => {
    // floor (MIN_SCORE) は超えるが gate には届かない「団子だけ」のクエリ。
    const mid = (SEMANTIC_RECALL_MIN_SCORE + SEMANTIC_RECALL_TOP1_GATE) / 2;
    const hits = [
      makeHit({ sceneId: "a", score: mid }),
      makeHit({ sceneId: "b", score: SEMANTIC_RECALL_MIN_SCORE }),
    ];
    expect(selectSemanticRecallChunks(hits, { excludeSceneIds: [] })).toEqual(
      [],
    );
  });

  it("pulls in runners-up down to the floor once the top hit clears the gate", () => {
    const hits = [
      makeHit({ sceneId: "win", score: SEMANTIC_RECALL_TOP1_GATE + 0.05 }),
      makeHit({ sceneId: "second", score: SEMANTIC_RECALL_MIN_SCORE + 0.01 }),
      makeHit({
        sceneId: "belowFloor",
        score: SEMANTIC_RECALL_MIN_SCORE - 0.01,
      }),
    ];
    const chunks = selectSemanticRecallChunks(hits, { excludeSceneIds: [] });
    // win が gate を超えるので、gate 未満だが floor 以上の second も拾う。
    expect(chunks.map((c) => c.sceneId)).toEqual(["win", "second"]);
  });

  it("prioritizes distinct scenes over a second chunk of the same scene", () => {
    // 別シーンが 3 つあるので、a の二番手 (0.85) より別シーン c を優先する。
    const hits = [
      makeHit({ sceneId: "a", score: 0.95 }),
      makeHit({ sceneId: "b", score: 0.9 }),
      makeHit({ sceneId: "c", score: 0.88 }),
      makeHit({ sceneId: "a", score: 0.85 }),
    ];
    const chunks = selectSemanticRecallChunks(hits, {
      excludeSceneIds: [],
      minScore: 0,
      gateScore: 0,
    });
    expect(chunks.map((c) => c.sceneId)).toEqual(["a", "b", "c"]);
  });

  it("backfills remaining slots with secondary chunks when scenes are scarce", () => {
    // 別シーンが a / b の 2 つしか無いので、余り枠を a の二番手チャンクで埋める。
    const hits = [
      makeHit({ sceneId: "a", score: 0.95, chunkText: "a-best" }),
      makeHit({ sceneId: "a", score: 0.9, chunkText: "a-second" }),
      makeHit({ sceneId: "b", score: 0.88, chunkText: "b-1" }),
    ];
    const chunks = selectSemanticRecallChunks(hits, {
      excludeSceneIds: [],
      minScore: 0,
      gateScore: 0,
    });
    // distinct (a-best, b) 優先 + 余り 1 枠に a-second、最後にスコア降順で並べる。
    expect(chunks.map((c) => c.sceneId)).toEqual(["a", "a", "b"]);
    expect(chunks.map((c) => c.chunkText)).toEqual([
      "a-best",
      "a-second",
      "b-1",
    ]);
  });

  it("excludes the current scene and mentioned scenes", () => {
    const hits = [
      makeHit({ sceneId: "current" }),
      makeHit({ sceneId: "mentioned" }),
      makeHit({ sceneId: "other" }),
    ];
    const chunks = selectSemanticRecallChunks(hits, {
      excludeSceneIds: ["current", "mentioned"],
      minScore: 0,
      gateScore: 0,
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
    const chunks = selectSemanticRecallChunks(hits, {
      excludeSceneIds: [],
      minScore: 0,
      gateScore: 0,
    });
    expect(chunks.map((c) => c.sceneId)).toEqual(["high", "mid", "low"]);
  });

  it("truncates over-long chunk text", () => {
    const long = "長".repeat(SEMANTIC_RECALL_MAX_CHUNK_CHARS + 200);
    const chunks = selectSemanticRecallChunks([makeHit({ chunkText: long })], {
      excludeSceneIds: [],
      minScore: 0,
      gateScore: 0,
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
      { excludeSceneIds: [], minScore: 0, gateScore: 0 },
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
      gateScore: SEMANTIC_RECALL_TOP1_GATE,
    });
  });

  it("en uses the English model params with a wider chunk cap", () => {
    expect(recallParamsForLang("en")).toEqual({
      minScore: SEMANTIC_RECALL_MIN_SCORE_EN,
      maxChunkChars: SEMANTIC_RECALL_MAX_CHUNK_CHARS_EN,
      gateScore: SEMANTIC_RECALL_TOP1_GATE_EN,
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

describe("selectHybridRecallChunks", () => {
  const FLOOR = SEMANTIC_RECALL_MIN_SCORE; // 0.80 (ja)
  const GATE = SEMANTIC_RECALL_TOP1_GATE; // 0.85 (ja)
  // 団子帯 (>=floor だが <gate): dense 単独では「勝者なし」でゲートに弾かれる。
  const DANGO = (FLOOR + GATE) / 2;
  // 床を割るが rescue 床 (floor - margin) は上回る、語彙一致で救済可能な帯。
  const RESCUE_BAND = FLOOR - SEMANTIC_RECALL_RESCUE_MARGIN / 2;

  it("degrades to the dense-only selection when the sparse list is empty", () => {
    // 勝者あり + 床以上の runner-up + 床割れ。sparse 無しなら従来挙動と一致。
    const hits = [
      makeHit({ sceneId: "win", score: GATE + 0.05 }),
      makeHit({ sceneId: "second", score: FLOOR + 0.01 }),
      makeHit({ sceneId: "belowFloor", score: FLOOR - 0.01 }),
    ];
    const chunks = selectHybridRecallChunks(hits, [], { excludeSceneIds: [] });
    expect(chunks.map((c) => c.sceneId)).toEqual(["win", "second"]);
  });

  it("uses the same hit selection contract as the production chunk adapter", () => {
    const hits = [
      makeHit({ sceneId: "a", score: GATE + 0.05, chunkText: "a-best" }),
      makeHit({ sceneId: "a", score: FLOOR + 0.01, chunkText: "a-second" }),
      makeHit({ sceneId: "b", score: RESCUE_BAND, chunkText: "b-best" }),
    ];
    const options = {
      excludeSceneIds: [] as string[],
      minScore: FLOOR,
      gateScore: GATE,
      maxChunks: 3,
      maxChunkChars: 600,
      rescueMargin: SEMANTIC_RECALL_RESCUE_MARGIN,
    };

    const selectedHits = selectHybridRecallHits(hits, ["b"], options);
    const chunks = selectHybridRecallChunks(hits, ["b"], options);

    expect(
      chunks.map((chunk) => ({
        sceneId: chunk.sceneId,
        chunkText: chunk.chunkText,
        score: chunk.score,
      })),
    ).toEqual(
      selectedHits.map((selected) => ({
        sceneId: selected.sceneId,
        chunkText: selected.chunkText,
        score: selected.score,
      })),
    );
  });

  it("injects nothing when there is no dense winner and no sparse rescue", () => {
    // 団子だけ (>=floor, <gate) で sparse ヒットも無い → precision 維持で空。
    const hits = [
      makeHit({ sceneId: "a", score: DANGO }),
      makeHit({ sceneId: "b", score: FLOOR }),
    ];
    expect(selectHybridRecallChunks(hits, [], { excludeSceneIds: [] })).toEqual(
      [],
    );
  });

  it("rescues a sparse top hit below the floor when there is no dense winner", () => {
    // dense 単独だと irene (床割れ) は捨てられ、団子しか無いのでゲートで全没 → 空。
    // sparse top-1 に irene が居るので、rescue 床まで引き上げて irene だけ注入する。
    const hits = [
      makeHit({ sceneId: "dango", score: DANGO }),
      makeHit({
        sceneId: "irene",
        score: RESCUE_BAND,
        chunkText: "アイリーンは振り返った。",
      }),
    ];
    const chunks = selectHybridRecallChunks(hits, ["irene"], {
      excludeSceneIds: [],
    });
    // 救済は sparse 一致 scene のみ。団子 (dango) は巻き込まない。
    expect(chunks.map((c) => c.sceneId)).toEqual(["irene"]);
    expect(chunks[0].chunkText).toBe("アイリーンは振り返った。");
  });

  it("does not rescue a sparse hit whose cosine is below the rescue floor", () => {
    // 語彙は一致するが意味的には無関係 (cosine 0.5)。rescue 床未満なので注入しない。
    const hits = [
      makeHit({ sceneId: "dango", score: DANGO }),
      makeHit({ sceneId: "coincidence", score: 0.5 }),
    ];
    expect(
      selectHybridRecallChunks(hits, ["coincidence"], { excludeSceneIds: [] }),
    ).toEqual([]);
  });

  it("does not inject a sparse-only scene that is absent from the dense pool", () => {
    // dense pool に無いシーンは chunkText も cosine も無いので注入対象外 (MVP 制約)。
    const hits = [makeHit({ sceneId: "a", score: GATE + 0.05 })];
    const chunks = selectHybridRecallChunks(hits, ["ghost", "a"], {
      excludeSceneIds: [],
    });
    expect(chunks.map((c) => c.sceneId)).toEqual(["a"]);
  });

  it("lifts a scene ranked high in both dense and sparse above dense-only scenes (RRF)", () => {
    // C は dense 3 位だが sparse 1 位。RRF で A/B を抜いて先頭に来る。
    const hits = [
      makeHit({ sceneId: "A", score: 0.95 }),
      makeHit({ sceneId: "B", score: 0.92 }),
      makeHit({ sceneId: "C", score: 0.9 }),
    ];
    const chunks = selectHybridRecallChunks(hits, ["C"], {
      excludeSceneIds: [],
    });
    expect(chunks.map((c) => c.sceneId)).toEqual(["C", "A", "B"]);
  });

  it("applies excludeSceneIds to the sparse rescue path too", () => {
    // sparse 一致シーンが除外対象なら救済しない → 団子だけ残り空になる。
    const hits = [
      makeHit({ sceneId: "dango", score: DANGO }),
      makeHit({ sceneId: "irene", score: RESCUE_BAND }),
    ];
    const chunks = selectHybridRecallChunks(hits, ["irene"], {
      excludeSceneIds: ["irene"],
    });
    expect(chunks).toEqual([]);
  });

  it("backfills remaining slots with same-scene runner-ups when a winner is present", () => {
    // distinct シーンが a / b の 2 つだけ。勝者ありなので余り枠を a の二番手で埋める。
    const hits = [
      makeHit({ sceneId: "a", score: GATE + 0.05, chunkText: "a-best" }),
      makeHit({ sceneId: "a", score: GATE, chunkText: "a-second" }),
      makeHit({ sceneId: "b", score: FLOOR + 0.02, chunkText: "b-1" }),
    ];
    const chunks = selectHybridRecallChunks(hits, [], { excludeSceneIds: [] });
    expect(chunks.map((c) => c.sceneId)).toEqual(["a", "b", "a"]);
    expect(chunks.map((c) => c.chunkText)).toEqual([
      "a-best",
      "b-1",
      "a-second",
    ]);
  });

  it("does not backfill in the rescue-only regime (no dense winner)", () => {
    // 勝者がいない救済のみのとき、団子の二番手で枠を埋めない (precision 維持)。
    const hits = [
      makeHit({ sceneId: "irene", score: RESCUE_BAND, chunkText: "irene-1" }),
      makeHit({ sceneId: "dango", score: DANGO, chunkText: "dango-best" }),
      makeHit({ sceneId: "dango", score: DANGO - 0.01, chunkText: "dango-2" }),
    ];
    const chunks = selectHybridRecallChunks(hits, ["irene"], {
      excludeSceneIds: [],
    });
    // irene だけ。床以上の dango (団子) もその二番手も巻き込まない。
    expect(chunks.map((c) => c.sceneId)).toEqual(["irene"]);
  });

  it("caps the number of injected chunks", () => {
    const win = makeHit({ sceneId: "win", score: GATE + 0.05 });
    const extras = Array.from(
      { length: SEMANTIC_RECALL_MAX_CHUNKS + 3 },
      (_, i) => makeHit({ sceneId: `r${i}`, score: RESCUE_BAND }),
    );
    const sparseIds = extras.map((h) => h.sceneId);
    const chunks = selectHybridRecallChunks([win, ...extras], sparseIds, {
      excludeSceneIds: [],
    });
    expect(chunks).toHaveLength(SEMANTIC_RECALL_MAX_CHUNKS);
  });

  it("truncates over-long chunk text", () => {
    const long = "長".repeat(SEMANTIC_RECALL_MAX_CHUNK_CHARS + 200);
    const chunks = selectHybridRecallChunks(
      [makeHit({ sceneId: "win", score: GATE + 0.05, chunkText: long })],
      [],
      { excludeSceneIds: [] },
    );
    expect(chunks[0].chunkText.length).toBeLessThanOrEqual(
      SEMANTIC_RECALL_MAX_CHUNK_CHARS + 1,
    );
  });
});

describe("fetchSemanticRecall (hybrid mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function routeInvoke(opts: {
    dense?: SemanticSearchHit[] | (() => Promise<unknown>);
    sparse?: unknown[] | (() => Promise<unknown>);
  }) {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "semantic_search") {
        return typeof opts.dense === "function"
          ? opts.dense()
          : Promise.resolve(opts.dense ?? []);
      }
      if (cmd === "fts_search") {
        return typeof opts.sparse === "function"
          ? opts.sparse()
          : Promise.resolve(opts.sparse ?? []);
      }
      return Promise.resolve([]);
    });
  }

  it("queries fts_search (scope=scenes) and fuses it to rescue a borderline scene", async () => {
    routeInvoke({
      dense: [
        makeHit({ sceneId: "dango", score: 0.825 }),
        makeHit({
          sceneId: "irene",
          score: 0.78,
          chunkText: "アイリーンは振り返った。",
        }),
      ],
      sparse: [
        { sourceType: "scene", id: "irene", title: "再会", excerpt: "" },
      ],
    });
    const chunks = await fetchSemanticRecall({
      projectId: "p1",
      query: "アイリーンのシーン",
      excludeSceneIds: [],
      hybrid: true,
    });
    expect(chunks.map((c) => c.sceneId)).toEqual(["irene"]);

    const ftsCall = mockInvoke.mock.calls.find(([cmd]) => cmd === "fts_search");
    expect(ftsCall).toBeDefined();
    const ftsPayload = ftsCall![1] as Record<string, unknown>;
    expect(ftsPayload.scope).toBe("scenes");
    expect(ftsPayload.projectId).toBe("p1");
    expect(ftsPayload.query).toBe("アイリーンのシーン");
    expect(ftsPayload.limit).toBe(SEMANTIC_RECALL_SPARSE_LIMIT);
  });

  it("fetches a larger dense candidate pool in hybrid mode", async () => {
    routeInvoke({
      dense: [makeHit({ sceneId: "win", score: 0.92 })],
      sparse: [],
    });
    await fetchSemanticRecall({
      projectId: "p1",
      query: "嵐",
      excludeSceneIds: [],
      hybrid: true,
    });
    const denseCall = mockInvoke.mock.calls.find(
      ([cmd]) => cmd === "semantic_search",
    );
    const densePayload = denseCall![1] as Record<string, unknown>;
    expect(densePayload.limit).toBe(SEMANTIC_RECALL_HYBRID_FETCH_LIMIT);
  });

  it("falls back to the dense-only selection when fts_search fails", async () => {
    routeInvoke({
      dense: [makeHit({ sceneId: "win", score: 0.92, chunkText: "勝者" })],
      sparse: () => Promise.reject(new Error("fts boom")),
    });
    const chunks = await fetchSemanticRecall({
      projectId: "p1",
      query: "嵐",
      excludeSceneIds: [],
      hybrid: true,
    });
    expect(chunks.map((c) => c.sceneId)).toEqual(["win"]);
  });

  it("does not query fts_search when hybrid mode is off", async () => {
    routeInvoke({ dense: [makeHit({ sceneId: "win", score: 0.92 })] });
    await fetchSemanticRecall({
      projectId: "p1",
      query: "嵐",
      excludeSceneIds: [],
    });
    const ftsCalled = mockInvoke.mock.calls.some(
      ([cmd]) => cmd === "fts_search",
    );
    expect(ftsCalled).toBe(false);
  });

  it("awaits apply mode and returns the reranked admitted order", async () => {
    const first = makeHit({
      sceneId: "first",
      score: 0.94,
      charStart: 0,
      charEnd: 10,
    });
    const second = makeHit({
      sceneId: "second",
      score: 0.9,
      charStart: 10,
      charEnd: 20,
    });
    routeInvoke({
      dense: [first, second],
      sparse: [
        { sourceType: "scene", id: "first", title: "First", excerpt: "" },
        { sourceType: "scene", id: "second", title: "Second", excerpt: "" },
      ],
    });
    rerankerMocks.apply.mockResolvedValueOnce({
      status: "applied",
      hits: [second, first],
    });

    const chunks = await fetchSemanticRecall({
      projectId: "p1",
      query: "灯台の約束",
      excludeSceneIds: [],
      hybrid: true,
      reranker: {
        mode: "apply",
        requestId: "request-1",
        scope: {
          workspaceKey: "/workspace",
          workspaceOpenRevision: 3,
          projectId: "p1",
        },
        userMessage: "約束を思い出して",
        sceneTail: "灯台の鐘が鳴った。",
        language: "ja",
        localInferenceExpected: true,
      },
    });

    expect(chunks.map((chunk) => chunk.sceneId)).toEqual(["second", "first"]);
    expect(rerankerMocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        denseHits: [first, second],
        baselineInjectedHits: [first, second],
        hybrid: true,
      }),
    );
    expect(rerankerMocks.scheduleShadow).not.toHaveBeenCalled();
  });

  it("keeps the baseline order when apply mode falls back", async () => {
    const first = makeHit({ sceneId: "first", score: 0.94 });
    const second = makeHit({ sceneId: "second", score: 0.9 });
    routeInvoke({
      dense: [first, second],
      sparse: [
        { sourceType: "scene", id: "first", title: "First", excerpt: "" },
        { sourceType: "scene", id: "second", title: "Second", excerpt: "" },
      ],
    });
    rerankerMocks.apply.mockResolvedValueOnce({
      status: "fallback",
      reason: "timeout",
      hits: [first, second],
    });

    const chunks = await fetchSemanticRecall({
      projectId: "p1",
      query: "灯台の約束",
      excludeSceneIds: [],
      hybrid: true,
      reranker: {
        mode: "apply",
        requestId: "request-1",
        scope: {
          workspaceKey: "/workspace",
          workspaceOpenRevision: 3,
          projectId: "p1",
        },
        userMessage: "約束を思い出して",
        sceneTail: "灯台の鐘が鳴った。",
        language: "ja",
        localInferenceExpected: true,
      },
    });

    expect(chunks.map((chunk) => chunk.sceneId)).toEqual(["first", "second"]);
  });

  it("keeps shadow mode fire-and-forget and never changes injection", async () => {
    const first = makeHit({ sceneId: "first", score: 0.94 });
    const second = makeHit({ sceneId: "second", score: 0.9 });
    routeInvoke({
      dense: [first, second],
      sparse: [
        { sourceType: "scene", id: "first", title: "First", excerpt: "" },
        { sourceType: "scene", id: "second", title: "Second", excerpt: "" },
      ],
    });

    const chunks = await fetchSemanticRecall({
      projectId: "p1",
      query: "灯台の約束",
      excludeSceneIds: [],
      hybrid: true,
      reranker: {
        mode: "shadow",
        requestId: "request-1",
        scope: {
          workspaceKey: "/workspace",
          workspaceOpenRevision: 3,
          projectId: "p1",
        },
        userMessage: "約束を思い出して",
        sceneTail: "灯台の鐘が鳴った。",
        language: "ja",
        localInferenceExpected: true,
      },
    });

    expect(chunks.map((chunk) => chunk.sceneId)).toEqual(["first", "second"]);
    expect(rerankerMocks.scheduleShadow).toHaveBeenCalledOnce();
    expect(rerankerMocks.apply).not.toHaveBeenCalled();
  });
});
