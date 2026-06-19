import { describe, it, expect } from "vitest";
import type { SemanticSearchHit } from "@/features/semantic-search/api";
import { selectRelatedPastScenes } from "./selectRelatedScenes";

/** テスト用 SemanticSearchHit を簡潔に作るヘルパ。 */
function hit(
  sceneId: string,
  score: number,
  chunkText = `chunk-${sceneId}`,
  sceneTitle = `title-${sceneId}`,
  charStart = 0,
): SemanticSearchHit {
  return {
    sceneId,
    sceneTitle,
    chunkText,
    charStart,
    charEnd: charStart + chunkText.length,
    score,
    dialogueRatio: 0,
  };
}

/** 読書順 map を配列から作る (index = 読書順)。 */
function order(...sceneIds: string[]): Map<string, number> {
  return new Map(sceneIds.map((id, i) => [id, i]));
}

const BASE = { minScore: 0.8, maxScenes: 8 };

describe("selectRelatedPastScenes", () => {
  it("現在シーンより読書順で前のシーンだけを、スコア降順で返す", () => {
    const hits = [hit("s1", 0.9), hit("s2", 0.95), hit("s4", 0.92)];
    // 読書順: s1 < s2 < s3(current) < s4
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "s3",
      sceneOrder: order("s1", "s2", "s3", "s4"),
      ...BASE,
    });
    // s4 は未読 (current より後) なので除外。s2 > s1。
    expect(result.map((r) => r.sceneId)).toEqual(["s2", "s1"]);
    expect(result[0].score).toBe(0.95);
  });

  it("現在シーン自身のヒットは除外する", () => {
    const hits = [hit("s1", 0.9), hit("s2", 0.99)];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "s2",
      sceneOrder: order("s1", "s2"),
      ...BASE,
    });
    expect(result.map((r) => r.sceneId)).toEqual(["s1"]);
  });

  it("読書順で現在より後 (未読) のシーンは除外する", () => {
    const hits = [hit("s3", 0.99), hit("s1", 0.85)];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "s2",
      sceneOrder: order("s1", "s2", "s3"),
      ...BASE,
    });
    expect(result.map((r) => r.sceneId)).toEqual(["s1"]);
  });

  it("読書順 map に無いシーン (folder/削除済) は除外する", () => {
    const hits = [hit("orphan", 0.99), hit("s1", 0.85)];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "s2",
      sceneOrder: order("s1", "s2"),
      ...BASE,
    });
    expect(result.map((r) => r.sceneId)).toEqual(["s1"]);
  });

  it("床 (minScore) 未満のスコアは除外する", () => {
    const hits = [hit("s1", 0.79), hit("s0", 0.81)];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "s2",
      sceneOrder: order("s0", "s1", "s2"),
      minScore: 0.8,
      maxScenes: 8,
    });
    expect(result.map((r) => r.sceneId)).toEqual(["s0"]);
  });

  it("同一シーンの複数チャンクは最良スコアのものに集約する", () => {
    const hits = [
      hit("s1", 0.82, "weak chunk"),
      hit("s1", 0.93, "strong chunk"),
    ];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "s2",
      sceneOrder: order("s1", "s2"),
      ...BASE,
    });
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.93);
    expect(result[0].chunkText).toBe("strong chunk");
  });

  it("maxScenes で件数を上限まで切り詰める", () => {
    const hits = [
      hit("s0", 0.9),
      hit("s1", 0.91),
      hit("s2", 0.92),
      hit("s3", 0.93),
    ];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "scur",
      sceneOrder: order("s0", "s1", "s2", "s3", "scur"),
      minScore: 0.8,
      maxScenes: 2,
    });
    // 上位 2 件 (s3, s2)
    expect(result.map((r) => r.sceneId)).toEqual(["s3", "s2"]);
  });

  it("currentSceneId が null/空 のときは空配列 (過去を定義できない)", () => {
    const hits = [hit("s1", 0.99)];
    expect(
      selectRelatedPastScenes(hits, {
        currentSceneId: null,
        sceneOrder: order("s1"),
        ...BASE,
      }),
    ).toEqual([]);
    expect(
      selectRelatedPastScenes(hits, {
        currentSceneId: "",
        sceneOrder: order("s1"),
        ...BASE,
      }),
    ).toEqual([]);
  });

  it("currentSceneId が読書順 map に無いときは空配列", () => {
    const hits = [hit("s1", 0.99)];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "ghost",
      sceneOrder: order("s1", "s2"),
      ...BASE,
    });
    expect(result).toEqual([]);
  });

  it("非有限スコア (NaN/Infinity) は床比較をすり抜けず除外する", () => {
    const hits = [hit("s0", NaN), hit("s1", Infinity), hit("s2", 0.9)];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "scur",
      sceneOrder: order("s0", "s1", "s2", "scur"),
      minScore: 0.8,
      maxScenes: 8,
    });
    expect(result.map((r) => r.sceneId)).toEqual(["s2"]);
    expect(Number.isFinite(result[0].score)).toBe(true);
  });

  it("maxScenes が 0 / 負 のときは空配列 (slice の負数挙動に落ちない)", () => {
    const hits = [hit("s0", 0.9), hit("s1", 0.91)];
    const sceneOrder = order("s0", "s1", "scur");
    expect(
      selectRelatedPastScenes(hits, {
        currentSceneId: "scur",
        sceneOrder,
        minScore: 0.8,
        maxScenes: 0,
      }),
    ).toEqual([]);
    expect(
      selectRelatedPastScenes(hits, {
        currentSceneId: "scur",
        sceneOrder,
        minScore: 0.8,
        maxScenes: -1,
      }),
    ).toEqual([]);
  });

  it("同一シーン同スコアの複数チャンクは charStart が小さい方を代表にする (決定的)", () => {
    // 入力順を入れ替えても結果が変わらないこと。
    const a = hit("s1", 0.9, "後半チャンク", "title-s1", 500);
    const b = hit("s1", 0.9, "前半チャンク", "title-s1", 10);
    const expectChunk = "前半チャンク";
    for (const hits of [
      [a, b],
      [b, a],
    ]) {
      const result = selectRelatedPastScenes(hits, {
        currentSceneId: "s2",
        sceneOrder: order("s1", "s2"),
        ...BASE,
      });
      expect(result).toHaveLength(1);
      expect(result[0].chunkText).toBe(expectChunk);
    }
  });

  it("同点スコアは sceneId で安定ソートして決定的にする", () => {
    const hits = [hit("sb", 0.9), hit("sa", 0.9)];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "scur",
      sceneOrder: order("sa", "sb", "scur"),
      ...BASE,
    });
    expect(result.map((r) => r.sceneId)).toEqual(["sa", "sb"]);
  });
});

describe("selectRelatedPastScenes — hybrid (sparse 救済 + RRF 融合)", () => {
  // minScore=0.8, rescueMargin=0.05 → rescueFloor=0.75。
  const HY = { minScore: 0.8, maxScenes: 8, rescueMargin: 0.05 };

  it("sparse top-N の『床ぎりぎり下』シーンを救済し、非 sparse の同帯は除外する", () => {
    // s1/s2 とも cosine は [rescueFloor, floor) 帯。dense 単独なら両方落ちる。
    const hits = [hit("s1", 0.78), hit("s2", 0.77)];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "scur",
      sceneOrder: order("s1", "s2", "scur"),
      sparseSceneIds: ["s1"],
      ...HY,
    });
    expect(result.map((r) => r.sceneId)).toEqual(["s1"]);
  });

  it("RRF: 低 cosine でも sparse 上位なら高 cosine の非 sparse シーンを上回れる", () => {
    const hits = [hit("hi", 0.9), hit("lo", 0.82)]; // 両方 floor 以上
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "scur",
      sceneOrder: order("hi", "lo", "scur"),
      sparseSceneIds: ["lo"], // lo を sparse top-1 が後押し
      ...HY,
    });
    expect(result.map((r) => r.sceneId)).toEqual(["lo", "hi"]);
  });

  it("床以上のシーンは sparse 不一致でも残る (recall を削らない)", () => {
    const hits = [hit("hi", 0.9), hit("mid", 0.83)];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "scur",
      sceneOrder: order("hi", "mid", "scur"),
      sparseSceneIds: ["zzz"], // どの候補にも一致しない → hybrid 経路だが sparse 寄与ゼロ
      ...HY,
    });
    expect(result.map((r) => r.sceneId)).toEqual(["hi", "mid"]);
  });

  it("rescueFloor 未満は sparse 一致でも除外する", () => {
    const hits = [hit("s1", 0.74), hit("s2", 0.9)]; // s1 は rescueFloor(0.75) 未満
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "scur",
      sceneOrder: order("s1", "s2", "scur"),
      sparseSceneIds: ["s1", "s2"],
      ...HY,
    });
    expect(result.map((r) => r.sceneId)).toEqual(["s2"]);
  });

  it("sparse 救済も読書順/現在シーン/順序外の壁を越えられない", () => {
    const hits = [
      hit("future", 0.78), // 未読 (current より後)
      hit("orphan", 0.78), // 読書順 map 外
      hit("s1", 0.9), // 正当な過去シーン
    ];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "scur",
      sceneOrder: order("s1", "scur", "future"), // orphan は含めない
      sparseSceneIds: ["future", "orphan", "s1"],
      ...HY,
    });
    expect(result.map((r) => r.sceneId)).toEqual(["s1"]);
  });

  it("hybrid でも同一シーンの複数チャンクは最良スコアに集約する", () => {
    const hits = [
      hit("s1", 0.78, "weak"),
      hit("s1", 0.83, "strong"), // floor 以上
      hit("s2", 0.9, "s2chunk"),
    ];
    const result = selectRelatedPastScenes(hits, {
      currentSceneId: "scur",
      sceneOrder: order("s1", "s2", "scur"),
      sparseSceneIds: ["s2"], // hybrid 経路を起動
      ...HY,
    });
    expect(result).toHaveLength(2);
    const s1 = result.find((r) => r.sceneId === "s1")!;
    expect(s1.chunkText).toBe("strong");
    expect(s1.score).toBe(0.83);
  });

  it("sparseSceneIds が空配列なら dense 単独と完全に同一 (後方互換)", () => {
    const hits = [hit("s1", 0.78), hit("s2", 0.9)]; // s1 は床未満
    const base = {
      currentSceneId: "scur",
      sceneOrder: order("s1", "s2", "scur"),
      minScore: 0.8,
      maxScenes: 8,
    };
    const denseOnly = selectRelatedPastScenes(hits, base);
    const emptyHybrid = selectRelatedPastScenes(hits, {
      ...base,
      sparseSceneIds: [],
      rescueMargin: 0.05,
    });
    expect(emptyHybrid).toEqual(denseOnly);
    expect(denseOnly.map((r) => r.sceneId)).toEqual(["s2"]); // s1 は床未満で出ない
  });
});
