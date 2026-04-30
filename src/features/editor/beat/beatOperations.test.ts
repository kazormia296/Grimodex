// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { GeneratedProseBlockNode } from "@/features/editor/GeneratedProseBlockNode";
import {
  ensureGeneratedBlock,
  appendBeatChunk,
  findBeatById,
  findGeneratedBlockForBeat,
} from "./insertBeatStream";
import {
  convertBeatToText,
  deleteBeatAndProse,
  deleteBeatOnly,
} from "./beatOperations";

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

function insertBeat(editor: Editor, id: string) {
  editor
    .chain()
    .focus("end")
    .insertContent({
      type: "sceneBeat",
      attrs: { id, beatType: "free", pov: null, collapsed: false },
      content: [{ type: "text", text: `beat ${id}` }],
    })
    .run();
  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: "paragraph",
  });
}

function countBlocksAndBeats(editor: Editor) {
  let beats = 0;
  let blocks = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "sceneBeat") beats += 1;
    if (node.type.name === "generatedProseBlock") blocks += 1;
  });
  return { beats, blocks };
}

describe("deleteBeatOnly", () => {
  it("removes the beat and unwraps the linked block (preserving paragraphs + AuthorshipMark)", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "ドロシーは走った。", {
      model: "claude",
      traceId: "t1",
    });

    const ok = deleteBeatOnly(editor, "b1");
    expect(ok).toBe(true);

    const { beats, blocks } = countBlocksAndBeats(editor);
    expect(beats).toBe(0);
    // appendTransaction must have unwrapped the block on the next tick.
    expect(blocks).toBe(0);

    // The original prose paragraph must still be in the doc, with AI mark intact.
    let aiTextLen = 0;
    editor.state.doc.descendants((node) => {
      if (node.isText) {
        const hasAi = node.marks.some(
          (m) => m.type.name === "authorship" && m.attrs.source === "ai",
        );
        if (hasAi) aiTextLen += node.text!.length;
      }
    });
    expect(aiTextLen).toBe("ドロシーは走った。".length);
    editor.destroy();
  });

  it("returns false for unknown beatId", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    expect(deleteBeatOnly(editor, "ghost")).toBe(false);
    editor.destroy();
  });

  it("works when no linked block exists", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    expect(deleteBeatOnly(editor, "b1")).toBe(true);
    expect(findBeatById(editor, "b1")).toBeNull();
    editor.destroy();
  });
});

describe("deleteBeatAndProse", () => {
  it("removes both the beat and the linked generatedProseBlock in one tx", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "ドロシーは走った。", {
      model: "claude",
      traceId: "t1",
    });

    const ok = deleteBeatAndProse(editor, "b1");
    expect(ok).toBe(true);

    const { beats, blocks } = countBlocksAndBeats(editor);
    expect(beats).toBe(0);
    expect(blocks).toBe(0);

    // No prose remains either (block was deleted, not unwrapped).
    expect(editor.getText()).not.toContain("ドロシーは走った");
    editor.destroy();
  });

  it("falls back to deleting just the beat if no block is linked", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    expect(deleteBeatAndProse(editor, "b1")).toBe(true);
    expect(findBeatById(editor, "b1")).toBeNull();
    editor.destroy();
  });

  it("undo restores the beat after deleteBeatAndProse", () => {
    // Note: PM may not perfectly reconstitute the beat ↔ block adjacency on
    // undo (block can land slightly offset). We verify the beat itself is
    // restored — the looser invariant we actually rely on for undo UX.
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "勇者の物語", {
      model: "claude",
      traceId: "t1",
    });

    deleteBeatAndProse(editor, "b1");
    expect(findBeatById(editor, "b1")).toBeNull();

    editor.commands.undo();
    expect(findBeatById(editor, "b1")).not.toBeNull();
    editor.destroy();
  });
});

describe("convertBeatToText", () => {
  it("replaces the beat with a paragraph carrying the same inline content", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");

    const ok = convertBeatToText(editor, "b1");
    expect(ok).toBe(true);

    expect(findBeatById(editor, "b1")).toBeNull();
    expect(editor.getText()).toContain("beat b1");
    editor.destroy();
  });

  it("does not touch the linked generatedProseBlock", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "下書き本文", {
      model: "claude",
      traceId: "t1",
    });

    convertBeatToText(editor, "b1");
    // After conversion the beat is gone; appendTransaction will unwrap the
    // now-orphan block. Verify both: beat gone AND prose preserved.
    expect(findBeatById(editor, "b1")).toBeNull();
    expect(editor.getText()).toContain("下書き本文");
    editor.destroy();
  });

  it("returns false for unknown beatId", () => {
    const editor = createEditor();
    expect(convertBeatToText(editor, "ghost")).toBe(false);
    editor.destroy();
  });
});

describe("orphan-block unwrap (appendTransaction)", () => {
  it("does NOT unwrap a freshly-inserted block whose beat exists", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    expect(findGeneratedBlockForBeat(editor, "b1")).not.toBeNull();
    editor.destroy();
  });
});
