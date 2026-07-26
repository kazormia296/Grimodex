/**
 * 行番号・段落ガター種別アイコン × Alt ドラッグハンドルの排他表示
 * invariant（実 Chromium）。
 *
 * 契約: Alt 押下中（= ReorderInteractionExtension が最上位ブロックへ
 * `.reorder-block-anchor` を付けている間）は行番号 ::before と
 * `.gutter-marks__row` を隠す。いずれもハンドルと同じ inline-start ガター
 * 領域を使うため、同時に描くと重なる（index.css の排他規則が gate 対象）。
 *
 * happy-dom は擬似要素の computed style を解決しないため実 Chromium で検証。
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

function pseudoVisibility(testId: string): string {
  const el = document.querySelector(`[data-testid='${testId}']`)!;
  return getComputedStyle(el, "::before").visibility;
}

describe("行番号と reorder ハンドルの排他表示", () => {
  it("Alt 押下中(.reorder-block-anchor)のブロックだけ行番号を隠す", () => {
    render(
      <div className="editor-line-numbers">
        <div className="tiptap">
          <p data-testid="anchor-p" className="reorder-block-anchor">
            並べ替え対象の段落
          </p>
          <p data-testid="plain-p">通常の段落</p>
        </div>
      </div>,
    );
    // anchor 付き = ハンドル表示中 → 行番号は不可視
    expect(pseudoVisibility("anchor-p")).toBe("hidden");
    // anchor なし = 平常時 → 行番号は可視のまま
    expect(pseudoVisibility("plain-p")).toBe("visible");
  });

  it("visibility 方式なので行番号カウンタと幾何は変わらない", () => {
    render(
      <div className="editor-line-numbers">
        <div className="tiptap">
          <p data-testid="p1" className="reorder-block-anchor">
            一
          </p>
          <p data-testid="p2">二</p>
        </div>
      </div>,
    );
    const p1 = document.querySelector("[data-testid='p1']")!;
    const p2 = document.querySelector("[data-testid='p2']")!;
    // hidden でも counter-increment（ブロック要素側の規則）は継続する
    // （= p2 の番号は "2" のままで番号飛びが起きない）
    expect(getComputedStyle(p1).counterIncrement).toContain("editor-line");
    expect(getComputedStyle(p2).counterIncrement).toContain("editor-line");
    // ::before の content 自体も消さない（visibility 方式の確認）
    expect(getComputedStyle(p1, "::before").content).toContain("counter");
  });
});

describe("段落ガター種別アイコンと reorder ハンドルの排他表示", () => {
  it("Alt 押下中のブロックだけ種別アイコンを隠す", () => {
    render(
      <div className="tiptap">
        <p className="reorder-block-anchor">
          <span className="reorder-block-handle" aria-hidden="true" />
          <span className="gutter-marks">
            <span className="gutter-marks__row" data-testid="anchor-gutter-row">
              <span className="gutter-mark gutter-mark--comment" />
            </span>
          </span>
          並べ替え対象の段落
        </p>
        <p>
          <span className="gutter-marks">
            <span className="gutter-marks__row" data-testid="plain-gutter-row">
              <span className="gutter-mark gutter-mark--comment" />
            </span>
          </span>
          通常の段落
        </p>
      </div>,
    );

    expect(
      getComputedStyle(
        document.querySelector("[data-testid='anchor-gutter-row']")!,
      ).visibility,
    ).toBe("hidden");
    expect(
      getComputedStyle(
        document.querySelector("[data-testid='plain-gutter-row']")!,
      ).visibility,
    ).toBe("visible");
  });
});
