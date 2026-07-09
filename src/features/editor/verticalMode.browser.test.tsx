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
 * - node-island（scene-break / table / pre / taskList）の
 *   horizontal-tb リセットと寸法潰れ検知
 * - generated-prose-block（Beat 生成の本編プロセ）は島ではなく vertical-rl 継承
 * - scene-beat（配置済み Beat）は島ではなく縦書きフローに参加する —
 *   wrapper が vertical-rl 継承・論理プロパティ（border-s / margin-block /
 *   beat-divider）の軸マップ・ポップオーバー（.beat-popover）の横書き維持
 * - 行番号ガター padding-inline-start の軸マップ
 */
import { describe, it, expect } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { RubyNode } from "./RubyNode";
import { SceneBeatNode } from "./SceneBeatNode";
import { GeneratedProseBlockNode } from "./GeneratedProseBlockNode";
import {
  createTateChuYokoPlugin,
  type TateChuYokoPolicy,
} from "./TateChuYokoPlugin";
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
  textAutospace: "normal",
  paragraphIndent: 0,
  paragraphSpacing: 8,
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
  it("島は横書きを保ち寸法が潰れない・生成プロセは縦書きを継承する", () => {
    // CSS セレクタ → computed style の契約検証なので素の DOM で十分
    render(
      <div
        className="editor-vertical"
        style={{ width: 600, height: 400, overflow: "auto" }}
      >
        <div className="tiptap" style={{ blockSize: "100%" }}>
          <p>縦書き本文</p>
          <div className="scene-break" data-testid="island-break">
            ※ ※ ※
          </div>
          <div className="generated-prose-block" data-testid="generated-prose">
            <p data-testid="generated-prose-p">生成プローズ（本編文章）</p>
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
      "island-break",
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
    // generated-prose-block は Beat 生成の本編プロセを包む永続ノードなので
    // 島リセットの対象外 — 親の vertical-rl を継承する（縦書きリニアで
    // AI 生成シーンだけ横書きで mount される回帰の gate）。
    for (const id of ["generated-prose", "generated-prose-p"]) {
      const el = document.querySelector(`[data-testid='${id}']`) as HTMLElement;
      expect(getComputedStyle(el).writingMode, `${id} writing-mode`).toBe(
        "vertical-rl",
      );
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

function BeatEditorFixture({ vertical }: { vertical: boolean }) {
  const editor = useEditor({
    extensions: [StarterKit, SceneBeatNode, GeneratedProseBlockNode],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "前の本文。" }] },
        {
          type: "sceneBeat",
          attrs: {
            id: "beat-v1",
            collapsed: false,
            beatType: "free",
            pov: null,
          },
          content: [{ type: "text", text: "ビートの構成意図テキスト" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "後の本文。" }] },
      ],
    },
  });
  return (
    <div
      data-testid="beat-scroll-container"
      className={`overflow-auto p-4${vertical ? " editor-vertical" : ""}`}
      style={{ width: 800, height: 500 }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}

async function waitForBeatNode(): Promise<HTMLElement> {
  return await waitFor(() => {
    const el = document.querySelector(
      '[data-type="scene-beat"]',
    ) as HTMLElement | null;
    expect(el).toBeTruthy();
    return el!;
  });
}

describe("縦書きMODE: Beat ノードの縦書き表示", () => {
  it("scene-beat は島ではなく vertical-rl を継承し、縦帯としてレイアウトされる", async () => {
    render(<BeatEditorFixture vertical />);
    const beat = await waitForBeatNode();
    const cs = getComputedStyle(beat);
    expect(cs.writingMode).toBe("vertical-rl");
    const rect = beat.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    // 縦帯: インライン軸（行長）が縦 → 高さがセクション積層幅より大きい
    expect(rect.height).toBeGreaterThan(rect.width);
    // border-s-4 のアクセントストライプが縦書きでは上端（inline-start）に解決
    expect(cs.borderTopWidth).toBe("4px");
    expect(cs.borderLeftWidth).toBe("0px");
    // margin-block がブロック軸（左右）に解決され、隣の本文列と分離される
    expect(cs.marginLeft).toBe("8px");
    expect(cs.marginRight).toBe("8px");
    expect(cs.marginTop).toBe("0px");
  });

  it("ヘッダー（block-start）が右端・フッター（block-end）が左端に並び、区切り線が右辺に解決される", async () => {
    render(<BeatEditorFixture vertical />);
    const beat = await waitForBeatNode();
    const header = beat.querySelector("header") as HTMLElement;
    const footer = beat.querySelector("footer") as HTMLElement;
    expect(header).toBeTruthy();
    expect(footer).toBeTruthy();
    // vertical-rl のブロック軸は右→左: header が footer より右に来る
    expect(header.getBoundingClientRect().left).toBeGreaterThan(
      footer.getBoundingClientRect().right - 1,
    );
    // beat-divider（border-block-start）は縦書きでは右辺ボーダーに解決
    const fcs = getComputedStyle(footer);
    expect(fcs.borderRightWidth).toBe("1px");
    expect(fcs.borderTopWidth).toBe("0px");
  });

  it("ポップオーバーは横書きのままトリガーの左（block-end）側に開く", async () => {
    render(<BeatEditorFixture vertical />);
    const beat = await waitForBeatNode();
    const chip = beat.querySelector(
      '[data-testid="beat-type-chip"]',
    ) as HTMLElement;
    fireEvent.click(chip);
    const menu = await waitFor(() => {
      // 8141a19a 以降ポップオーバーは AnimatedDropdown で document.body へ portal
      // されるため beat の内側ではなく document から取得する。
      const el = document.querySelector(".beat-popover") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(getComputedStyle(menu).writingMode).toBe("horizontal-tb");
    const menuRect = menu.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    // トリガーの左側に展開（block-end 方向 = まだ読んでいない側）
    expect(menuRect.right).toBeLessThanOrEqual(chipRect.left + 1);
    // min-w が潰れない（縦帯の極小 containing block でも実用幅を保つ）
    expect(menuRect.width).toBeGreaterThanOrEqual(119);
  });

  it("横書きでは従来どおり（回帰）: horizontal-tb・ストライプ左辺・メニューは下に開く", async () => {
    render(<BeatEditorFixture vertical={false} />);
    const beat = await waitForBeatNode();
    const cs = getComputedStyle(beat);
    expect(cs.writingMode).toBe("horizontal-tb");
    expect(cs.borderLeftWidth).toBe("4px");
    expect(cs.borderTopWidth).toBe("0px");
    expect(cs.marginTop).toBe("8px");
    expect(cs.marginBottom).toBe("8px");
    expect(cs.marginLeft).toBe("0px");
    const chip = beat.querySelector(
      '[data-testid="beat-type-chip"]',
    ) as HTMLElement;
    fireEvent.click(chip);
    const menu = await waitFor(() => {
      // 8141a19a 以降ポップオーバーは AnimatedDropdown で document.body へ portal
      // されるため beat の内側ではなく document から取得する。
      const el = document.querySelector(".beat-popover") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    const chipRect = chip.getBoundingClientRect();
    // トリガー直下(block-start)に開く。入場アニメ(y:-4→0)の落ち着き後の最終位置で
    // 測る（誤った placement なら settle しても満たさず timeout で fail する）。
    // 基準は chip の実測 bottom（固定 px はフォントメトリクス差で WebKit CI が
    // サブピクセル割れする）。-1 は subpixel 丸めの許容。
    await waitFor(() => {
      expect(menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        chipRect.bottom - 1,
      );
    });
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

// 縦中横（tate-chu-yoko）: 半角数字 run を正立結合する .tcy decoration の
// CSS 解決を実 Chromium で gate する。decoration の範囲計算は
// TateChuYokoPlugin.test.ts（happy-dom）が検証済み。ここで gate するのは
// (1) plugin → DOM の span 出力 (2) .editor-vertical スコープでの
// text-combine-upright: all 解決 (3) 横書きでは効かない（スコープ漏れ防止）。
function tcyTestExtension(policy: TateChuYokoPolicy) {
  return Extension.create({
    name: "tcyTest",
    addProseMirrorPlugins() {
      return [createTateChuYokoPlugin(policy)];
    },
  });
}

function TcyFixture({
  vertical,
  content,
  policy,
}: {
  vertical: boolean;
  content: string;
  policy: TateChuYokoPolicy;
}) {
  const editor = useEditor({
    extensions: [StarterKit, tcyTestExtension(policy)],
    content,
  });
  return (
    <div
      data-testid="scroll-container"
      className={`overflow-auto p-4${vertical ? " editor-vertical" : ""}`}
      style={{ width: 400, height: 300 }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}

describe("縦書きMODE: 縦中横 (tate-chu-yoko)", () => {
  it("縦書きで 2桁数字が .tcy span に包まれ text-combine-upright: all に解決", async () => {
    const { container } = render(
      <TcyFixture vertical content="<p>第12話</p>" policy="2" />,
    );
    const span = await waitFor(() => {
      const el = container.querySelector("span.tcy") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(span.textContent).toBe("12");
    expect(getComputedStyle(span).textCombineUpright).toBe("all");
  });

  it("横書きでは .tcy が付いても text-combine-upright は none（CSS は editor-vertical スコープ）", async () => {
    const { container } = render(
      <TcyFixture vertical={false} content="<p>第12話</p>" policy="2" />,
    );
    const span = await waitFor(() => {
      const el = container.querySelector("span.tcy") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(getComputedStyle(span).textCombineUpright).toBe("none");
  });

  // 別プラグイン由来の decoration が tcy deco に隣接した状態で境界に文字を挿入
  // しても ProseMirror の DOM reconciler がクラッシュしないことを実 Chromium で
  // gate する。tcy deco 同士は数字 run が必ず非数字で分かれるため隣接し得ないが、
  // codex/lint/comment 等の別 set とは隣接し得る（CodexHighlightPlugin が同種の
  // 隣接クラッシュを 8f201e46 でガードした前例。happy-dom では再現しないため
  // browser test でのみ検証可能）。
  it("別プラグインの隣接 decoration + 境界挿入でクラッシュしない", () => {
    // "12月" → tcy が "12" を [1,3) で装飾。テスト用プラグインが "月" を [3,4) で
    // 装飾し PM 位置3で隣接させる。境界(3)に文字を挿入してクラッシュしないこと。
    // editor を直接生成して view ハンドルを確実に握る（DOM 経由参照は脆い）。
    const adjacentKey = new PluginKey("adjacentTest");
    const adjacentDecoExtension = Extension.create({
      name: "adjacentTest",
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: adjacentKey,
            state: {
              init: (_c, state) =>
                DecorationSet.create(state.doc, [
                  Decoration.inline(3, 4, { class: "adjacent-test" }),
                ]),
              apply: (tr, old) =>
                tr.docChanged
                  ? DecorationSet.create(tr.doc, [
                      Decoration.inline(3, 4, { class: "adjacent-test" }),
                    ])
                  : old,
            },
            props: {
              decorations(state) {
                return adjacentKey.getState(state);
              },
            },
          }),
        ];
      },
    });

    const el = document.createElement("div");
    el.className = "editor-vertical";
    document.body.appendChild(el);
    const editor = new Editor({
      element: el,
      extensions: [StarterKit, tcyTestExtension("2"), adjacentDecoExtension],
      content: "<p>12月</p>",
    });
    // tcy span が実際に出ていることを確認（前提が成立しているか）。
    expect(el.querySelector("span.tcy")?.textContent).toBe("12");
    // 境界(PM 3)に文字を挿入。reconciler がクラッシュすれば throw して fail する。
    expect(() => {
      editor.commands.insertContentAt(3, "X");
    }).not.toThrow();
    editor.destroy();
    el.remove();
  });
});
