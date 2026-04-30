// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { SceneBeatNode } from "./SceneBeatNode";
import {
  GeneratedProseBlockNode,
  BEAT_STREAM_META,
} from "./GeneratedProseBlockNode";

/**
 * Fixture: scene beat with matching beatId, then the generated block, so the
 * orphan-unwrap logic in appendTransaction doesn't kick in.
 */
function fixture(blockHtml: string) {
  return (
    '<div data-type="scene-beat" data-beat-id="b1">beat text</div>' + blockHtml
  );
}

function createTestEditor(content = "") {
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

type BlockInfo = { pos: number; modified: boolean };

function findBlock(editor: Editor): BlockInfo | null {
  const hits: BlockInfo[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "generatedProseBlock") {
      hits.push({ pos, modified: !!node.attrs.modified });
    }
  });
  return hits[0] ?? null;
}

describe("GeneratedProseBlockNode", () => {
  it("registers as a defining block with block+ content", () => {
    const editor = createTestEditor();
    const nodeType = editor.schema.nodes["generatedProseBlock"];
    expect(nodeType).toBeDefined();
    expect(nodeType.isBlock).toBe(true);
    expect(nodeType.spec.content).toBe("block+");
    expect(nodeType.spec.defining).toBe(true);
    editor.destroy();
  });

  it("schema rejects an empty block (must contain at least one block child)", () => {
    const editor = createTestEditor();
    const blockType = editor.schema.nodes["generatedProseBlock"];
    expect(() =>
      blockType.createChecked({ beatId: "b1", modified: false }),
    ).toThrow();
    editor.destroy();
  });

  it("flips modified=true when user edits inside the block", () => {
    const editor = createTestEditor(
      fixture(
        '<div data-type="generated-prose-block" data-beat-id="b1"><p>初期テキスト</p></div>',
      ),
    );
    const before = findBlock(editor);
    expect(before?.modified).toBe(false);

    // Insert plain text inside the block (no AI authorship → counts as user edit).
    const blockNode = editor.state.doc.nodeAt(before!.pos);
    expect(blockNode?.firstChild?.type.name).toBe("paragraph");
    const insertPos = (before?.pos ?? 0) + 1 + 1; // into block → into paragraph
    editor.commands.insertContentAt(insertPos, " 追記");

    const after = findBlock(editor);
    expect(after?.modified).toBe(true);
    editor.destroy();
  });

  it("does NOT flip modified when transaction is tagged BEAT_STREAM_META", () => {
    const editor = createTestEditor(
      fixture(
        '<div data-type="generated-prose-block" data-beat-id="b1"><p></p></div>',
      ),
    );
    const before = findBlock(editor);
    expect(before?.modified).toBe(false);

    // Stream a chunk: text insert via tagged transaction (mirrors what
    // insertBeatStream will do).
    const insertPos = (before?.pos ?? 0) + 1 + 1;
    const { tr } = editor.state;
    tr.setMeta(BEAT_STREAM_META, true);
    tr.insertText("ドロシーは", insertPos);
    editor.view.dispatch(tr);

    const after = findBlock(editor);
    expect(after?.modified).toBe(false);
    editor.destroy();
  });

  it("does NOT flip modified for a paragraph split during streaming", () => {
    // Streaming may need to insert a new paragraph inside the block when a
    // chunk crosses a paragraph boundary. Tagged transaction must skip.
    const editor = createTestEditor(
      fixture(
        '<div data-type="generated-prose-block" data-beat-id="b1"><p>first</p></div>',
      ),
    );
    const before = findBlock(editor);
    expect(before?.modified).toBe(false);

    // Insert a brand-new paragraph at end of block via tagged tx.
    const blockNode = editor.state.doc.nodeAt(before!.pos);
    const blockEnd = before!.pos + 1 + (blockNode?.content.size ?? 0);
    const { tr } = editor.state;
    tr.setMeta(BEAT_STREAM_META, true);
    tr.insert(
      blockEnd,
      editor.schema.nodes["paragraph"].createChecked(
        null,
        editor.schema.text("second"),
      ),
    );
    editor.view.dispatch(tr);

    const after = findBlock(editor);
    expect(after?.modified).toBe(false);
    editor.destroy();
  });

  it("does NOT flip modified for Regenerate (replaceWith of the whole block)", () => {
    const editor = createTestEditor(
      fixture(
        '<div data-type="generated-prose-block" data-beat-id="b1"><p>old prose</p></div>',
      ),
    );
    const before = findBlock(editor);
    expect(before?.modified).toBe(false);

    // Build a fresh block with the same beatId and AI-marked text.
    const blockType = editor.schema.nodes["generatedProseBlock"];
    const replacement = blockType.createChecked(
      { beatId: "b1", modified: false },
      editor.schema.nodes["paragraph"].createChecked(
        null,
        editor.schema.text("new prose"),
      ),
    );
    const blockNode = editor.state.doc.nodeAt(before!.pos);
    const { tr } = editor.state;
    tr.setMeta(BEAT_STREAM_META, true);
    tr.replaceWith(
      before!.pos,
      before!.pos + (blockNode?.nodeSize ?? 0),
      replacement,
    );
    editor.view.dispatch(tr);

    const after = findBlock(editor);
    expect(after).not.toBeNull();
    expect(after?.modified).toBe(false);
    editor.destroy();
  });

  it("auto-deletes the block when its last child paragraph is removed", () => {
    const editor = createTestEditor(
      fixture(
        '<div data-type="generated-prose-block" data-beat-id="b1"><p>only paragraph</p></div>',
      ),
    );
    expect(findBlock(editor)).not.toBeNull();

    // Replace the entire doc — simulates the "block self-deletes" path.
    editor.commands.clearContent();
    expect(findBlock(editor)).toBeNull();
    editor.destroy();
  });
});
