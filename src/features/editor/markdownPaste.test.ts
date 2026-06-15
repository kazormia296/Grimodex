// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import {
  markdownToPlainText,
  insertMarkdownAsUnknown,
  armPlainPaste,
  consumePlainPaste,
  isPlainPasteCombo,
  pasteExternalText,
  notePlainPasteKeyDown,
} from "./markdownPaste";

function makeEditor(content = "<p></p>"): Editor {
  return new Editor({ extensions: getEditorExtensions(), content });
}

type Run = { type: string; text: string; source: string };
function runs(editor: Editor): Run[] {
  const out: Run[] = [];
  editor.state.doc.descendants((node, _pos, parent) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "authorship");
    out.push({
      type: parent?.type.name ?? "",
      text: node.text ?? "",
      source: mark ? (mark.attrs.source as string) : "(human)",
    });
  });
  return out;
}

let editor: Editor;
beforeEach(() => {
  editor = makeEditor();
});
afterEach(() => {
  editor.destroy();
});

describe("markdownToPlainText (Ctrl+Shift+V: markdown 記法を除去)", () => {
  it("見出し記法 '# ' を除去する", () => {
    expect(markdownToPlainText(editor, "# 見出し")).toBe("見出し");
  });
  it("強調記法 '**' を除去する", () => {
    expect(markdownToPlainText(editor, "**太字**テキスト")).toBe(
      "太字テキスト",
    );
  });
  it("箇条書き '- ' を除去し、改行区切りのプレーンテキストにする", () => {
    expect(markdownToPlainText(editor, "- りんご\n- みかん")).toBe(
      "りんご\nみかん",
    );
  });
  it("markdown でない普通の文はそのまま返す", () => {
    expect(markdownToPlainText(editor, "ただの文章です")).toBe(
      "ただの文章です",
    );
  });
});

describe("insertMarkdownAsUnknown (通常ペースト: markdown を変換し unknown 帰属)", () => {
  it("'# 見出し' を heading ノードに変換する", () => {
    editor.commands.focus();
    insertMarkdownAsUnknown(editor, "# 見出し");
    const hasHeading = editor.state.doc.content.content.some(
      (n) => n.type.name === "heading",
    );
    expect(hasHeading).toBe(true);
  });

  it("'**太字**' を bold マークに変換する", () => {
    editor.commands.focus();
    insertMarkdownAsUnknown(editor, "**太字**");
    let bold = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === "bold")) {
        bold = true;
      }
    });
    expect(bold).toBe(true);
  });

  it("'- a\\n- b' を bulletList に変換する", () => {
    editor.commands.focus();
    insertMarkdownAsUnknown(editor, "- a\n- b");
    const hasList = editor.state.doc.content.content.some(
      (n) => n.type.name === "bulletList",
    );
    expect(hasList).toBe(true);
  });

  it("変換したテキストに source:'unknown' 帰属が付く (human にならない)", () => {
    editor.commands.focus();
    insertMarkdownAsUnknown(editor, "# 見出し\n\n本文テキスト");
    const r = runs(editor);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.source === "unknown")).toBe(true);
  });

  it("既存 human テキストの途中に変換ペーストしても、既存テキストは human のまま", () => {
    editor.destroy();
    editor = makeEditor("<p>前半の人間文ここまで後半の人間文</p>");
    // "前半の人間文" = 6 文字 → カーソルを pos 1+6 = 7 に置く
    editor.commands.setTextSelection(1 + 6);
    insertMarkdownAsUnknown(editor, "**挿入**");
    const r = runs(editor);
    const unknownText = r
      .filter((x) => x.source === "unknown")
      .map((x) => x.text)
      .join("");
    const humanText = r
      .filter((x) => x.source !== "unknown")
      .map((x) => x.text)
      .join("");
    // 挿入分だけ unknown。既存テキストは human のまま (巻き込まない)。
    expect(unknownText).toContain("挿入");
    expect(unknownText).not.toContain("人間");
    expect(humanText).toContain("前半の人間文");
    expect(humanText).toContain("後半の人間文");
  });

  it("ブロック(見出し)を human テキスト途中に挿入しても、後続の human は巻き込まない", () => {
    editor.destroy();
    editor = makeEditor("<p>前半の人間文ここまで後半の人間文</p>");
    editor.commands.setTextSelection(1 + 6); // "前半の人間文" の直後
    insertMarkdownAsUnknown(editor, "# 見出し");
    const r = runs(editor);
    const unknownText = r
      .filter((x) => x.source === "unknown")
      .map((x) => x.text)
      .join("");
    const humanText = r
      .filter((x) => x.source !== "unknown")
      .map((x) => x.text)
      .join("");
    expect(unknownText).toContain("見出し");
    expect(humanText).toContain("前半の人間文");
    expect(humanText).toContain("後半の人間文");
    expect(unknownText).not.toContain("人間"); // openEnd merge で後続 human を巻き込まない
  });

  it("変換後に途中を純粋削除しても、以降が unknown のまま (Bug B invariant)", () => {
    editor.commands.focus();
    insertMarkdownAsUnknown(editor, "段落のテキストをここに長めに用意する");
    const size = editor.state.doc.content.size;
    editor
      .chain()
      .setTextSelection({
        from: Math.floor(size * 0.4),
        to: Math.floor(size * 0.5),
      })
      .deleteSelection()
      .run();
    const r = runs(editor);
    expect(r.filter((x) => x.source !== "unknown")).toEqual([]);
  });
});

describe("plain-paste flag (Mod-Shift-V detection)", () => {
  it("isPlainPasteCombo は Mod+Shift+V を検出する", () => {
    expect(
      isPlainPasteCombo({
        key: "v",
        shiftKey: true,
        ctrlKey: true,
      } as KeyboardEvent),
    ).toBe(true);
    expect(
      isPlainPasteCombo({
        key: "V",
        shiftKey: true,
        metaKey: true,
      } as KeyboardEvent),
    ).toBe(true);
    // 修飾なし / Shift なしは false
    expect(
      isPlainPasteCombo({ key: "v", ctrlKey: true } as KeyboardEvent),
    ).toBe(false);
    expect(
      isPlainPasteCombo({
        key: "c",
        shiftKey: true,
        ctrlKey: true,
      } as KeyboardEvent),
    ).toBe(false);
  });

  it("arm → consume は一度だけ true を返す", () => {
    armPlainPaste();
    expect(consumePlainPaste()).toBe(true);
    expect(consumePlainPaste()).toBe(false);
  });

  it("notePlainPasteKeyDown: combo keydown で arm される", () => {
    notePlainPasteKeyDown({
      key: "v",
      shiftKey: true,
      ctrlKey: true,
    } as KeyboardEvent);
    expect(consumePlainPaste()).toBe(true);
  });

  it("notePlainPasteKeyDown: combo の後に別キーが来ると stale arm が消える", () => {
    notePlainPasteKeyDown({
      key: "v",
      shiftKey: true,
      ctrlKey: true,
    } as KeyboardEvent);
    // paste が来ず別キー入力 → クリア
    notePlainPasteKeyDown({ key: "a" } as KeyboardEvent);
    expect(consumePlainPaste()).toBe(false);
  });
});

describe("pasteExternalText (Case 3 の分岐: 通常=変換 / Shift=除去)", () => {
  it("plain=false: markdown を変換し、insertRaw は呼ばれない", () => {
    editor.commands.focus();
    let rawCalled = 0;
    pasteExternalText(
      editor,
      "# 見出し",
      () => {
        rawCalled++;
      },
      false,
    );
    expect(rawCalled).toBe(0);
    const hasHeading = editor.state.doc.content.content.some(
      (n) => n.type.name === "heading",
    );
    expect(hasHeading).toBe(true);
  });

  it("plain=true: markdown 記法を除去したテキストで insertRaw を呼ぶ (変換しない)", () => {
    editor.commands.focus();
    const rawArgs: string[] = [];
    pasteExternalText(
      editor,
      "# 見出し",
      (t) => {
        rawArgs.push(t);
      },
      true,
    );
    expect(rawArgs).toEqual(["見出し"]);
    // insertRaw はスパイなので実挿入しない → heading は作られない
    const hasHeading = editor.state.doc.content.content.some(
      (n) => n.type.name === "heading",
    );
    expect(hasHeading).toBe(false);
  });
});
