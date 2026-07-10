// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  createWebKitFocusScrollGuard,
  shouldSuppressScrollToSelection,
} from "./webkitFocusScrollGuard";

vi.mock("@/lib/platform", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/platform")>();
  return { ...mod, isWebKitGtk: () => mockWebKitGtk };
});
let mockWebKitGtk = true;

function makeEditor(content: unknown): Editor {
  return new Editor({
    extensions: [StarterKit],
    content: content as never,
  });
}

const PARA_DOC = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "本文テキスト" }] },
  ],
};

// 先頭が blockquote の doc — 最初のカーソル可能位置は 1 ではなく 2 になる
const BLOCKQUOTE_DOC = {
  type: "doc",
  content: [
    {
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "引用で始まる本文" }],
        },
      ],
    },
  ],
};

describe("shouldSuppressScrollToSelection", () => {
  const base = {
    webkitGtk: true,
    selectionEmpty: true,
    selectionFrom: 1,
    docStartPos: 1,
    msSinceFocus: 100,
  };

  it("WebKitGTK × focus 直後 × 文書先頭の空選択 → 抑止する", () => {
    expect(shouldSuppressScrollToSelection(base)).toBe(true);
    expect(shouldSuppressScrollToSelection({ ...base, selectionFrom: 0 })).toBe(
      true,
    );
  });

  it("WebKitGTK 以外では抑止しない", () => {
    expect(shouldSuppressScrollToSelection({ ...base, webkitGtk: false })).toBe(
      false,
    );
  });

  it("focus 窓 (250ms) を過ぎたら抑止しない — Ctrl+Home 等の通常スクロールを守る", () => {
    expect(
      shouldSuppressScrollToSelection({ ...base, msSinceFocus: 250 }),
    ).toBe(false);
    expect(
      shouldSuppressScrollToSelection({ ...base, msSinceFocus: 10_000 }),
    ).toBe(false);
  });

  it("文書先頭以外の selection では抑止しない", () => {
    expect(shouldSuppressScrollToSelection({ ...base, selectionFrom: 2 })).toBe(
      false,
    );
    expect(
      shouldSuppressScrollToSelection({ ...base, selectionFrom: 500 }),
    ).toBe(false);
  });

  it("先頭が leaf/コンテナブロックの doc (docStartPos>1) でも先頭判定できる", () => {
    // blockquote 先頭の doc では最初のカーソル可能位置が 2 — PM の focus 後
    // リセット検出はこの動的位置と比較するため、ガードも合わせる。
    expect(
      shouldSuppressScrollToSelection({
        ...base,
        selectionFrom: 2,
        docStartPos: 2,
      }),
    ).toBe(true);
    // 先頭より奥は抑止しない
    expect(
      shouldSuppressScrollToSelection({
        ...base,
        selectionFrom: 3,
        docStartPos: 2,
      }),
    ).toBe(false);
  });

  it("範囲選択 (非 empty) では抑止しない", () => {
    expect(
      shouldSuppressScrollToSelection({ ...base, selectionEmpty: false }),
    ).toBe(false);
  });
});

describe("createWebKitFocusScrollGuard", () => {
  it("noteFocus からの経過時間で判定する（実 Editor の view）", () => {
    mockWebKitGtk = true;
    let now = 1000;
    const guard = createWebKitFocusScrollGuard(() => now);
    const editor = makeEditor(PARA_DOC);
    // 初期 selection は文書先頭 (from=1)

    // focus 前は抑止しない（lastFocusAt = -Infinity）
    expect(guard.handleScrollToSelection(editor.view)).toBe(false);

    guard.noteFocus();
    now = 1100; // +100ms — 窓内
    expect(guard.handleScrollToSelection(editor.view)).toBe(true);

    now = 1400; // +400ms — 窓外
    expect(guard.handleScrollToSelection(editor.view)).toBe(false);

    editor.destroy();
  });

  it("blockquote 先頭の doc でも先頭 selection を抑止できる", () => {
    mockWebKitGtk = true;
    let now = 1000;
    const guard = createWebKitFocusScrollGuard(() => now);
    const editor = makeEditor(BLOCKQUOTE_DOC);
    // 初期 selection = Selection.atStart = blockquote 内段落頭 (from=2)
    expect(editor.state.selection.from).toBeGreaterThan(1);

    guard.noteFocus();
    now = 1100;
    expect(guard.handleScrollToSelection(editor.view)).toBe(true);

    editor.destroy();
  });

  it("文書途中の selection では抑止しない", () => {
    mockWebKitGtk = true;
    let now = 1000;
    const guard = createWebKitFocusScrollGuard(() => now);
    const editor = makeEditor(PARA_DOC);
    editor.commands.setTextSelection(4);

    guard.noteFocus();
    now = 1100;
    expect(guard.handleScrollToSelection(editor.view)).toBe(false);

    editor.destroy();
  });

  it("WebKitGTK 以外では常に false（PM 既定のスクロールに任せる）", () => {
    mockWebKitGtk = false;
    let now = 1000;
    const guard = createWebKitFocusScrollGuard(() => now);
    const editor = makeEditor(PARA_DOC);
    guard.noteFocus();
    now = 1100;
    expect(guard.handleScrollToSelection(editor.view)).toBe(false);
    mockWebKitGtk = true;
    editor.destroy();
  });
});
