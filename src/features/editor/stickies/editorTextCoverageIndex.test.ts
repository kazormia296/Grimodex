// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectEditorTextCoverage,
  indexEditorTextCoverage,
  projectCoverageToCard,
} from "./editorTextCoverageIndex";

const originalGetClientRects = Range.prototype.getClientRects;

afterEach(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: originalGetClientRects,
  });
});

describe("editor text coverage", () => {
  it("collects non-whitespace text runs but excludes sticky content and layout whitespace", () => {
    const editorRoot = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.append("本文 末尾");
    editorRoot.append(paragraph);

    const sticky = document.createElement("div");
    sticky.dataset.editorStickyCard = "true";
    sticky.append("付箋本文");
    editorRoot.append(sticky);

    const rects = vi.fn(function (this: Range) {
      const text = this.toString();
      if (text === "本文" || text === "末尾") {
        return [
          { left: text === "本文" ? 10 : 40, top: 20, width: 20, height: 18 },
        ];
      }
      return [];
    });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: rects,
    });

    const coverage = collectEditorTextCoverage(editorRoot, {
      left: 0,
      top: 0,
    });

    expect(coverage).toEqual([
      { x: 9, y: 19, width: 22, height: 20 },
      { x: 39, y: 19, width: 22, height: 20 },
    ]);
    expect(rects).toHaveBeenCalledTimes(2);
  });

  it("clips coverage to one sticky's local paper without affecting neighboring cards", () => {
    expect(
      projectCoverageToCard(
        [
          { x: 20, y: 30, width: 30, height: 18 },
          { x: 140, y: 30, width: 30, height: 18 },
        ],
        { left: 40, top: 20, width: 80, height: 40 },
      ),
    ).toEqual([{ x: 0, y: 10, width: 10, height: 18 }]);
  });

  it("keeps ruby, tate-chu-yoko, and non-whitespace runs in the mask", () => {
    const editorRoot = document.createElement("div");
    editorRoot.innerHTML =
      '<p><ruby><rb>漢字</rb><rt>かんじ</rt></ruby><span style="text-combine-upright: all">12</span> 本文   </p>';
    const measuredTexts: string[] = [];
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: function (this: Range) {
        const text = this.toString();
        measuredTexts.push(text);
        return [
          {
            left: measuredTexts.length * 20,
            top: 30,
            width: 16,
            height: 18,
          },
        ];
      },
    });

    const coverage = collectEditorTextCoverage(editorRoot, {
      left: 0,
      top: 0,
    });

    expect(measuredTexts).toEqual(["漢字", "かんじ", "12", "本文"]);
    expect(coverage).toHaveLength(4);
  });

  it("indexes long-document coverage and only projects nearby tiles", () => {
    const near = { x: 10, y: 10, width: 20, height: 20 };
    const far = { x: 2_000, y: 10, width: 20, height: 20 };
    const index = indexEditorTextCoverage([near, far], 100);

    expect(index.rects).toEqual([near, far]);
    expect(
      projectCoverageToCard(index, {
        left: 0,
        top: 0,
        width: 50,
        height: 50,
      }),
    ).toEqual([{ x: 10, y: 10, width: 20, height: 20 }]);
  });
});
