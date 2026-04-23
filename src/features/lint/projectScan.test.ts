import { describe, expect, it } from "vitest";
import { buildBlocksFromJson } from "./projectScan";

function pm(content: unknown[]): string {
  return JSON.stringify({ type: "doc", content });
}

describe("buildBlocksFromJson", () => {
  it("empty or invalid input returns no blocks", () => {
    expect(buildBlocksFromJson("")).toEqual({ blocks: [], sceneText: "" });
    expect(buildBlocksFromJson("not-json")).toEqual({
      blocks: [],
      sceneText: "",
    });
    expect(buildBlocksFromJson(pm([]))).toEqual({
      blocks: [],
      sceneText: "",
    });
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
