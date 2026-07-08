// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { Decoration } from "@tiptap/pm/view";
import { getEditorExtensions } from "../extensions";
import * as ParagraphMoveExtension from "../ParagraphMoveExtension";
import {
  reorderUiKey,
  __resetReorderInteractionForTest,
  __reorderDragTestHooks,
} from "./ReorderInteractionExtension";
import {
  flatRangeToPm,
  resolveParagraphAtPos,
  resolveParagraphAtSelection,
} from "./paragraphFlat";
import { splitSentencesJa } from "./sentenceSplit";
import { useReorderModifierStore } from "./reorderModifierStore";
import { clearBunsetsuCache, fetchBunsetsuUnits } from "./bunsetsuSegmenter";
import { currentUnitsFromOrder } from "./reorderPermutation";
import type { ReorderUnit } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (_cmd: string, args: { text: string }) => {
    // テスト用の疑似文節分割: 2 文字ごとに区切る（文と明確に異なる境界数）。
    const text = args.text;
    const dtos: Array<{ start: number; end: number; surface: string }> = [];
    for (let i = 0; i < text.length; i += 2) {
      dtos.push({
        start: i,
        end: Math.min(i + 2, text.length),
        surface: text.slice(i, Math.min(i + 2, text.length)),
      });
    }
    return dtos;
  }),
}));

vi.mock("@/features/project/projectStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/project/projectStore")>();
  return {
    ...actual,
    getCurrentProjectLanguage: () => "ja",
  };
});

function makeEditor(html: string): Editor {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    content: html,
  });
}

function decos(editor: Editor): Decoration[] {
  return reorderUiKey.getState(editor.state)?.decorations.find() ?? [];
}

function classOf(d: Decoration): string {
  return (
    (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs
      ?.class ?? ""
  );
}

function mockBlockRects(_view: Editor["view"]): void {
  vi.spyOn(ParagraphMoveExtension, "blockRectAtIndex").mockImplementation(
    (_view, index) => {
      const height = 50;
      const top = index * height;
      return new DOMRect(0, top, 100, height);
    },
  );
}

/**
 * 単位文字幅で仮想レイアウトした flat offset を返す（reflow シミュレーション）。
 * 実ブラウザでは同じ画面座標でも swap 後の再レイアウトで下にある文字が
 * 変わり得る。posAtCoords をこのモデルで stub することで、その reflow を
 * 単体テストで再現する。
 */
function flatOffsetAtScreenX(
  unitsInOrder: ReorderUnit[],
  x: number,
  charWidth = 10,
): number {
  let px = 0;
  let cursor = 0;
  for (const u of unitsInOrder) {
    const len = u.to - u.from;
    const width = len * charWidth;
    if (x < px + width) {
      const localFrac = (x - px) / width;
      return cursor + Math.round(localFrac * len);
    }
    px += width;
    cursor += len;
  }
  return cursor;
}

describe("ReorderInteractionExtension", () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    useReorderModifierStore.setState({ mode: "none", granularity: "sentence" });
    clearBunsetsuCache();
    __resetReorderInteractionForTest();
    vi.restoreAllMocks();
  });

  it("swapBlockAt swaps a block at an explicit index (drag primitive)", () => {
    editor = makeEditor("<p>first</p><p>second</p><p>third</p>");
    // index 0 を dir=1 で下へ → first と second が入れ替わる
    expect(ParagraphMoveExtension.swapBlockAt(editor.view, 0, 1)).toBe(true);
    expect(editor.state.doc.content.content.map((n) => n.textContent)).toEqual([
      "second",
      "first",
      "third",
    ]);
    // index 2 を dir=1（範囲外）は不可
    expect(ParagraphMoveExtension.swapBlockAt(editor.view, 2, 1)).toBe(false);
  });

  it("mode='none' produces no decorations", () => {
    editor = makeEditor("<p>あいう。えお。</p>");
    expect(decos(editor)).toHaveLength(0);
  });

  it("mode='altShift' bands each sentence unit and rings the caret unit", () => {
    editor = makeEditor("<p>あいう。えお。かきく。</p>");
    editor.commands.setTextSelection(2); // 最初の文「あいう。」内
    useReorderModifierStore.getState().setMode("altShift");

    const inline = decos(editor).filter((d) =>
      classOf(d).includes("reorder-unit"),
    );
    // 3 文 → 3 帯
    expect(inline).toHaveLength(3);
    // 色帯クラスが循環している
    expect(classOf(inline[0]!)).toContain("reorder-unit-c0");
    expect(classOf(inline[1]!)).toContain("reorder-unit-c1");
    // caret のある最初の unit だけ active
    const active = inline.filter((d) =>
      classOf(d).includes("reorder-unit-active"),
    );
    expect(active).toHaveLength(1);
    expect(classOf(active[0]!)).toContain("reorder-unit-c0");
  });

  it("active unit follows the caret", () => {
    editor = makeEditor("<p>あいう。えお。かきく。</p>");
    useReorderModifierStore.getState().setMode("altShift");
    // 「えお。」内へキャレット移動（"あいう。"=4文字→pos 1..5, "えお。"=pos5..8 くらい）
    editor.commands.setTextSelection(6);
    // 選択変更で再ビルドされる
    const inline = decos(editor).filter((d) =>
      classOf(d).includes("reorder-unit-active"),
    );
    expect(inline).toHaveLength(1);
    expect(classOf(inline[0]!)).toContain("reorder-unit-c1");
  });

  it("mode='alt' adds a handle widget + relative anchor per non-leaf block", () => {
    editor = makeEditor("<p>one</p><p>two</p>");
    useReorderModifierStore.getState().setMode("alt");
    const all = decos(editor);
    const anchors = all.filter((d) =>
      classOf(d).includes("reorder-block-anchor"),
    );
    const handles = all.filter(
      (d) =>
        (d.spec as { key?: string } | undefined)?.key ===
        "reorder-block-handle",
    );
    expect(anchors).toHaveLength(2);
    expect(handles).toHaveLength(2);
  });

  it("toggling granularity to bunsetsu while altShift is held immediately rebuilds bands with bunsetsu boundaries (regression)", async () => {
    // 回帰対象のバグ: editor.commands.X()（非chain）は「コマンド本体の実行が
    // 終わった後」に実 dispatch する。かつ tiptap の ExtensionManager.plugins
    // は extensions 配列を reverse() してから plugin を積むため、
    // reorderUiKey の apply() が reorderKey の apply() より先に呼ばれうる。
    // どちらの経路でも粒度変化の検出を誤ると、装飾が旧粒度のまま固まる。
    clearBunsetsuCache();
    editor = makeEditor("<p>あいう。えお。かきく。</p>");
    editor.commands.setTextSelection(2);
    await fetchBunsetsuUnits("あいう。えお。かきく。");

    useReorderModifierStore.getState().setMode("altShift");
    const toggled = editor.commands.toggleReorderGranularity();
    expect(toggled).toBe(true);

    const inline = decos(editor).filter((d) =>
      classOf(d).includes("reorder-unit"),
    );
    // モック文節分割（2文字ごと）で 12 文字 → 6 unit。文粒度の 3 のままなら
    // 回帰。
    expect(inline).toHaveLength(6);
    expect(
      inline.every((d) => classOf(d).includes("reorder-unit-bunsetsu")),
    ).toBe(true);
  });

  it("single-unit paragraph gets no bands in altShift", () => {
    editor = makeEditor("<p>句点なし本文</p>");
    editor.commands.setTextSelection(2);
    useReorderModifierStore.getState().setMode("altShift");
    expect(decos(editor)).toHaveLength(0);
  });

  it("unit drag (mouse) incrementally reorders to the pointer target and clears drag state", () => {
    editor = makeEditor("<p>AAA。BBB。CCC。</p>");
    editor.commands.setTextSelection(2);
    useReorderModifierStore.getState().setMode("altShift");
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units0 = splitSentencesJa(resolved.flat.text);
    expect(units0).toHaveLength(3);
    // ポインタは常に段落末尾を指す → unit0 を末尾までインクリメンタル移動。
    const endPos = resolved.contentTo - 1;
    editor.view.posAtCoords = () => ({ pos: endPos, inside: -1 });

    __reorderDragTestHooks.startUnitDrag(editor.view, resolved.pos, units0, 0);
    // ドラッグ中の色帯は plugin 状態の drag order から組まれる。
    expect(reorderUiKey.getState(editor.state)?.drag).not.toBeNull();
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 200, clientY: 200 }),
    );
    window.dispatchEvent(new MouseEvent("mouseup"));

    // AAA。が末尾へ。内容は一切欠落しない。
    expect(editor.state.doc.textContent).toBe("BBB。CCC。AAA。");
    // ドラッグ状態はクリア済み。
    expect(reorderUiKey.getState(editor.state)?.drag).toBeNull();
  });

  it("unit drag settles without fighting when the pointer stays at the same screen position across reflow (regression)", () => {
    // 長さの異なる 3 unit（1/1/2 文字）。x=15 は、初回 swap で unit の
    // 再配置が起きた直後にちょうど境界を跨ぐ位置になるよう選んである
    // （ブルートフォースで確認済み）。旧実装（「pointer がどの slot を指す
    // か」を絶対 target として毎回計算し直す方式）はこのケースで、同一
    // ポインタ位置への再 mousemove のたびに drag 対象が [1,2,0]⇄[1,0,2] を
    // 永久に往復する「fighting/チラツキ」を起こす。新実装（隣接 slot の
    // 中点を跨いだときだけ 1 手 swap するヒステリシス方式）は 1 回で
    // [1,0,2] に収束し、以降変化しない。
    editor = makeEditor("<p>ABCC</p>");
    useReorderModifierStore.getState().setMode("altShift");
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units0: ReorderUnit[] = [
      { from: 0, to: 1, surface: "A" },
      { from: 1, to: 2, surface: "B" },
      { from: 2, to: 4, surface: "CC" },
    ];

    editor.view.posAtCoords = ({ left }: { left: number }) => {
      const drag = reorderUiKey.getState(editor.state)?.drag;
      const order = drag?.order ?? [0, 1, 2];
      const cu = currentUnitsFromOrder(units0, order);
      const flatOffset = flatOffsetAtScreenX(cu, left);
      const resolvedNow = resolveParagraphAtPos(editor.state, resolved.pos)!;
      const clamped = Math.max(
        0,
        Math.min(flatOffset, resolvedNow.flat.text.length - 1),
      );
      const pm = flatRangeToPm(resolvedNow.flat, clamped, clamped + 1);
      return { pos: pm.from, inside: -1 };
    };

    __reorderDragTestHooks.startUnitDrag(editor.view, resolved.pos, units0, 0);

    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 15, clientY: 0 }),
    );
    const afterFirst = editor.state.doc.textContent;
    // 新実装は 1 回で [1,0,2]="BACC" に収束する（少なくとも 1 回は
    // swap している = 何も起きていないテストにしない）。
    expect(afterFirst).toBe("BACC");

    // 同一ポインタ位置での再 mousemove（reflow 後、実ブラウザで頻発する
    // 冗長イベント相当）。ここで巻き戻りが起きないことを確認する
    // （旧実装はここで BCCA ⇄ BACC を永久に往復していた）。
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 15, clientY: 0 }),
    );
    expect(editor.state.doc.textContent).toBe(afterFirst);

    // 何度繰り返しても安定している（無限に前後しない）。
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 15, clientY: 0 }),
    );
    expect(editor.state.doc.textContent).toBe(afterFirst);

    window.dispatchEvent(new MouseEvent("mouseup"));
  });

  it("block drag (mouse) incrementally reorders whole paragraphs to the pointer target", () => {
    editor = makeEditor("<p>one</p><p>two</p><p>three</p>");
    useReorderModifierStore.getState().setMode("alt");
    mockBlockRects(editor.view);

    __reorderDragTestHooks.startBlockDrag(editor.view, 0);
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 200, clientY: 200 }),
    );
    window.dispatchEvent(new MouseEvent("mouseup"));

    expect(editor.state.doc.content.content.map((n) => n.textContent)).toEqual([
      "two",
      "three",
      "one",
    ]);
  });

  it("drag cleanup removes window listeners (no dangling swaps after mouseup)", () => {
    editor = makeEditor("<p>AAA。BBB。CCC。</p>");
    editor.commands.setTextSelection(2);
    useReorderModifierStore.getState().setMode("altShift");
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units0 = splitSentencesJa(resolved.flat.text);
    editor.view.posAtCoords = () => ({
      pos: resolved.contentTo - 1,
      inside: -1,
    });
    __reorderDragTestHooks.startUnitDrag(editor.view, resolved.pos, units0, 0);
    window.dispatchEvent(new MouseEvent("mouseup"));
    const after = editor.state.doc.textContent;
    // mouseup 後の mousemove は無視される（リスナ解除済み）。
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 300, clientY: 300 }),
    );
    expect(editor.state.doc.textContent).toBe(after);
  });
});
