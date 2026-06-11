/**
 * 縦書きライブ編集 MODE の幾何 invariant（実 Chromium）。
 * happy-dom は writing-mode のレイアウト解決・スクロール軸・論理プロパティの
 * 物理マップを計算しないため、ここで gate する。
 *
 * 検証対象の契約:
 * - .editor-vertical（スクロールコンテナ）の writing-mode が .tiptap まで継承
 * - buildEditorContentStyle の論理プロパティが縦書きで「行長キャップ=物理高さ」
 *   「ブロック軸あふれ=横スクロール」に解決される
 * - Chromium の vertical-rl scrollLeft 符号規約（0 起点・負方向）=
 *   get/setLogicalScrollOffset の前提 canary
 * - node-island（scene-beat / scene-break / generated-prose-block / table）の
 *   horizontal-tb リセットと寸法潰れ検知
 * - 行番号ガター padding-inline-start の軸マップ
 */
import { describe, it, expect } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { RubyNode } from "./RubyNode";
import {
  buildEditorContentStyle,
  getLogicalScrollOffset,
  setLogicalScrollOffset,
} from "./editorLayout";

const CONTENT_SETTINGS = {
  fontFamily: "serif",
  fontSize: 16,
  lineHeight: 2,
  maxContentWidth: 720,
  wordBreak: "normal",
  lineBreak: "strict",
  paragraphIndent: 0,
};

const LONG_TEXT = "長い本文のテスト行。".repeat(20);
const MANY_PARAGRAPHS = Array.from(
  { length: 40 },
  (_, i) => `<p>${i}: ${LONG_TEXT}</p>`,
).join("");

function EditorFixture({
  vertical,
  content,
  containerStyle,
}: {
  vertical: boolean;
  content: string;
  containerStyle: React.CSSProperties;
}) {
  const editor = useEditor({
    extensions: [StarterKit, RubyNode],
    content,
  });
  return (
    <div
      data-testid="scroll-container"
      className={`overflow-auto p-4${vertical ? " editor-vertical" : ""}`}
      style={containerStyle}
    >
      <div
        data-testid="content-wrapper"
        style={buildEditorContentStyle(CONTENT_SETTINGS)}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

async function waitForEditable(): Promise<HTMLElement> {
  return await waitFor(() => {
    const el = document.querySelector(
      "[contenteditable='true']",
    ) as HTMLElement | null;
    expect(el).toBeTruthy();
    expect(el!.textContent?.length ?? 0).toBeGreaterThan(0);
    return el!;
  });
}

describe("縦書きMODE: writing-mode の継承", () => {
  it("editor-vertical 配下の contenteditable が vertical-rl になる", async () => {
    render(
      <EditorFixture
        vertical
        content="<p>縦書きテスト</p>"
        containerStyle={{ width: 600, height: 400 }}
      />,
    );
    const editable = await waitForEditable();
    expect(getComputedStyle(editable).writingMode).toBe("vertical-rl");
    expect(getComputedStyle(editable).textOrientation).toBe("mixed");
  });

  it("横書き（クラス無し）では horizontal-tb のまま", async () => {
    render(
      <EditorFixture
        vertical={false}
        content="<p>横書きテスト</p>"
        containerStyle={{ width: 600, height: 400 }}
      />,
    );
    const editable = await waitForEditable();
    expect(getComputedStyle(editable).writingMode).toBe("horizontal-tb");
  });
});

describe("縦書きMODE: 行長制限の軸", () => {
  it("縦書きでは maxInlineSize が物理高さをキャップし、あふれは横スクロールになる", async () => {
    render(
      <EditorFixture
        vertical
        content={MANY_PARAGRAPHS}
        containerStyle={{ width: 600, height: 900 }}
      />,
    );
    await waitForEditable();
    const container = document.querySelector(
      "[data-testid='scroll-container']",
    ) as HTMLElement;
    const wrapper = document.querySelector(
      "[data-testid='content-wrapper']",
    ) as HTMLElement;
    await waitFor(() => {
      // 行長 = inline-size = 物理 height が 720px 以下にキャップされる
      expect(wrapper.getBoundingClientRect().height).toBeLessThanOrEqual(721);
      expect(wrapper.getBoundingClientRect().height).toBeGreaterThan(600);
      // 段落の積層（ブロック軸）は横方向 → 横スクロールが発生し縦は発生しない
      expect(container.scrollWidth).toBeGreaterThan(container.clientWidth);
      expect(container.scrollHeight).toBeLessThanOrEqual(
        container.clientHeight,
      );
    });
  });

  it("横書きでは従来どおり幅をキャップする（回帰）", async () => {
    render(
      <EditorFixture
        vertical={false}
        content={MANY_PARAGRAPHS}
        containerStyle={{ width: 900, height: 400 }}
      />,
    );
    await waitForEditable();
    const container = document.querySelector(
      "[data-testid='scroll-container']",
    ) as HTMLElement;
    const wrapper = document.querySelector(
      "[data-testid='content-wrapper']",
    ) as HTMLElement;
    await waitFor(() => {
      expect(wrapper.getBoundingClientRect().width).toBeLessThanOrEqual(721);
      expect(wrapper.getBoundingClientRect().width).toBeGreaterThan(600);
      expect(container.scrollHeight).toBeGreaterThan(container.clientHeight);
    });
  });
});

describe("縦書きMODE: スクロール軸と Chromium 符号規約 (canary)", () => {
  it("vertical-rl コンテナは scrollLeft=0 起点・負方向で、論理ヘルパが往復する", async () => {
    render(
      <EditorFixture
        vertical
        content={MANY_PARAGRAPHS}
        containerStyle={{ width: 600, height: 400 }}
      />,
    );
    await waitForEditable();
    const container = document.querySelector(
      "[data-testid='scroll-container']",
    ) as HTMLElement;
    await waitFor(() => {
      expect(container.scrollWidth).toBeGreaterThan(container.clientWidth);
    });
    // 初期位置 = 先頭（右端）= scrollLeft 0
    expect(container.scrollLeft).toBe(0);
    // 論理オフセット 100 = scrollLeft -100（この前提が崩れたら
    // editorLayout.get/setLogicalScrollOffset の符号処理を見直すこと）
    setLogicalScrollOffset(container, 100, true);
    expect(container.scrollLeft).toBe(-100);
    expect(getLogicalScrollOffset(container, true)).toBe(100);
  });
});

describe("縦書きMODE: ルビ", () => {
  it("ruby atom が縦の行内に描画され rt が縮小される", async () => {
    render(
      <EditorFixture
        vertical
        content='<p>これは<ruby data-base="漢字" data-annotation="かんじ"></ruby>のテスト</p>'
        containerStyle={{ width: 600, height: 600 }}
      />,
    );
    await waitForEditable();
    const atom = await waitFor(() => {
      const el = document.querySelector(".ruby-atom") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    const rect = atom.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    // 行（縦の列）の中に収まっている
    const paragraph = atom.closest("p")!;
    const pRect = paragraph.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(pRect.top - 1);
    expect(rect.bottom).toBeLessThanOrEqual(pRect.bottom + 1);
    const rt = atom.querySelector("rt") as HTMLElement;
    // .editor-vertical .tiptap ruby rt { font-size: 0.5em } → 16px の半分
    expect(getComputedStyle(rt).fontSize).toBe("8px");
  });
});

describe("縦書きMODE: node-island の horizontal-tb リセット", () => {
  it("島は横書きを保ち、寸法が潰れない", () => {
    // CSS セレクタ → computed style の契約検証なので素の DOM で十分
    render(
      <div
        className="editor-vertical"
        style={{ width: 600, height: 400, overflow: "auto" }}
      >
        <div className="tiptap" style={{ blockSize: "100%" }}>
          <p>縦書き本文</p>
          <div data-type="scene-beat" data-testid="island-beat">
            ビート UI
          </div>
          <div className="scene-break" data-testid="island-break">
            ※ ※ ※
          </div>
          <div className="generated-prose-block" data-testid="island-prose">
            生成プローズ
          </div>
          <table data-testid="island-table">
            <tbody>
              <tr>
                <td>セル</td>
              </tr>
            </tbody>
          </table>
          <pre data-testid="island-pre">
            <code>const code = "horizontal";</code>
          </pre>
          <ul data-type="taskList" data-testid="island-tasklist">
            <li data-testid="island-taskitem">
              <label aria-label="タスク完了">
                <input type="checkbox" />
              </label>
              <div>タスク本文</div>
            </li>
          </ul>
        </div>
      </div>,
    );
    for (const id of [
      "island-beat",
      "island-break",
      "island-prose",
      "island-table",
      "island-pre",
      "island-tasklist",
      // li は ul からの継承でリセットされる (nested taskList も同様)
      "island-taskitem",
    ]) {
      const el = document.querySelector(`[data-testid='${id}']`) as HTMLElement;
      expect(getComputedStyle(el).writingMode, `${id} writing-mode`).toBe(
        "horizontal-tb",
      );
      const rect = el.getBoundingClientRect();
      expect(rect.width, `${id} width`).toBeGreaterThan(0);
      expect(rect.height, `${id} height`).toBeGreaterThan(0);
    }
    // taskList li の flex 軸が水平に戻る (checkbox と本文が横並び)
    const label = document.querySelector(
      "[data-testid='island-taskitem'] > label",
    ) as HTMLElement;
    const body = document.querySelector(
      "[data-testid='island-taskitem'] > div",
    ) as HTMLElement;
    expect(label.getBoundingClientRect().left).toBeLessThan(
      body.getBoundingClientRect().left,
    );
    expect(
      Math.abs(
        label.getBoundingClientRect().top - body.getBoundingClientRect().top,
      ),
    ).toBeLessThan(label.getBoundingClientRect().height + 1);
  });
});

describe("縦書きMODE: 行番号ガターの軸マップ", () => {
  it("padding-inline-start が縦書きでは物理 padding-top に解決される", () => {
    render(
      <div data-testid="root" style={{ fontSize: 16 }}>
        <div className="editor-vertical" style={{ width: 400, height: 400 }}>
          <div className="editor-line-numbers" data-testid="gutter-v">
            <div className="tiptap">
              <p>縦書き</p>
            </div>
          </div>
        </div>
        <div style={{ width: 400 }}>
          <div className="editor-line-numbers" data-testid="gutter-h">
            <div className="tiptap">
              <p>横書き</p>
            </div>
          </div>
        </div>
      </div>,
    );
    const v = document.querySelector("[data-testid='gutter-v']") as HTMLElement;
    const h = document.querySelector("[data-testid='gutter-h']") as HTMLElement;
    // 2.5em × 16px = 40px が縦では top、横では left に確保される
    expect(getComputedStyle(v).paddingTop).toBe("40px");
    expect(getComputedStyle(v).paddingLeft).toBe("0px");
    expect(getComputedStyle(h).paddingLeft).toBe("40px");
    expect(getComputedStyle(h).paddingTop).toBe("0px");
  });
});
