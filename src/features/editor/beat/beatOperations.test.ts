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
  clearBeatContent,
  convertBeatToText,
  deleteBeatAndProse,
  deleteBeatOnly,
  moveBeatToPosition,
  replaceBeatBlock,
  unplaceBeat,
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

describe("replaceBeatBlock", () => {
  it("既存の generatedProseBlock を空ブロックに差し替える", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "生成テキスト", {
      model: "test",
      traceId: "t1",
    });
    expect(editor.getText()).toContain("生成テキスト");

    const result = replaceBeatBlock(editor, "b1");
    expect(result).toBe(true);
    // 生成テキストが消えている
    expect(editor.getText()).not.toContain("生成テキスト");
    // ブロックは残っている
    expect(findGeneratedBlockForBeat(editor, "b1")).not.toBeNull();
  });

  it("generatedProseBlock がない場合は false を返す", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    expect(replaceBeatBlock(editor, "b1")).toBe(false);
    editor.destroy();
  });

  it("差し替え後のブロックは modified=false", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");

    replaceBeatBlock(editor, "b1");

    let modified: boolean | null = null;
    editor.state.doc.descendants((node) => {
      if (
        node.type.name === "generatedProseBlock" &&
        node.attrs.beatId === "b1"
      ) {
        modified = node.attrs.modified as boolean;
      }
    });
    expect(modified).toBe(false);
    editor.destroy();
  });
});

describe("placeBeatAtEnd", () => {
  it("Unplaced beat をドキュメント末尾に挿入しストアから削除する", async () => {
    const { useUnplacedBeatsStore } = await import("./unplacedBeatsStore");
    useUnplacedBeatsStore.setState({ sceneBeats: {} });

    const { placeBeatAtEnd } = await import("./beatOperations");

    const editor = createEditor();
    // Unplaced beat をストアに追加
    useUnplacedBeatsStore.getState().addBeat("scene1", {
      id: "u1",
      beatType: "free",
      pov: null,
      collapsed: false,
      content: [{ type: "text", text: "ドラゴンが現れる" }],
    });
    expect(useUnplacedBeatsStore.getState().getBeats("scene1")).toHaveLength(1);

    const result = placeBeatAtEnd(editor, "scene1", {
      id: "u1",
      beatType: "free",
      pov: null,
      collapsed: false,
      content: [{ type: "text", text: "ドラゴンが現れる" }],
    });
    expect(result).toBe(true);

    // beat が doc に挿入されている
    const { beats } = countBlocksAndBeats(editor);
    expect(beats).toBe(1);

    // ストアから削除されている
    expect(useUnplacedBeatsStore.getState().getBeats("scene1")).toHaveLength(0);

    // beat の attrs が保持されている
    let placedId: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "sceneBeat") placedId = node.attrs.id as string;
    });
    expect(placedId).toBe("u1");

    editor.destroy();
  });

  it("pov と beatType が保持される", async () => {
    const { placeBeatAtEnd } = await import("./beatOperations");
    const editor = createEditor();

    placeBeatAtEnd(editor, "scene1", {
      id: "u2",
      beatType: "dialogue",
      pov: "char-1",
      collapsed: false,
      content: [],
    });

    let beatType: string | null = null;
    let pov: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "sceneBeat") {
        beatType = node.attrs.beatType as string;
        pov = node.attrs.pov as string;
      }
    });
    expect(beatType).toBe("dialogue");
    expect(pov).toBe("char-1");
    editor.destroy();
  });
});

describe("clearBeatContent", () => {
  it("生成済みブロックを含む beat の直後コンテンツをすべて削除する", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "生成テキスト", {
      model: "test",
      traceId: "t1",
    });

    const ok = clearBeatContent(editor, "b1");
    expect(ok).toBe(true);

    expect(findBeatById(editor, "b1")).not.toBeNull();
    expect(editor.getText()).not.toContain("生成テキスト");
    editor.destroy();
  });

  it("次の beat の手前まで削除し次 beat は残す", () => {
    const editor = createEditor();
    insertBeat(editor, "b1");
    ensureGeneratedBlock(editor, "b1");
    appendBeatChunk(editor, "b1", "テキスト1", {
      model: "test",
      traceId: "t1",
    });
    insertBeat(editor, "b2");
    ensureGeneratedBlock(editor, "b2");
    appendBeatChunk(editor, "b2", "テキスト2", {
      model: "test",
      traceId: "t2",
    });

    clearBeatContent(editor, "b1");

    expect(findBeatById(editor, "b1")).not.toBeNull();
    expect(findBeatById(editor, "b2")).not.toBeNull();
    expect(editor.getText()).not.toContain("テキスト1");
    expect(editor.getText()).toContain("テキスト2");
    editor.destroy();
  });

  it("beat が存在しない場合は false を返す", () => {
    const editor = createEditor();
    expect(clearBeatContent(editor, "ghost")).toBe(false);
    editor.destroy();
  });
});

describe("unplaceBeat", () => {
  it("beat をドキュメントから削除し Unplaced ストアに追加する", async () => {
    const { useUnplacedBeatsStore } = await import("./unplacedBeatsStore");
    useUnplacedBeatsStore.setState({ sceneBeats: {} });

    const editor = createEditor();
    insertBeat(editor, "b1");
    expect(countBlocksAndBeats(editor).beats).toBe(1);

    const result = unplaceBeat(editor, "b1", "scene1");
    expect(result).toBe(true);
    expect(countBlocksAndBeats(editor).beats).toBe(0);

    const stored = useUnplacedBeatsStore.getState().getBeats("scene1");
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe("b1");
    editor.destroy();
  });

  it("存在しない beatId に対しては false を返す", async () => {
    const editor = createEditor();
    const result = unplaceBeat(editor, "ghost", "scene1");
    expect(result).toBe(false);
    editor.destroy();
  });
});

describe("moveBeatToPosition", () => {
  it("存在しない beatId は false を返す", () => {
    const editor = createEditor();
    expect(moveBeatToPosition(editor, "ghost", 0)).toBe(false);
    editor.destroy();
  });

  it("beat を前方に移動する", () => {
    const editor = createEditor();
    // para → beat1 → para → beat2
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first" }] },
        insertBeatJson("b1"),
        { type: "paragraph", content: [{ type: "text", text: "middle" }] },
        insertBeatJson("b2"),
        { type: "paragraph", content: [{ type: "text", text: "last" }] },
      ],
    });

    // Position 0 = before first paragraph
    const result = moveBeatToPosition(editor, "b2", 0);
    expect(result).toBe(true);

    // b2 should now appear before b1
    const ids: string[] = [];
    editor.state.doc.descendants((n) => {
      if (n.type.name === "sceneBeat") ids.push(n.attrs.id as string);
    });
    expect(ids[0]).toBe("b2");
    expect(ids[1]).toBe("b1");
    editor.destroy();
  });

  it("beat を後方に移動する", () => {
    const editor = createEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        insertBeatJson("b1"),
        { type: "paragraph", content: [{ type: "text", text: "between" }] },
        insertBeatJson("b2"),
      ],
    });

    // Find b2 end position and move b1 after b2
    let b2End = -1;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === "sceneBeat" && n.attrs.id === "b2") {
        b2End = pos + n.nodeSize;
      }
    });
    expect(b2End).toBeGreaterThan(0);

    const result = moveBeatToPosition(editor, "b1", b2End);
    expect(result).toBe(true);

    const ids: string[] = [];
    editor.state.doc.descendants((n) => {
      if (n.type.name === "sceneBeat") ids.push(n.attrs.id as string);
    });
    expect(ids[0]).toBe("b2");
    expect(ids[1]).toBe("b1");
    editor.destroy();
  });
});

function insertBeatJson(id: string) {
  return {
    type: "sceneBeat",
    attrs: { id, beatType: "free", collapsed: false, pov: null, model: null },
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: `Beat ${id}` }],
      },
    ],
  };
}
