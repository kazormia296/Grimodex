import { describe, expect, it } from "vitest";
import { buildBlocksFromJson } from "./projectScan";

function pm(content: unknown[]): string {
  return JSON.stringify({ type: "doc", content });
}

describe("buildBlocksFromJson", () => {
  it("empty or invalid input returns no blocks", () => {
    expect(buildBlocksFromJson("")).toEqual({
      blocks: [],
      sceneText: "",
      disables: [],
    });
    expect(buildBlocksFromJson("not-json")).toEqual({
      blocks: [],
      sceneText: "",
      disables: [],
    });
    expect(buildBlocksFromJson(pm([]))).toEqual({
      blocks: [],
      sceneText: "",
      disables: [],
    });
  });

  it("extracts block-level lintDisabled attribute as a directive", () => {
    const json = pm([
      {
        type: "paragraph",
        attrs: { lintDisabled: ["ja/ellipsis-single"] },
        content: [{ type: "text", text: "hello" }],
      },
    ]);
    const { disables } = buildBlocksFromJson(json);
    expect(disables).toEqual([
      { rules: ["ja/ellipsis-single"], range: { start: 0, end: 5 } },
    ]);
  });

  it("ignores block-level lintDisabled when block text is empty", () => {
    const json = pm([
      {
        type: "paragraph",
        attrs: { lintDisabled: ["*"] },
        content: [],
      },
    ]);
    const { disables } = buildBlocksFromJson(json);
    expect(disables).toEqual([]);
  });

  it("extracts inline lintDisable mark as a directive", () => {
    const json = pm([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "pre " },
          {
            type: "text",
            text: "silenced",
            marks: [
              { type: "lintDisable", attrs: { rules: ["ja/dash-single"] } },
            ],
          },
          { type: "text", text: " post" },
        ],
      },
    ]);
    const { disables } = buildBlocksFromJson(json);
    expect(disables).toEqual([
      { rules: ["ja/dash-single"], range: { start: 4, end: 12 } },
    ]);
  });

  it("merges adjacent lintDisable marks with matching rules", () => {
    const json = pm([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "foo",
            marks: [{ type: "lintDisable", attrs: { rules: ["*"] } }],
          },
          {
            type: "text",
            text: "bar",
            marks: [{ type: "lintDisable", attrs: { rules: ["*"] } }],
          },
        ],
      },
    ]);
    const { disables } = buildBlocksFromJson(json);
    expect(disables).toEqual([{ rules: ["*"], range: { start: 0, end: 6 } }]);
  });

  it("keeps adjacent lintDisable marks separate when rules differ", () => {
    const json = pm([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "foo",
            marks: [{ type: "lintDisable", attrs: { rules: ["ja/a"] } }],
          },
          {
            type: "text",
            text: "bar",
            marks: [{ type: "lintDisable", attrs: { rules: ["ja/b"] } }],
          },
        ],
      },
    ]);
    const { disables } = buildBlocksFromJson(json);
    expect(disables).toEqual([
      { rules: ["ja/a"], range: { start: 0, end: 3 } },
      { rules: ["ja/b"], range: { start: 3, end: 6 } },
    ]);
  });

  it("extracts a single paragraph", () => {
    const json = pm([
      { type: "paragraph", content: [{ type: "text", text: "こんにちは" }] },
    ]);
    const { blocks, sceneText } = buildBlocksFromJson(json);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "paragraph",
      text: "こんにちは",
      str_offset_start: 0,
    });
    expect(sceneText).toBe("こんにちは");
  });

  it("joins blocks with a separator offset", () => {
    const json = pm([
      { type: "paragraph", content: [{ type: "text", text: "ab" }] },
      { type: "paragraph", content: [{ type: "text", text: "cd" }] },
    ]);
    const { blocks, sceneText } = buildBlocksFromJson(json);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].str_offset_start).toBe(0);
    // "ab" (2 UTF-16) + 1 separator = 3
    expect(blocks[1].str_offset_start).toBe(3);
    expect(sceneText).toBe("ab\ncd");
  });

  it("skips codeBlock / image / horizontalRule", () => {
    const json = pm([
      { type: "paragraph", content: [{ type: "text", text: "a" }] },
      { type: "codeBlock", content: [{ type: "text", text: "SKIP" }] },
      { type: "image" },
      { type: "paragraph", content: [{ type: "text", text: "b" }] },
    ]);
    const { blocks } = buildBlocksFromJson(json);
    expect(blocks.map((b) => b.text)).toEqual(["a", "b"]);
  });

  it("listItem > paragraph treats listItem as passthrough", () => {
    // Nested blocks: the outer listItem should not emit its own block;
    // the inner paragraph carries the text and offsets.
    const json = pm([
      {
        type: "listItem",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      },
    ]);
    const { blocks } = buildBlocksFromJson(json);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("paragraph");
    expect(blocks[0].text).toBe("hello");
  });

  it("heading kind carried through", () => {
    const json = pm([
      { type: "heading", content: [{ type: "text", text: "章タイトル" }] },
    ]);
    const { blocks } = buildBlocksFromJson(json);
    expect(blocks[0].kind).toBe("heading");
  });
});
