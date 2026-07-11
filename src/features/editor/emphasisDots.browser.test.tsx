/**
 * 傍点（圏点）の CSS 契約（実 Chromium）。
 *
 * Chromium の native text-emphasis で sesame が描画されることと、旧来の
 * per-char 背景ドット用スタイルが残っていないことを gate する。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

function Fixture() {
  return (
    <div className="editor-vertical" style={{ height: 400, fontSize: 20 }}>
      <div className="tiptap">
        <p>
          前
          <span data-testid="mark-span" className="emphasis-dots">
            強調
          </span>
          後
        </p>
      </div>
    </div>
  );
}

describe("傍点の native text-emphasis 契約", () => {
  afterEach(cleanup);

  it("native sesame を維持し背景ドットを使わない", () => {
    render(<Fixture />);
    const markSpan = document.querySelector(
      "[data-testid='mark-span']",
    ) as HTMLElement;
    const cs = getComputedStyle(markSpan);
    expect(cs.textEmphasisStyle).toBe("sesame");
    expect(cs.textEmphasisPosition).toContain("over");
    expect(cs.backgroundImage).toBe("none");
    expect(cs.paddingRight).toBe("0px");
  });
});
