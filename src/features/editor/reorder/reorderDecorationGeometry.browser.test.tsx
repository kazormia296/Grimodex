/**
 * 推敲リオーダー装飾の幾何 invariant（実 Chromium）。
 *
 * 契約: `.reorder-unit` 系の装飾はテキストの**前進幅を変えない**。
 * 文節モードは 1 段落に多数の unit 帯が付くため、装飾が padding などで
 * 幅を持つと、入れ替え直後の bunsetsu cache miss（テキスト完全一致キーの
 * ため swap でキー不一致になる）で帯が一旦消えて prefetch 後に戻る瞬間に、
 * unit 数 × padding 分の横方向リフローが起き「幅方向のちらつき」になる。
 *
 * ちらつきは「同じ span にクラスが付いたり消えたり」で起きるので、装飾の
 * 幾何影響を分離するため **同一 span 構造でクラス有無だけを比較**する。
 * happy-dom は実寸を計算しないため、実 Chromium で getBoundingClientRect gate。
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

const TEXT = "あいうえおかきくけこさしすせそ"; // 14 文字

function advance(pId: string, endId: string): number {
  const p = document
    .querySelector(`[data-testid='${pId}']`)!
    .getBoundingClientRect();
  const end = document
    .querySelector(`[data-testid='${endId}']`)!
    .getBoundingClientRect();
  return end.left - p.left;
}

/** [0,2,4,...] の 2 文字 chunk に分けた span 群 + 末尾マーカーを描く段落。 */
function chunkedParagraph(pId: string, endId: string, cls: string) {
  const chunks = [0, 2, 4, 6, 8, 10, 12];
  return (
    <p data-testid={pId} style={{ whiteSpace: "nowrap" }}>
      {chunks.map((i) => (
        <span key={i} className={cls}>
          {TEXT.slice(i, i + 2)}
        </span>
      ))}
      <span data-testid={endId}>|</span>
    </p>
  );
}

describe("reorder 装飾の幾何 invariant", () => {
  it("文節帯クラスの付与はテキスト前進幅を変えない（幅方向ちらつき防止）", () => {
    render(
      <div className="tiptap" style={{ width: "1200px" }}>
        {chunkedParagraph("plain", "plain-end", "")}
        {chunkedParagraph(
          "deco",
          "deco-end",
          "reorder-unit reorder-unit-bunsetsu reorder-unit-c0",
        )}
      </div>,
    );
    const plainAdvance = advance("plain", "plain-end");
    const decoAdvance = advance("deco", "deco-end");
    // padding-inline を持つと 7 unit × 2px ≒ 14px ずれる。中立なら ~0。
    expect(Math.abs(decoAdvance - plainAdvance)).toBeLessThan(1);
  });

  it("active/dragging リングの付与も前進幅を変えない", () => {
    render(
      <div className="tiptap" style={{ width: "1200px" }}>
        {chunkedParagraph("plain", "plain-end", "")}
        {chunkedParagraph(
          "deco",
          "deco-end",
          "reorder-unit reorder-unit-sentence reorder-unit-c0 reorder-unit-active reorder-unit-dragging",
        )}
      </div>,
    );
    const plainAdvance = advance("plain", "plain-end");
    const decoAdvance = advance("deco", "deco-end");
    expect(Math.abs(decoAdvance - plainAdvance)).toBeLessThan(1);
  });
});
