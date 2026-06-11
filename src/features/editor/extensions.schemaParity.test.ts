// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { getDocText } from "@/features/editor/RubyNode";

// スキーマ非対称による本文消失の回帰テスト。
// TipTap はスキーマに無いノード型を含む JSON を setContent すると
// errorOnInvalidContent 指定が無い限り console.warn だけ出して **空 doc に
// フォールバック**する。mention 拡張が setMentionPopup を渡したサーフェス
// (EditorPane) でしか登録されていなかったため、@mention を含むシーンを
// LinearSceneBlock (popup 無し) が開くと本文が空に化け、次の autosave が
// 空 doc を DB に書き戻して「リニアモード解除で本文全消失」になっていた。

const MENTION_DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "主人公は" },
        {
          type: "mention",
          attrs: { id: "entry-1", label: "アリス" },
        },
        { type: "text", text: "と出会った。" },
      ],
    },
  ],
};

function countMentions(editor: Editor): number {
  let n = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "mention") n += 1;
    return true;
  });
  return n;
}

describe("editor schema parity (mention)", () => {
  it("popup 無しスキーマ (LinearSceneBlock 等) でも mention 入り doc を失わず読める", () => {
    const editor = new Editor({
      extensions: getEditorExtensions(),
      content: "",
    });
    try {
      editor.commands.setContent(MENTION_DOC, {
        emitUpdate: false,
        errorOnInvalidContent: true,
      });
      expect(getDocText(editor.state.doc)).toContain("主人公は");
      expect(getDocText(editor.state.doc)).toContain("と出会った。");
      expect(countMentions(editor)).toBe(1);
    } finally {
      editor.destroy();
    }
  });

  it("popup 有り / 無しスキーマ間で mention doc が同一 JSON にラウンドトリップする", () => {
    const withPopup = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: () => {} }),
      content: "",
    });
    const withoutPopup = new Editor({
      extensions: getEditorExtensions(),
      content: "",
    });
    try {
      withPopup.commands.setContent(MENTION_DOC, { emitUpdate: false });
      withoutPopup.commands.setContent(withPopup.getJSON(), {
        emitUpdate: false,
        errorOnInvalidContent: true,
      });
      expect(withoutPopup.getJSON()).toEqual(withPopup.getJSON());
    } finally {
      withPopup.destroy();
      withoutPopup.destroy();
    }
  });

  it("popup 無しスキーマにも mention ノード型はあり、suggestion plugin だけが無い", () => {
    const withPopup = new Editor({
      extensions: getEditorExtensions({ setMentionPopup: () => {} }),
      content: "",
    });
    const withoutPopup = new Editor({
      extensions: getEditorExtensions(),
      content: "",
    });
    try {
      // ノード型はどちらのスキーマにも登録される (doc 互換の本体)
      expect(withPopup.schema.nodes.mention).toBeDefined();
      expect(withoutPopup.schema.nodes.mention).toBeDefined();
      // suggestion plugin (active 中 Enter/矢印を奪う) は popup 配線時のみ。
      // 拡張リストは mention 以外同一なので、差分は suggestion の 1 plugin。
      expect(withPopup.state.plugins.length).toBe(
        withoutPopup.state.plugins.length + 1,
      );
    } finally {
      withPopup.destroy();
      withoutPopup.destroy();
    }
  });

  it("本当に未知のノード型は errorOnInvalidContent で throw する (silent 空 doc 化させない)", () => {
    const editor = new Editor({
      extensions: getEditorExtensions(),
      content: "",
    });
    try {
      expect(() =>
        editor.commands.setContent(
          {
            type: "doc",
            content: [{ type: "node-from-the-future" }],
          },
          { emitUpdate: false, errorOnInvalidContent: true },
        ),
      ).toThrow();
    } finally {
      editor.destroy();
    }
  });
});
