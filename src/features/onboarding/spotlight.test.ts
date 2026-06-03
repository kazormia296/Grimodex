// @vitest-environment happy-dom
//
// spotlight の純幾何関数を gate（onboarding はこれまでテストゼロ）。
// buildFocusClipPath は穴の SVG path を、boundingRect は AABB を組む純ロジックで、
// リテラル矩形で決定的に検証できる。useFocusRects の実 getBoundingClientRect 統合は
// 別層（実ブラウザ + laid-out fixture）だが、ROI 判定で defer（下部コメント参照）。
import { describe, it, expect } from "vitest";
import { buildFocusClipPath, boundingRect } from "./spotlight";

describe("buildFocusClipPath", () => {
  it("矩形が無ければ空文字", () => {
    expect(buildFocusClipPath([], 100, 200)).toBe("");
  });

  it("1矩形を even-odd の穴として外枠に開ける", () => {
    expect(
      buildFocusClipPath(
        [{ left: 10, top: 20, width: 30, height: 40 }],
        100,
        200,
      ),
    ).toBe("path(evenodd, 'M 0 0 H 100 V 200 H 0 Z M 10 20 H 40 V 60 H 10 Z')");
  });

  it("複数矩形は穴を連結する", () => {
    const s = buildFocusClipPath(
      [
        { left: 0, top: 0, width: 10, height: 10 },
        { left: 50, top: 50, width: 10, height: 10 },
      ],
      100,
      100,
    );
    expect(s).toContain("M 0 0 H 10 V 10 H 0 Z");
    expect(s).toContain("M 50 50 H 60 V 60 H 50 Z");
  });
});

describe("boundingRect", () => {
  it("空配列は null", () => {
    expect(boundingRect([])).toBeNull();
  });

  it("複数矩形の axis-aligned bounding box", () => {
    expect(
      boundingRect([
        { left: 0, top: 0, width: 10, height: 10 },
        { left: 20, top: 30, width: 10, height: 10 },
      ]),
    ).toEqual({ left: 0, top: 0, width: 30, height: 40 });
  });
});

// defer 記録: useFocusRects → SpotlightOverlay の「実 [data-tour-target] rect を測って
// clipPath に反映」する統合は実ブラウザ + sized fixture が要る。だが穴/配置の幾何は
// 上記 + cardPlacement.test で押さえ、残るのは querySelector + getBoundingClientRect の
// 薄い glue（初回限定 cosmetic・回帰履歴 3945498d は位置ずれだが pure 側で gate 済）。
// 薄い fixture は theater になりやすく ROI が低いため browser 統合テストは見送り。
