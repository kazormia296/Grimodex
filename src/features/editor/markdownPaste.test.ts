// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { getFileBackedEditorExtensions } from "@/features/external-mount/fileBackedEditorExtensions";
import {
  markdownToPlainText,
  insertMarkdownAsUnknown,
  insertPlainTextAsUnknown,
  armPlainPaste,
  consumePlainPaste,
  isPlainPasteCombo,
  pasteExternalText,
  notePlainPasteKeyDown,
  handleExternalPaste,
} from "./markdownPaste";

function fakeClipboardEvent(data: {
  plain?: string;
  html?: string;
}): ClipboardEvent {
  return {
    clipboardData: {
      getData: (type: string) =>
        type === "text/plain"
          ? (data.plain ?? "")
          : type === "text/html"
            ? (data.html ?? "")
            : "",
    },
  } as unknown as ClipboardEvent;
}

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

describe("insertPlainTextAsUnknown (任意エディタへのプレーン挿入)", () => {
  it("authorship を持つエディタ: テキストを source:'unknown' で挿入する", () => {
    editor.commands.focus();
    insertPlainTextAsUnknown(editor, "ただの文章");
    const r = runs(editor);
    expect(r.map((x) => x.text).join("")).toContain("ただの文章");
    expect(r.every((x) => x.source === "unknown")).toBe(true);
  });

  it("複数行は段落に分割される", () => {
    editor.commands.focus();
    insertPlainTextAsUnknown(editor, "行1\n行2\n行3");
    const paraTexts: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "paragraph") paraTexts.push(node.textContent);
    });
    expect(paraTexts).toContain("行1");
    expect(paraTexts).toContain("行2");
    expect(paraTexts).toContain("行3");
  });

  it("authorship を持たない file-backed エディタ: クラッシュせずテキストを挿入する", () => {
    const fb = new Editor({
      extensions: getFileBackedEditorExtensions(),
      content: "<p></p>",
    });
    try {
      fb.commands.focus();
      insertPlainTextAsUnknown(fb, "外部ファイルの文章");
      expect(fb.state.doc.textContent).toContain("外部ファイルの文章");
      // authorship マークは付かない (schema に無い)
      let hasAuthorship = false;
      fb.state.doc.descendants((node) => {
        if (node.marks.some((m) => m.type.name === "authorship")) {
          hasAuthorship = true;
        }
      });
      expect(hasAuthorship).toBe(false);
    } finally {
      fb.destroy();
    }
  });

  it("file-backed エディタでも Markdown を変換する (heading)", () => {
    const fb = new Editor({
      extensions: getFileBackedEditorExtensions(),
      content: "<p></p>",
    });
    try {
      fb.commands.focus();
      const ok = insertMarkdownAsUnknown(fb, "# 見出し");
      expect(ok).toBe(true);
      const hasHeading = fb.state.doc.content.content.some(
        (n) => n.type.name === "heading",
      );
      expect(hasHeading).toBe(true);
    } finally {
      fb.destroy();
    }
  });
});

describe("pasteExternalText: コードブロック内は verbatim (変換しない)", () => {
  function codeBlockText(editor: Editor): string {
    let txt = "";
    editor.state.doc.descendants((node) => {
      if (node.type.name === "codeBlock") txt = node.textContent;
    });
    return txt;
  }

  it("通常ペースト: Markdown を変換せず原文をコードブロックに挿入する", () => {
    editor.destroy();
    editor = makeEditor("<pre><code>let </code></pre>");
    editor.commands.setTextSelection(3); // "let " の内側 (コードブロック内)
    pasteExternalText(editor, "# 見出し\n**太字**", () => {}, false);
    // heading / bold ノードは作られない
    const hasHeading = editor.state.doc.content.content.some(
      (n) => n.type.name === "heading",
    );
    expect(hasHeading).toBe(false);
    // 記法がそのまま残る (verbatim)
    const code = codeBlockText(editor);
    expect(code).toContain("# 見出し");
    expect(code).toContain("**太字**");
    // 帰属の部分付与は起きない (コードブロックは mark 不可)
    const r = runs(editor);
    expect(r.some((x) => x.source === "unknown")).toBe(false);
  });

  it("Ctrl+Shift+V (plain=true): コードブロック内も原文 verbatim", () => {
    editor.destroy();
    editor = makeEditor("<pre><code></code></pre>");
    editor.commands.setTextSelection(1);
    pasteExternalText(editor, "## 見出し", () => {}, true);
    const code = codeBlockText(editor);
    expect(code).toContain("## 見出し");
  });

  it("コードブロック内: 非空選択を上書きして verbatim 挿入する", () => {
    editor.destroy();
    editor = makeEditor("<pre><code>hello world</code></pre>");
    // "world" (pos 7-12) を選択して上書き
    editor.commands.setTextSelection({ from: 7, to: 12 });
    pasteExternalText(editor, "code", () => {}, false);
    expect(codeBlockText(editor)).toBe("hello code");
  });

  it("複数行も改行を保持して verbatim 挿入する", () => {
    editor.destroy();
    editor = makeEditor("<pre><code></code></pre>");
    editor.commands.setTextSelection(1);
    pasteExternalText(editor, "行1\n行2", () => {}, false);
    expect(codeBlockText(editor)).toBe("行1\n行2");
  });

  it("ガードは過剰発火しない: 引用(blockquote)内では Markdown 変換が効く", () => {
    editor.destroy();
    editor = makeEditor("<blockquote><p>引用</p></blockquote>");
    editor.commands.setTextSelection(2); // blockquote > paragraph 内
    pasteExternalText(editor, "**太字**", () => {}, false);
    let hasBold = false;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === "bold")) {
        hasBold = true;
      }
    });
    expect(hasBold).toBe(true);
  });
});

describe("handleExternalPaste (Linear/fileBacked 共有ハンドラ)", () => {
  it("外部テキスト: Markdown を変換し true を返す", () => {
    editor.commands.focus();
    const handled = handleExternalPaste(
      editor,
      fakeClipboardEvent({ plain: "# 見出し" }),
    );
    expect(handled).toBe(true);
    const hasHeading = editor.state.doc.content.content.some(
      (n) => n.type.name === "heading",
    );
    expect(hasHeading).toBe(true);
  });

  it("内部コピー(data-grimodex-source)は false を返し挿入しない (既定処理に委譲)", () => {
    editor.commands.focus();
    const before = editor.state.doc.textContent;
    const handled = handleExternalPaste(
      editor,
      fakeClipboardEvent({
        plain: "# 見出し",
        html: '<div data-grimodex-source="ai"># 見出し</div>',
      }),
    );
    expect(handled).toBe(false);
    expect(editor.state.doc.textContent).toBe(before);
  });

  it("内部コピー(data-pm-slice)は false を返す", () => {
    editor.commands.focus();
    const handled = handleExternalPaste(
      editor,
      fakeClipboardEvent({ plain: "x", html: "<p data-pm-slice>x</p>" }),
    );
    expect(handled).toBe(false);
  });

  it("sanitize オプションを変換前に適用する", () => {
    editor.commands.focus();
    handleExternalPaste(editor, fakeClipboardEvent({ plain: "Xあいう" }), {
      sanitize: (t) => t.replace("X", ""),
    });
    expect(editor.state.doc.textContent).toContain("あいう");
    expect(editor.state.doc.textContent).not.toContain("X");
  });

  it("空テキスト / editor=null は false", () => {
    expect(handleExternalPaste(editor, fakeClipboardEvent({ plain: "" }))).toBe(
      false,
    );
    expect(handleExternalPaste(null, fakeClipboardEvent({ plain: "x" }))).toBe(
      false,
    );
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

  it("plain=true: ブロック専用記法(---)は空にせず原文で挿入する (silent drop 回避)", () => {
    // markdownToPlainText("---") は水平線=テキスト0で "" になるため、
    // そのまま挿入すると貼り付けが無音で消える。原文 fallback を確認。
    const args: string[] = [];
    pasteExternalText(editor, "---", (t) => args.push(t), true);
    expect(args).toEqual(["---"]);
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
