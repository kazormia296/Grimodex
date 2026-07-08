/**
 * 空白・改行可視化の幾何 (実 Chromium)。
 * happy-dom は break-word 折り返し・position:relative inline の行ボックス
 * 生成を計算しないため、幻の改行・グリフ位置ずれは browser test で gate する。
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { createShowInvisiblesPlugin } from "./ShowInvisiblesPlugin";

const invisiblesExtension = Extension.create({
  name: "invisiblesTest",
  addProseMirrorPlugins() {
    return [createShowInvisiblesPlugin()];
  },
});

interface MountOptions {
  withPlugin?: boolean;
  vertical?: boolean;
}

function mount(
  content: unknown,
  options: MountOptions = {},
): { el: HTMLElement; editor: Editor } {
  const { withPlugin = true, vertical = false } = options;
  const wrapper = document.createElement("div");
  wrapper.className = [
    "editor-show-invisibles",
    vertical ? "editor-vertical" : "",
  ]
    .filter(Boolean)
    .join(" ");
  wrapper.style.cssText = vertical
    ? "width:500px;height:400px;padding:48px;font-size:16px;line-height:1.6;font-family:serif;overflow:auto"
    : "width:320px;padding:24px;font-size:16px;line-height:1.6;font-family:serif";
  document.body.appendChild(wrapper);

  const mountEl = document.createElement("div");
  wrapper.appendChild(mountEl);

  const extensions = [StarterKit];
  if (withPlugin) extensions.push(invisiblesExtension);

  const editor = new Editor({
    element: mountEl,
    extensions,
    content: content as never,
  });
  return { el: wrapper, editor };
}

function longWordDoc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const LONG_WORD = "あ".repeat(40);

describe("空白・改行可視化の幾何", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("空白マーク有り段落が素の段落より高くならない（幻の改行なし）", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: `${LONG_WORD} ${LONG_WORD}` }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: `${LONG_WORD}${LONG_WORD}` }],
        },
      ],
    };
    const { el, editor } = mount(doc);
    cleanups.push(() => {
      editor.destroy();
      el.remove();
    });

    const ps = el.querySelectorAll(".tiptap > p");
    const withSpace = (ps[0] as HTMLElement).getBoundingClientRect();
    const plain = (ps[1] as HTMLElement).getBoundingClientRect();
    expect(plain.height).toBeGreaterThan(30);
    expect(withSpace.height).toBeLessThanOrEqual(plain.height + 1);
  });

  it("段落末 ¶ が本文の次行に単独行として落ちない", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: LONG_WORD }],
        },
      ],
    };
    const withInvisibles = mount(doc, { withPlugin: true });
    const plain = mount(doc, { withPlugin: false });
    cleanups.push(() => {
      withInvisibles.editor.destroy();
      withInvisibles.el.remove();
      plain.editor.destroy();
      plain.el.remove();
    });

    const markedP = withInvisibles.el.querySelector(
      ".tiptap > p",
    ) as HTMLElement;
    const plainP = plain.el.querySelector(".tiptap > p") as HTMLElement;
    const markedRect = markedP.getBoundingClientRect();
    const plainRect = plainP.getBoundingClientRect();
    expect(plainRect.height).toBeGreaterThan(30);
    expect(markedRect.height).toBeLessThanOrEqual(plainRect.height + 1);
    expect(withInvisibles.el.querySelector(".pm-ws-para-end")).toBeTruthy();
  });

  it("hardBreak 前の ↵ ウィジェットが余分な行を生まない", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "一行目" },
            { type: "hardBreak" },
            { type: "text", text: "二行目" },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "一行目" },
            { type: "hardBreak" },
            { type: "text", text: "二行目" },
          ],
        },
      ],
    };
    const { el, editor } = mount(doc);
    cleanups.push(() => {
      editor.destroy();
      el.remove();
    });

    const ps = el.querySelectorAll(".tiptap > p");
    const withPlugin = (ps[0] as HTMLElement).getBoundingClientRect();
    const plain = (ps[1] as HTMLElement).getBoundingClientRect();
    expect(withPlugin.height).toBeLessThanOrEqual(plain.height + 1);
  });

  it("空白グリフ (·) が空白文字の矩形内に収まる", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "あ い" }],
        },
      ],
    };
    const { el, editor } = mount(doc);
    cleanups.push(() => {
      editor.destroy();
      el.remove();
    });

    const spaceSpan = el.querySelector(".pm-ws-space") as HTMLElement;
    expect(spaceSpan).toBeTruthy();
    const spanRect = spaceSpan.getBoundingClientRect();
    // ::before オーバレイは span の inline-size 内に描かれる想定
    expect(spanRect.width).toBeGreaterThan(0);
    expect(spanRect.width).toBeLessThan(20);
  });

  it("縦書き: 段落末 ¶ が幻の改行(余分な列)を作らない", () => {
    const doc = longWordDoc(LONG_WORD);
    const withInvisibles = mount(doc, { withPlugin: true, vertical: true });
    const plain = mount(doc, { withPlugin: false, vertical: true });
    cleanups.push(() => {
      withInvisibles.editor.destroy();
      withInvisibles.el.remove();
      plain.editor.destroy();
      plain.el.remove();
    });

    const markedP = withInvisibles.el.querySelector(
      ".tiptap > p",
    ) as HTMLElement;
    const plainP = plain.el.querySelector(".tiptap > p") as HTMLElement;
    const markedRect = markedP.getBoundingClientRect();
    const plainRect = plainP.getBoundingClientRect();
    expect(plainRect.width).toBeGreaterThan(30);
    expect(markedRect.width).toBeLessThanOrEqual(plainRect.width + 1);
    expect(withInvisibles.el.querySelector(".pm-ws-para-end")).toBeTruthy();
  });

  it("縦書き: 空白マークが幻の改行(余分な列)を作らない", () => {
    const spaced = longWordDoc(`${LONG_WORD} ${LONG_WORD}`);
    const plain = longWordDoc(`${LONG_WORD}${LONG_WORD}`);
    const doc = {
      type: "doc",
      content: [...spaced.content, ...plain.content],
    };
    const { el, editor } = mount(doc, { vertical: true });
    cleanups.push(() => {
      editor.destroy();
      el.remove();
    });

    const ps = el.querySelectorAll(".tiptap > p");
    const withSpace = (ps[0] as HTMLElement).getBoundingClientRect();
    const noSpace = (ps[1] as HTMLElement).getBoundingClientRect();
    expect(noSpace.width).toBeGreaterThan(30);
    expect(withSpace.width).toBeLessThanOrEqual(noSpace.width + 1);
  });
});
