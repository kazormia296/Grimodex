// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import {
  appendBeatChunk,
  ensureGeneratedBlock,
  findBeatById,
  findGeneratedBlockForBeat,
  startBeatStream,
} from "./insertBeatStream";

function createEditor(content = "") {
  return new Editor({
    extensions: [
      StarterKit,
      AuthorshipMark,
      SceneBeatNode,
      GeneratedProseBlockNode,
    ],
    content,
  });
}

function insertBeat(editor: Editor, id: string, paragraphAfter = true) {
  editor
    .chain()
    .focus()
    .insertContent({
      type: "sceneBeat",
      attrs: { id, beatType: "free", pov: null, collapsed: false },
      content: [{ type: "text", text: `beat ${id}` }],
    })
    .run();
  if (paragraphAfter) {
    // Append a trailing paragraph so the beat isn't the last node.
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "paragraph",
    });
  }
}

describe("findBeatById", () => {
  it("returns position + size of the matching sceneBeat", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    const found = findBeatById(editor, "b1");
    expect(found).not.toBeNull();
    expect(found!.beatPos).toBeGreaterThanOrEqual(0);
    expect(found!.beatSize).toBeGreaterThan(2); // at least open + content + close
    editor.destroy();
  });

  it("returns null for unknown id", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    expect(findBeatById(editor, "missing")).toBeNull();
    editor.destroy();
  });
});

describe("ensureGeneratedBlock", () => {
  it("inserts a fresh generatedProseBlock right after the beat with one empty paragraph", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    const result = ensureGeneratedBlock(editor, "b1");
    expect(result).not.toBeNull();

    const blockNode = editor.state.doc.nodeAt(result!.blockPos);
    expect(blockNode?.type.name).toBe("generatedProseBlock");
    expect(blockNode?.attrs.beatId).toBe("b1");
    expect(blockNode?.attrs.modified).toBe(false);
    expect(blockNode?.childCount).toBe(1);
    expect(blockNode?.firstChild?.type.name).toBe("paragraph");
    editor.destroy();
  });

  it("returns the existing block instead of duplicating it", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    const first = ensureGeneratedBlock(editor, "b1");
    const second = ensureGeneratedBlock(editor, "b1");
    expect(second?.blockPos).toBe(first?.blockPos);

    let blockCount = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "generatedProseBlock") blockCount += 1;
    });
    expect(blockCount).toBe(1);
    editor.destroy();
  });

  it("returns null when the beat is missing", () => {
    const editor = createEditor();
    expect(ensureGeneratedBlock(editor, "ghost")).toBeNull();
    editor.destroy();
  });

  it("does NOT flip the new block's modified flag (creation path is AI-tagged)", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    const block = findGeneratedBlockForBeat(editor, "b1");
    const node = editor.state.doc.nodeAt(block!.blockPos);
    expect(node?.attrs.modified).toBe(false);
    editor.destroy();
  });
});

describe("appendBeatChunk", () => {
  it("inserts AI-marked text into the open block and advances the cursor", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    const cursor = startBeatStream(editor, "b1");
    expect(cursor).not.toBeNull();

    const startedAt = cursor!.insertAt;
    appendBeatChunk(editor, cursor!, "ドロシーは", {
      model: "claude",
      traceId: "t1",
    });
    expect(cursor!.insertAt).toBe(startedAt + "ドロシーは".length);

    const block = findGeneratedBlockForBeat(editor, "b1");
    const blockNode = editor.state.doc.nodeAt(block!.blockPos);
    const text = blockNode!.textContent;
    expect(text).toBe("ドロシーは");

    // Verify AuthorshipMark='ai' applied to inserted text.
    let aiTextCount = 0;
    blockNode!.descendants((node) => {
      if (node.isText) {
        const hasAi = node.marks.some(
          (m) => m.type.name === "authorship" && m.attrs.source === "ai",
        );
        if (hasAi) aiTextCount += node.text!.length;
      }
    });
    expect(aiTextCount).toBe("ドロシーは".length);

    // The block must NOT be marked modified after AI-tagged inserts.
    expect(blockNode?.attrs.modified).toBe(false);
    editor.destroy();
  });

  it("creates a new paragraph inside the block on \\n", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    const cursor = startBeatStream(editor, "b1");
    appendBeatChunk(editor, cursor!, "first\nsecond", {
      model: "claude",
      traceId: "t1",
    });

    const block = findGeneratedBlockForBeat(editor, "b1");
    const blockNode = editor.state.doc.nodeAt(block!.blockPos);
    expect(blockNode?.childCount).toBe(2);
    expect(blockNode?.child(0).textContent).toBe("first");
    expect(blockNode?.child(1).textContent).toBe("second");
    expect(blockNode?.attrs.modified).toBe(false);
    editor.destroy();
  });

  it("appends across multiple chunks accumulating into the same paragraph", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    const cursor = startBeatStream(editor, "b1");
    appendBeatChunk(editor, cursor!, "Hello, ", {
      model: "claude",
      traceId: "t1",
    });
    appendBeatChunk(editor, cursor!, "world.", {
      model: "claude",
      traceId: "t1",
    });

    const block = findGeneratedBlockForBeat(editor, "b1");
    const blockNode = editor.state.doc.nodeAt(block!.blockPos);
    expect(blockNode?.textContent).toBe("Hello, world.");
    expect(blockNode?.childCount).toBe(1);
    expect(blockNode?.attrs.modified).toBe(false);
    editor.destroy();
  });
});
