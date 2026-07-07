// @vitest-environment happy-dom
//
// 段落移動 (隣接ブロック swap) 時に Codex ハイライト装飾を保持する remap の回帰テスト。
// tr.replaceWith は置換範囲内の装飾を DecorationSet.map で落とすため、移動中に色と
// padding が消えて折り返しズレ・ちらつきが出ていた。remapCodexDecosForReorder が
// per-block オフセットで装飾を再構築して保持することを gate する。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Fragment } from "@tiptap/pm/model";
import {
  remapCodexDecosForReorder,
  remapCodexDecosForInlinePermutation,
} from "./CodexHighlightPlugin";

function attrsClass(d: Decoration): string {
  return (d as unknown as { type: { attrs: Record<string, string> } }).type
    .attrs.class;
}

describe("remapCodexDecosForReorder", () => {
  it("段落 swap で前後ブロックの inline 装飾を新位置へ保持する", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>foofoo</p><p>barbar</p>",
    });
    const doc = editor.state.doc;
    const p1 = doc.child(0); // foofoo: node [0,8), text 1..6
    const p2 = doc.child(1); // barbar: node [8,16), text 9..14
    const decoSet = DecorationSet.create(doc, [
      Decoration.inline(1, 7, { class: "c-foo" }, { codexKind: "inline" }),
      Decoration.inline(9, 15, { class: "c-bar" }, { codexKind: "inline" }),
    ]);

    const tr = editor.state.tr.replaceWith(
      0,
      doc.content.size,
      Fragment.fromArray([p2, p1]),
    );
    // 素の map は装飾を落とす（バグの再現）。
    expect(decoSet.map(tr.mapping, tr.doc).find()).toHaveLength(0);

    const remapped = remapCodexDecosForReorder(decoSet, tr.doc, {
      start: 0,
      firstSize: p1.nodeSize,
      secondSize: p2.nodeSize,
    });
    const list = remapped
      .find()
      .map((d) => ({ from: d.from, to: d.to, cls: attrsClass(d) }));

    // foofoo(前ブロック)の装飾は後ろへ +8: 1-7 → 9-15
    // barbar(後ブロック)の装飾は前へ -8: 9-15 → 1-7
    expect(list).toContainEqual({ from: 9, to: 15, cls: "c-foo" });
    expect(list).toContainEqual({ from: 1, to: 7, cls: "c-bar" });
    editor.destroy();
  });

  it("装飾は消えない（移動で装飾数と attrs が保たれる）", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>aaa</p><p>bbb</p>",
    });
    const doc = editor.state.doc;
    const decoSet = DecorationSet.create(doc, [
      Decoration.inline(
        1,
        4,
        { class: "codex-highlight", style: "padding-inline: 2px" },
        { codexKind: "inline" },
      ),
    ]);
    const tr = editor.state.tr.replaceWith(
      0,
      doc.content.size,
      Fragment.fromArray([doc.child(1), doc.child(0)]),
    );
    const remapped = remapCodexDecosForReorder(decoSet, tr.doc, {
      start: 0,
      firstSize: doc.child(0).nodeSize,
      secondSize: doc.child(1).nodeSize,
    });
    const found = remapped.find();
    expect(found).toHaveLength(1);
    expect(attrsClass(found[0])).toBe("codex-highlight");
    // aaa は前ブロック → 後ろへ (+5): 1-4 → 6-9
    expect({ from: found[0].from, to: found[0].to }).toEqual({
      from: 6,
      to: 9,
    });
    editor.destroy();
  });

  it("swap 範囲外の装飾は位置を変えずに保持する", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>aaa</p><p>bbb</p><p>ccc</p>",
    });
    const doc = editor.state.doc;
    // ccc(3番目, 範囲外)の装飾。swap するのは先頭2ブロックのみ。
    const decoSet = DecorationSet.create(doc, [
      Decoration.inline(11, 14, { class: "c-ccc" }, { codexKind: "inline" }),
    ]);
    const first = doc.child(0);
    const second = doc.child(1);
    const tr = editor.state.tr.replaceWith(
      0,
      first.nodeSize + second.nodeSize,
      Fragment.fromArray([second, first]),
    );
    const remapped = remapCodexDecosForReorder(decoSet, tr.doc, {
      start: 0,
      firstSize: first.nodeSize,
      secondSize: second.nodeSize,
    });
    const found = remapped.find();
    expect(found).toHaveLength(1);
    // 範囲外なので位置不変。
    expect({ from: found[0].from, to: found[0].to }).toEqual({
      from: 11,
      to: 14,
    });
    editor.destroy();
  });
});

describe("remapCodexDecosForInlinePermutation", () => {
  it("段落内 2 範囲 swap で装飾を新位置へ移す", () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>foobarbaz</p>",
    });
    const doc = editor.state.doc;
    const decoSet = DecorationSet.create(doc, [
      Decoration.inline(1, 4, { class: "c-foo" }, { codexKind: "inline" }),
      Decoration.inline(7, 10, { class: "c-baz" }, { codexKind: "inline" }),
    ]);
    // foo(1-4) + bar(4-7) + baz(7-10) → bar + foo + baz 相当: foo goes after bar
    const tr = editor.state.tr.replaceWith(
      1,
      10,
      doc
        .slice(4, 7)
        .content.append(doc.slice(1, 4).content)
        .append(doc.slice(7, 10).content),
    );
    const remapped = remapCodexDecosForInlinePermutation(decoSet, tr.doc, {
      kind: "inlinePermutation",
      segments: [
        { oldFrom: 1, oldTo: 4, newFrom: 4, newTo: 7 },
        { oldFrom: 4, oldTo: 7, newFrom: 1, newTo: 4 },
        { oldFrom: 7, oldTo: 10, newFrom: 7, newTo: 10 },
      ],
    });
    const list = remapped
      .find()
      .map((d) => ({ from: d.from, to: d.to, cls: attrsClass(d) }));
    expect(list).toContainEqual({ from: 4, to: 7, cls: "c-foo" });
    expect(list).toContainEqual({ from: 7, to: 10, cls: "c-baz" });
    editor.destroy();
  });
});
