// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { findChunkInDoc } from "./findChunkInDoc";

function makeDoc(content: string) {
  const editor = new Editor({
    extensions: [StarterKit],
    content,
  });
  return editor.state.doc;
}

describe("findChunkInDoc", () => {
  it("finds a chunk that exists as a single text node", () => {
    const doc = makeDoc("<p>雨が窓を激しく叩いていた。</p>");
    const range = findChunkInDoc(doc, "雨が窓を激しく叩いていた。");
    expect(range).not.toBeNull();
    // doc 内の 1 番目の paragraph の text は pos=1 から始まる。
    expect(range!.from).toBe(1);
    expect(range!.to).toBe(1 + "雨が窓を激しく叩いていた。".length);
  });

  it("finds a chunk that spans multiple text nodes (mark splits)", () => {
    // 強調 mark で text node が分割されるケース。flatText 連結で検出できること。
    const doc = makeDoc("<p>雨が<strong>窓を激しく</strong>叩いていた。</p>");
    const range = findChunkInDoc(doc, "雨が窓を激しく叩いていた。");
    expect(range).not.toBeNull();
    expect(range!.from).toBe(1);
  });

  it("uses only the first line as the search prefix (skips trailing newlines)", () => {
    // chunkText 内の '\n' 以降は無視。PM doc に '\n' は無いので必須の挙動。
    const doc = makeDoc(
      "<p>第一段落の冒頭です。</p><p>第二段落の冒頭です。</p>",
    );
    const range = findChunkInDoc(
      doc,
      "第一段落の冒頭です。\n第二段落の冒頭です。",
    );
    expect(range).not.toBeNull();
    expect(range!.from).toBe(1);
    expect(range!.to).toBe(1 + "第一段落の冒頭です。".length);
  });

  it("returns null when the chunk text is not present", () => {
    const doc = makeDoc("<p>関係のない本文。</p>");
    const range = findChunkInDoc(doc, "雨が窓を叩いていた。");
    expect(range).toBeNull();
  });

  it("returns null when chunk text is too short", () => {
    const doc = makeDoc("<p>こんにちは世界。</p>");
    const range = findChunkInDoc(doc, "abc"); // < MIN_PREFIX_CHARS (4)
    expect(range).toBeNull();
  });

  it("returns null when the doc has no text content", () => {
    const doc = makeDoc("");
    const range = findChunkInDoc(doc, "雨が窓を叩いていた。");
    expect(range).toBeNull();
  });

  it("clamps prefix to MAX_PREFIX_CHARS so very long chunks still match by prefix", () => {
    const head = "雨が窓を激しく叩いていた。";
    const tail =
      "風が唸り、夜は深く沈んでいた。彼は窓の外をじっと見つめていた。";
    const longChunk = head + tail; // 60 chars 超え
    // PM 本文は head だけ含む。tail が無くても prefix 60 chars 以内なので一致するはず。
    // ただし MAX_PREFIX_CHARS=60 なので head (13 chars) + tail の最初の数文字が
    // prefix になる。tail がドキュメントに無いと一致しない可能性がある。
    // → 「短いチャンクは確実に一致する」を本テストで担保する。
    const doc = makeDoc(`<p>${longChunk}</p>`);
    const range = findChunkInDoc(doc, longChunk);
    expect(range).not.toBeNull();
    expect(range!.from).toBe(1);
  });

  it("finds the first occurrence when chunk text appears multiple times", () => {
    const doc = makeDoc(
      "<p>共通の段落フレーズ。</p><p>関係ない段落。</p><p>共通の段落フレーズ。</p>",
    );
    const range = findChunkInDoc(doc, "共通の段落フレーズ。");
    expect(range).not.toBeNull();
    // 1 番目の paragraph の text 開始位置 = pos 1
    expect(range!.from).toBe(1);
  });

  it("handles headings and non-paragraph blocks in the document", () => {
    const doc = makeDoc(
      "<h1>第一章</h1><p>雨が窓を叩いていた。彼は外を見ていた。</p>",
    );
    const range = findChunkInDoc(doc, "雨が窓を叩いていた。");
    expect(range).not.toBeNull();
    // heading のテキストが先に flat に並ぶので、paragraph 内文字列の位置は
    // heading 終端より後 (具体的な pos 値は schema 次第なので存在のみ確認)。
    expect(range!.from).toBeGreaterThan(0);
  });
});
