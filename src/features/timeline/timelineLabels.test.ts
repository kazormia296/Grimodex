import { describe, it, expect } from "vitest";
import { computeAxisLabels, computeFolderGroups } from "./timelineLabels";
import type { AxisLabelInput } from "./timelineLabels";

function makeScene(overrides: Partial<AxisLabelInput> = {}): AxisLabelInput {
  return {
    storyTimeLabel: null,
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("computeAxisLabels", () => {
  // ---------------------------------------------------------------------------
  // story モード
  // ---------------------------------------------------------------------------
  describe("story モード", () => {
    it("storyTimeLabel がある場合はそのラベルを使う", () => {
      const scenes = [
        makeScene({ storyTimeLabel: "帝国暦1000年" }),
        makeScene({ storyTimeLabel: "帝国暦1001年" }),
      ];
      const labels = computeAxisLabels(scenes, "story", 1);
      expect(labels[0].label).toBe("帝国暦1000年");
      expect(labels[1].label).toBe("帝国暦1001年");
    });

    it("storyTimeLabel がない場合は T{N} (1始まり) を使う", () => {
      const scenes = [makeScene(), makeScene(), makeScene()];
      const labels = computeAxisLabels(scenes, "story", 1);
      expect(labels[0].label).toBe("T1");
      expect(labels[1].label).toBe("T2");
      expect(labels[2].label).toBe("T3");
    });

    it("storyTimeLabel が一部だけある場合は混在する", () => {
      const scenes = [
        makeScene({ storyTimeLabel: "序章" }),
        makeScene({ storyTimeLabel: null }),
        makeScene({ storyTimeLabel: "終章" }),
      ];
      const labels = computeAxisLabels(scenes, "story", 1);
      expect(labels[0].label).toBe("序章");
      expect(labels[1].label).toBe("T2");
      expect(labels[2].label).toBe("終章");
    });
  });

  // ---------------------------------------------------------------------------
  // reading モード
  // ---------------------------------------------------------------------------
  describe("reading モード", () => {
    it("各シーンに Ch.{N} (1始まり) ラベルを付ける", () => {
      const scenes = [makeScene(), makeScene(), makeScene()];
      const labels = computeAxisLabels(scenes, "reading", 1);
      expect(labels[0].label).toBe("Ch.1");
      expect(labels[1].label).toBe("Ch.2");
      expect(labels[2].label).toBe("Ch.3");
    });
  });

  // ---------------------------------------------------------------------------
  // write モード
  // ---------------------------------------------------------------------------
  describe("write モード", () => {
    it("createdAt を YYYY/M/D 形式でフォーマットする", () => {
      const scenes = [makeScene({ createdAt: "2026-03-15T00:00:00Z" })];
      const labels = computeAxisLabels(scenes, "write", 1);
      expect(labels[0].label).toMatch(/2026/);
    });

    it("createdAt が ISO 形式でなくても安全に処理する", () => {
      const scenes = [makeScene({ createdAt: "invalid-date" })];
      // エラーを投げず、何らかの文字列を返す
      expect(() => computeAxisLabels(scenes, "write", 1)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 間引きロジック（thinning）
  // ---------------------------------------------------------------------------
  describe("間引きロジック", () => {
    it("シーンが少ない(<= 10)場合はすべてのラベルを返す", () => {
      const scenes = Array.from({ length: 5 }, () => makeScene());
      const labels = computeAxisLabels(scenes, "reading", 1);
      expect(labels.length).toBe(5);
      labels.forEach((l, i) => expect(l.index).toBe(i));
    });

    it("シーンが多い場合(>= 20)は間引いて返す", () => {
      const scenes = Array.from({ length: 30 }, () => makeScene());
      const labels = computeAxisLabels(scenes, "reading", 1);
      expect(labels.length).toBeLessThan(30);
      // 最初のラベルは常に index=0
      expect(labels[0].index).toBe(0);
    });

    it("zoom が大きい(>=2)場合は間引きが緩やかになる", () => {
      const scenes = Array.from({ length: 30 }, () => makeScene());
      const labelsZoom1 = computeAxisLabels(scenes, "reading", 1);
      const labelsZoom2 = computeAxisLabels(scenes, "reading", 2);
      // 拡大時の方がラベル数が多い(または同じ)
      expect(labelsZoom2.length).toBeGreaterThanOrEqual(labelsZoom1.length);
    });

    it("空配列を渡すと空配列を返す", () => {
      const labels = computeAxisLabels([], "story", 1);
      expect(labels).toEqual([]);
    });

    it("index が昇順であること", () => {
      const scenes = Array.from({ length: 20 }, () => makeScene());
      const labels = computeAxisLabels(scenes, "reading", 1);
      for (let i = 1; i < labels.length; i++) {
        expect(labels[i].index).toBeGreaterThan(labels[i - 1].index);
      }
    });
  });
});

describe("computeFolderGroups", () => {
  // 部P > 章A {s1,s2}, 章B {s3} / 部Q > 章C {s4}
  const anc: Record<string, { id: string; label: string }[]> = {
    s1: [
      { id: "P", label: "部P" },
      { id: "A", label: "章A" },
    ],
    s2: [
      { id: "P", label: "部P" },
      { id: "A", label: "章A" },
    ],
    s3: [
      { id: "P", label: "部P" },
      { id: "B", label: "章B" },
    ],
    s4: [
      { id: "Q", label: "部Q" },
      { id: "C", label: "章C" },
    ],
  };
  const ancestorsOf = (id: string) => anc[id] ?? [];

  it("level0=部 / level1=章 の連続レンジにまとめる", () => {
    const levels = computeFolderGroups(["s1", "s2", "s3", "s4"], ancestorsOf);
    expect(levels).toHaveLength(2);
    // 部: P が s1..s3、Q が s4
    expect(levels[0]).toEqual([
      { startIndex: 0, endIndex: 2, id: "P", label: "部P" },
      { startIndex: 3, endIndex: 3, id: "Q", label: "部Q" },
    ]);
    // 章: A=s1..s2, B=s3, C=s4
    expect(levels[1]).toEqual([
      { startIndex: 0, endIndex: 1, id: "A", label: "章A" },
      { startIndex: 2, endIndex: 2, id: "B", label: "章B" },
      { startIndex: 3, endIndex: 3, id: "C", label: "章C" },
    ]);
  });

  it("フォルダ直下（章なし）のシーンで章レベルが切れる", () => {
    const a2 = (id: string) =>
      id === "x" ? [{ id: "P", label: "部P" }] : (anc[id] ?? []);
    // s1(章A) → x(部直下) → s2(章A)。章レベルは x で切れ A が2区間。
    const levels = computeFolderGroups(["s1", "x", "s2"], a2);
    expect(levels[1]).toEqual([
      { startIndex: 0, endIndex: 0, id: "A", label: "章A" },
      { startIndex: 2, endIndex: 2, id: "A", label: "章A" },
    ]);
  });

  it("フォルダ未所属のみなら空", () => {
    expect(computeFolderGroups(["a", "b"], () => [])).toEqual([]);
  });
});
