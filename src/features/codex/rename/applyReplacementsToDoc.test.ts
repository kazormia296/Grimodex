// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { getEditorExtensions } from "@/features/editor/extensions";
import { flattenDocForCodex } from "@/features/editor/codexDocFlatten";
import {
  applyReplacementsToDoc,
  applyReplacementsToString,
  type FlatSpan,
} from "./applyReplacementsToDoc";

function editorWith(content: object): Editor {
  const editor = new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
  });
  editor.commands.setContent(content);
  return editor;
}

/** All flat spans of `needle` in the doc's flattened text. */
function spansOf(doc: ProseMirrorNode, needle: string): FlatSpan[] {
  const { text } = flattenDocForCodex(doc);
  const spans: FlatSpan[] = [];
  let i = text.indexOf(needle);
  while (i !== -1) {
    spans.push({ from: i, to: i + needle.length });
    i = text.indexOf(needle, i + needle.length);
  }
  return spans;
}

function textOf(doc: ProseMirrorNode): string {
  return flattenDocForCodex(doc).text;
}

describe("applyReplacementsToDoc", () => {
  it("単一の旧名を新名に置換", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "アキラは走った" }],
        },
      ],
    });
    const doc = editor.state.doc;
    const res = applyReplacementsToDoc(doc, spansOf(doc, "アキラ"), "アキト");
    expect(res.applied).toBe(1);
    expect(textOf(res.doc)).toBe("アキトは走った");
    editor.destroy();
  });

  it("複数出現を back-to-front で置換 (新名が長くてもズレない)", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "太郎と太郎と太郎" }],
        },
      ],
    });
    const doc = editor.state.doc;
    const res = applyReplacementsToDoc(doc, spansOf(doc, "太郎"), "次郎丸");
    expect(res.applied).toBe(3);
    expect(textOf(res.doc)).toBe("次郎丸と次郎丸と次郎丸");
    editor.destroy();
  });

  it("新名が短くてもズレない", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "ロビンとロビン" }],
        },
      ],
    });
    const doc = editor.state.doc;
    const res = applyReplacementsToDoc(doc, spansOf(doc, "ロビン"), "葵");
    expect(textOf(res.doc)).toBe("葵と葵");
    editor.destroy();
  });

  it("置換テキストは元スパンの mark を継承する", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "アキラ", marks: [{ type: "bold" }] },
          ],
        },
      ],
    });
    const doc = editor.state.doc;
    const res = applyReplacementsToDoc(doc, spansOf(doc, "アキラ"), "アキト");
    let bolded: string | null = null;
    res.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === "bold")) {
        bolded = node.text ?? null;
      }
    });
    expect(bolded).toBe("アキト");
    editor.destroy();
  });

  it("ruby base に重なるスパンは skip", () => {
    const editor = editorWith({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    editor.commands.setRuby("金", "きん");
    const doc = editor.state.doc;
    const spans = spansOf(doc, "金");
    expect(spans.length).toBe(1); // ruby base に「金」
    const res = applyReplacementsToDoc(doc, spans, "ゴールド");
    expect(res.applied).toBe(0);
    expect(res.skipped).toBe(1);
    // ruby は無傷
    expect(textOf(res.doc)).toBe("金");
    editor.destroy();
  });

  it("mention は構造的に不可侵 (flat offset を持たないので置換対象にならない)", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "アキラと" },
            { type: "mention", attrs: { id: "1", label: "アキラ" } },
            { type: "text", text: "。" },
          ],
        },
      ],
    });
    const doc = editor.state.doc;
    // flat text は地の文「アキラと。」のみ(mention label は含まれない)
    const res = applyReplacementsToDoc(doc, spansOf(doc, "アキラ"), "アキト");
    expect(res.applied).toBe(1);
    // 地の文だけ置換、mention ノードは残る
    let mentionLabel: string | null = null;
    let mentionCount = 0;
    res.doc.descendants((node) => {
      if (node.type.name === "mention") {
        mentionCount++;
        mentionLabel = node.attrs.label as string;
      }
    });
    expect(mentionCount).toBe(1);
    expect(mentionLabel).toBe("アキラ");
    expect(textOf(res.doc)).toBe("アキトと。");
    editor.destroy();
  });

  it("空 spans / 空 newName は no-op", () => {
    const editor = editorWith({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "アキラ" }] },
      ],
    });
    const doc = editor.state.doc;
    expect(applyReplacementsToDoc(doc, [], "X").applied).toBe(0);
    expect(
      applyReplacementsToDoc(doc, spansOf(doc, "アキラ"), "").applied,
    ).toBe(0);
    editor.destroy();
  });
});

describe("applyReplacementsToString", () => {
  it("プレーン文字列をオフセット置換 (back-to-front)", () => {
    const text = "太郎の友、太郎。";
    const spans: FlatSpan[] = [];
    let i = text.indexOf("太郎");
    while (i !== -1) {
      spans.push({ from: i, to: i + 2 });
      i = text.indexOf("太郎", i + 2);
    }
    expect(applyReplacementsToString(text, spans, "次郎丸")).toBe(
      "次郎丸の友、次郎丸。",
    );
  });
});
