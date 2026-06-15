// @vitest-environment happy-dom
//
// REPRO (Bug B): 外部アプリからコピー → 本文に貼り付け (Case 3, source:"unknown")
// → 途中を範囲選択して Backspace/Delete (純粋削除) → 「それ以降が human になる」
//
// ユーザー報告のシナリオを実拡張スタック + 実 insertFromPaste 経路で再現する。
// happy-dom はモデルレベル (doc の mark) を正しく計算できるため、
// 「削除後に末尾の authorship mark が残るか」はこのレイヤで判定できる。
// (帰属カラー表示 buildDecorations は node.marks を忠実に読むだけなので、
//  doc-level の mark が残れば overlay も unknown のまま。逆もまた然り。)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { createAiEditedPlugin } from "./AiEditedPlugin";
import { createAttributionPlugin } from "./AttributionPlugin";
import { useAttributionStore } from "./attributionStore";
import { useEditorStore } from "@/features/editor/editorStore";

type SourceRun = { text: string; source: string };

function sourcesOf(editor: Editor): SourceRun[] {
  const out: SourceRun[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "authorship");
    out.push({
      text: node.text ?? "",
      source: mark ? (mark.attrs.source as string) : "(none→human)",
    });
  });
  return out;
}

function makeEditor(): Editor {
  const editor = new Editor({
    extensions: getEditorExtensions(),
    content: "<p></p>",
  });
  // useAttribution.ts と同じ順序で動的登録
  editor.registerPlugin(createAttributionPlugin());
  editor.registerPlugin(createAiEditedPlugin());
  useEditorStore.getState().setEditor(editor);
  useAttributionStore.setState({ showAttribution: true, filterSource: null });
  return editor;
}

let editor: Editor;
beforeEach(() => {
  editor = makeEditor();
});
afterEach(() => {
  useEditorStore.getState().setEditor(null);
  editor?.destroy();
});

describe("Bug B repro: external paste(unknown) → mid-range pure delete", () => {
  it("単一段落: 途中削除後、末尾の unknown マークが残る", () => {
    const text = "これはとても長い外部からの貼り付け文章です"; // 21 chars
    editor.commands.focus();
    useEditorStore.getState().insertFromPaste([{ text, source: "unknown" }]);

    // paste 直後: 全文 unknown のはず
    const afterPaste = sourcesOf(editor);
    expect(afterPaste.every((r) => r.source === "unknown")).toBe(true);

    // 中央 5〜9 文字目を範囲選択して純粋削除 (Backspace/Delete 相当)
    // テキストは段落内 pos=1 から始まる
    const delFrom = 1 + 5;
    const delTo = 1 + 9;
    editor
      .chain()
      .setTextSelection({ from: delFrom, to: delTo })
      .deleteSelection()
      .run();

    const afterDelete = sourcesOf(editor);
    // 期待: 生き残った全テキストが unknown のまま
    const humanRuns = afterDelete.filter((r) => r.source !== "unknown");
    expect(humanRuns).toEqual([]); // ← human 化していたら失敗 = 再現
  });

  it("複数段落: 段落内の途中削除後、その段落と後続段落が unknown のまま", () => {
    const text = "第一段落のテキスト\n第二段落のテキスト\n第三段落のテキスト";
    editor.commands.focus();
    useEditorStore.getState().insertFromPaste([{ text, source: "unknown" }]);

    const afterPaste = sourcesOf(editor);
    expect(afterPaste.every((r) => r.source === "unknown")).toBe(true);

    // 第二段落の途中を削除 (おおよそ中央)
    const size = editor.state.doc.content.size;
    const delFrom = Math.floor(size * 0.4);
    const delTo = Math.floor(size * 0.5);
    editor
      .chain()
      .setTextSelection({ from: delFrom, to: delTo })
      .deleteSelection()
      .run();

    const afterDelete = sourcesOf(editor);
    const humanRuns = afterDelete.filter((r) => r.source !== "unknown");
    expect(humanRuns).toEqual([]);
  });

  it("置換(type-over): 中央を選択して文字入力 → 編集箇所のみ human、以降は unknown のまま", () => {
    const text = "外部からの貼り付け文章をここに配置する";
    editor.commands.focus();
    useEditorStore.getState().insertFromPaste([{ text, source: "unknown" }]);

    // 中央 6〜10 文字を選択して "X" で置換 (非 programmatic = ユーザー編集)
    editor
      .chain()
      .setTextSelection({ from: 1 + 6, to: 1 + 10 })
      .insertContent("X")
      .run();

    const sources = sourcesOf(editor);
    // 編集箇所 "X" は human(none) 化、その「以降」は unknown のまま (= "それ以降" は human にならない)
    const tail = sources[sources.length - 1];
    expect(tail.source).toBe("unknown");
    // human 化したのは挿入した "X" だけ
    const humanText = sources
      .filter((r) => r.source !== "unknown")
      .map((r) => r.text)
      .join("");
    expect(humanText).toBe("X");
  });

  it("seam で継続入力: 削除→カーソル位置で入力しても、以降は unknown のまま", () => {
    const text = "外部からの貼り付け文章をここに配置する";
    editor.commands.focus();
    useEditorStore.getState().insertFromPaste([{ text, source: "unknown" }]);

    // 中央を純粋削除
    editor
      .chain()
      .setTextSelection({ from: 1 + 6, to: 1 + 10 })
      .deleteSelection()
      .run();
    // seam で1文字入力
    editor.chain().insertContent("Z").run();

    const sources = sourcesOf(editor);
    const tail = sources[sources.length - 1];
    expect(tail.source).toBe("unknown"); // 末尾(以降)は unknown
    const humanText = sources
      .filter((r) => r.source !== "unknown")
      .map((r) => r.text)
      .join("");
    expect(humanText).toBe("Z"); // human 化したのは入力した "Z" のみ
  });

  it("既存の人間テキストの直後に貼り付け → 貼付分の途中削除", () => {
    // 既存 human 文 + その後ろに外部ペースト(unknown)
    editor.commands.focus();
    editor.commands.insertContent("既存の人間が書いた文章。");
    // 末尾(カーソル)に外部ペースト
    useEditorStore
      .getState()
      .insertFromPaste([
        { text: "外部から貼り付けた未知ソースの文章", source: "unknown" },
      ]);

    // 貼付分の中央を削除
    const size = editor.state.doc.content.size;
    const delFrom = Math.floor(size * 0.75);
    const delTo = Math.floor(size * 0.85);
    editor
      .chain()
      .setTextSelection({ from: delFrom, to: delTo })
      .deleteSelection()
      .run();

    const afterDelete = sourcesOf(editor);
    // 貼付由来の unknown ランが残り、削除点以降が human 化していないこと
    const unknownRuns = afterDelete.filter((r) => r.source === "unknown");
    expect(unknownRuns.length).toBeGreaterThan(0);
    // 貼付分の末尾(最後のラン)が unknown のまま
    const last = afterDelete[afterDelete.length - 1];
    expect(last.source).toBe("unknown");
  });
});
