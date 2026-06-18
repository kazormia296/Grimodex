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
