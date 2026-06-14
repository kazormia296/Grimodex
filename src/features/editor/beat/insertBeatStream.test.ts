// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { createAiEditedPlugin } from "@/features/attribution/AiEditedPlugin";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import {
  appendBeatChunk,
  ensureGeneratedBlock,
  findBeatById,
  findGeneratedBlockForBeat,
} from "./insertBeatStream";

/**
 * `withAiEditedPlugin` mirrors EditorPane's runtime, where useAttribution()
 * registers AiEditedPlugin. Chunks that don't tag programmaticInsert get
 * their AuthorshipMark stripped by that plugin.
 */
function createEditor(content = "", { withAiEditedPlugin = false } = {}) {
  const editor = new Editor({
    extensions: [
      StarterKit,
      AuthorshipMark,
      SceneBeatNode,
      GeneratedProseBlockNode,
    ],
    content,
  });
  if (withAiEditedPlugin) {
    editor.registerPlugin(createAiEditedPlugin());
  }
  return editor;
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
  it("inserts AI-marked text into the linked block and returns true", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");

    const ok = appendBeatChunk(editor, "b1", "ドロシーは", {
      model: "claude",
      traceId: "t1",
    });
    expect(ok).toBe(true);

    const block = findGeneratedBlockForBeat(editor, "b1");
    const blockNode = editor.state.doc.nodeAt(block!.blockPos);
    expect(blockNode!.textContent).toBe("ドロシーは");

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
    expect(blockNode?.attrs.modified).toBe(false);
    editor.destroy();
  });

  it("creates a new paragraph inside the block on \\n", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "first\nsecond", {
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

  it("preserves AuthorshipMark='ai' across multiple chunks even when AiEditedPlugin is active (regression)", () => {
    // Without programmaticInsert=true on the chunk transactions, AiEditedPlugin
    // would strip the AuthorshipMark from chunks 2..N (they land inside the
    // AI-marked span produced by chunk 1), making them render as "human".
    const editor = createEditor("", { withAiEditedPlugin: true });
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "Hello, ", {
      model: "claude",
      traceId: "t1",
    });
    appendBeatChunk(editor, "b1", "world.", { model: "claude", traceId: "t1" });
    appendBeatChunk(editor, "b1", " Again.", {
      model: "claude",
      traceId: "t1",
    });

    const block = findGeneratedBlockForBeat(editor, "b1");
    const blockNode = editor.state.doc.nodeAt(block!.blockPos);
    expect(blockNode?.textContent).toBe("Hello, world. Again.");

    let aiTextLen = 0;
    blockNode!.descendants((node) => {
      if (node.isText) {
        const hasAi = node.marks.some(
          (m) => m.type.name === "authorship" && m.attrs.source === "ai",
        );
        if (hasAi) aiTextLen += node.text!.length;
      }
    });
    // EVERY character should remain AI-attributed.
    expect(aiTextLen).toBe("Hello, world. Again.".length);
    editor.destroy();
  });

  it("appends across multiple chunks accumulating into the same paragraph", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "Hello, ", {
      model: "claude",
      traceId: "t1",
    });
    appendBeatChunk(editor, "b1", "world.", { model: "claude", traceId: "t1" });

    const block = findGeneratedBlockForBeat(editor, "b1");
    const blockNode = editor.state.doc.nodeAt(block!.blockPos);
    expect(blockNode?.textContent).toBe("Hello, world.");
    expect(blockNode?.childCount).toBe(1);
    expect(blockNode?.attrs.modified).toBe(false);
    editor.destroy();
  });

  it("re-locates the block on every call, surviving an upstream edit between chunks", () => {
    // Drift case: user types into the leading paragraph between chunks.
    const editor = createEditor("<p>opener</p>");
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "first ", { model: "claude", traceId: "t1" });

    // Insert plain text near the start of the doc (position 1 is inside <p>opener</p>).
    editor.commands.insertContentAt(1, "X");

    appendBeatChunk(editor, "b1", "second", { model: "claude", traceId: "t1" });

    const block = findGeneratedBlockForBeat(editor, "b1");
    const blockNode = editor.state.doc.nodeAt(block!.blockPos);
    // Both chunks should land in the block, regardless of the upstream edit.
    expect(blockNode?.textContent).toBe("first second");
    expect(blockNode?.attrs.modified).toBe(false);
    editor.destroy();
  });

  it("returns false when the linked block has been removed (orphan stream)", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "first", { model: "claude", traceId: "t1" });

    // Simulate the beat (and its linked block) being deleted mid-stream.
    editor.commands.clearContent();

    const ok = appendBeatChunk(editor, "b1", "second", {
      model: "claude",
      traceId: "t1",
    });
    expect(ok).toBe(false);
    editor.destroy();
  });

  it("returns false when only the beat is deleted but the block lingers", () => {
    // Edge case: user removes the beat node directly. findGeneratedBlockForBeat
    // requires the beat to be the immediate previous sibling, so this orphans.
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");

    const beat = findBeatById(editor, "b1");
    const tr = editor.state.tr;
    tr.delete(beat!.beatPos, beat!.beatPos + beat!.beatSize);
    editor.view.dispatch(tr);

    const ok = appendBeatChunk(editor, "b1", "x", {
      model: "claude",
      traceId: "t1",
    });
    expect(ok).toBe(false);
    editor.destroy();
  });

  it("merges streamed chunks into a single AI span when they share a timestamp (regression: 1–2 char fragmentation)", () => {
    // Real callers pass one timestamp per generation. With identical mark attrs
    // ProseMirror joins the adjacent text nodes, so a beat is one authorship
    // span — not one tiny span per streamed chunk.
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    const ts = "2026-06-14T00:00:00.000Z";
    for (const ch of ["あ", "い", "うえ", "お"]) {
      appendBeatChunk(editor, "b1", ch, {
        model: "claude",
        traceId: "t1",
        timestamp: ts,
      });
    }

    const block = findGeneratedBlockForBeat(editor, "b1");
    const blockNode = editor.state.doc.nodeAt(block!.blockPos);
    expect(blockNode?.textContent).toBe("あいうえお");

    let aiTextNodes = 0;
    blockNode!.descendants((node) => {
      if (
        node.isText &&
        node.marks.some(
          (m) => m.type.name === "authorship" && m.attrs.source === "ai",
        )
      ) {
        aiTextNodes += 1;
      }
    });
    expect(aiTextNodes).toBe(1);
    editor.destroy();
  });
});
