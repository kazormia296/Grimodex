import { describe, it, expect } from "vitest";
import { computeAxisLabels } from "./timelineLabels";
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
