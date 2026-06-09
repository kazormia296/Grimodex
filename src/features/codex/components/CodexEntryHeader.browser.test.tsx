/**
 * 実 Chromium で動かす Codex 名前フィールドの幾何 invariant テスト。
 *
 * happy-dom はテキストの実寸を計算しないため、「名前が長いとフォントを縮小し、
 * 下限を割ると折り返す」挙動は単体テストでは捕まらない。ここでは
 * CodexEntryHeader が名前 <textarea> に組む構造 (container + BASE サイズの
 * hidden measure span + auto-grow textarea + useFitFontSize) を忠実に再現し、
 * 実ブラウザで 3 tier を `getComputedStyle` / `scrollHeight` で検証する。
 *
 * 完全な CodexEntryHeader は TagSelector / Avatar / store / i18n を引き込み、
 * フォント幾何の gate としてはノイズが大きいため、機構そのものを harness で
 * 直接 gate する (plan のフォールバック方針)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { useFitFontSize } from "@/hooks/useFitFontSize";
import { useAutoGrowHeight } from "@/hooks/useAutoGrowHeight";

const BASE = 50;
const MIN = 24;
const PAD = 14; // px-1.5 (6px×2) + border-transparent (1px×2)

function Harness({ name, width }: { name: string; width: number }) {
  const nameRef = useRef<HTMLTextAreaElement>(null);
  const { containerRef, measureRef, fontSize } = useFitFontSize({
    baseSizePx: BASE,
    minSizePx: MIN,
    horizontalPaddingPx: PAD,
  });
  useAutoGrowHeight(nameRef, `${name}|${fontSize}`);

  return (
    <div style={{ width: `${width}px` }}>
      <div ref={containerRef} style={{ position: "relative", minWidth: 0 }}>
        <span
          ref={measureRef}
          data-testid="measure"
          aria-hidden="true"
          style={{
            position: "absolute",
            visibility: "hidden",
            whiteSpace: "nowrap",
            width: "max-content",
            fontSize: `${BASE}px`,
            letterSpacing: "0.05em",
          }}
        >
          {name}
        </span>
        <textarea
          ref={nameRef}
          data-testid="name"
          rows={1}
          value={name}
          readOnly
          style={{
            display: "block",
            width: "100%",
            boxSizing: "border-box",
            resize: "none",
            overflow: "hidden",
            padding: "0 6px",
            border: "1px solid transparent",
            lineHeight: 1.1,
            letterSpacing: "0.05em",
            fontSize: `${fontSize}px`,
          }}
        />
      </div>
    </div>
  );
}

const px = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
const lines = (el: HTMLElement) => Math.round(el.scrollHeight / (px(el) * 1.1));

const LONG = "とても長い登場人物のフルネーム・ヴァーミリオン";

afterEach(() => cleanup());

describe("Codex 名前フィールドの自動フィット幾何", () => {
  it("要件1: パネル幅が十分なら縮小せず BASE・単一行", async () => {
    await document.fonts.ready;
    render(<Harness name={LONG} width={4000} />);
    const ta = screen.getByTestId("name") as HTMLTextAreaElement;
    await waitFor(() => expect(px(ta)).toBe(BASE));
    expect(lines(ta)).toBe(1);
  });

  it("要件2: はみ出すと縮小し MIN<size<BASE で単一行に収める", async () => {
    await document.fonts.ready;
    // まず広い幅で BASE 時の自然幅を測る。
    const { rerender } = render(<Harness name={LONG} width={4000} />);
    const ta = screen.getByTestId("name") as HTMLTextAreaElement;
    const measure = screen.getByTestId("measure");
    await waitFor(() => expect(px(ta)).toBe(BASE));
    const measureWidth = measure.getBoundingClientRect().width;

    // scaled ≈ BASE/1.6 ≈ 31 (MIN<…<BASE) になる中間幅を選ぶ。
    const medWidth = Math.round(measureWidth / 1.6) + PAD;
    rerender(<Harness name={LONG} width={medWidth} />);
    await waitFor(() => {
      const s = px(ta);
      expect(s).toBeGreaterThan(MIN);
      expect(s).toBeLessThan(BASE);
    });
    // 縮小サイズでちょうど 1 行に収まる (折り返していない)。
    expect(lines(ta)).toBe(1);
  });

  it("要件3: 下限を割る幅では MIN にクランプし複数行に折り返す", async () => {
    await document.fonts.ready;
    render(<Harness name={LONG} width={120} />);
    const ta = screen.getByTestId("name") as HTMLTextAreaElement;
    await waitFor(() => expect(px(ta)).toBe(MIN));
    expect(lines(ta)).toBeGreaterThanOrEqual(2);
  });

  // 回帰: フォントが下限 (MIN) に張り付いた状態で「さらに幅を狭める」と、fontSize は
  // 変化しないため auto-grow の [name, fontSize] deps では高さが再計算されず、
  // 増えた折り返し行が overflow-hidden でクリップされる (= 直接狭めると折り返さない
  // ように見える)。可視ボックス clientHeight が内容 scrollHeight に追従することを
  // gate する。scrollHeight は常に全内容高を返すので clip 検出には使えない点に注意。
  it("回帰: 下限フォントで幅をさらに狭めても折り返し全文がクリップされない", async () => {
    await document.fonts.ready;
    // width 150 / 90 のどちらでも font は MIN に張り付く (= fontSize は不変、幅だけ変化)。
    const { rerender } = render(<Harness name={LONG} width={150} />);
    const ta = screen.getByTestId("name") as HTMLTextAreaElement;
    await waitFor(() => expect(px(ta)).toBe(MIN));

    rerender(<Harness name={LONG} width={90} />);
    await waitFor(() => {
      expect(px(ta)).toBe(MIN); // font 据え置きを確認
      // 可視ボックスが内容に追従 = クリップ無し (border-box の ~2px 誤差のみ許容)。
      expect(ta.scrollHeight - ta.clientHeight).toBeLessThan(MIN * 1.1);
    });
  });
});
