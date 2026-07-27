// @vitest-environment happy-dom
import { Editor, type Content } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SceneBeatNode } from "../SceneBeatNode";
import {
  buildSceneBeatIndex,
  mapSceneBeatIndex,
  placedBeatPreviewFromIndex,
  updateSceneBeatIndex,
} from "./sceneBeatIndex";
import { createSceneBeatPerformanceDocument } from "./sceneBeatPerformance.fixture";
import { transactionTouchesSceneBeat } from "./transactionTouchesSceneBeat";

const editors: Editor[] = [];

function createEditor(content?: Content): Editor {
  const editor = new Editor({
    extensions: [StarterKit, SceneBeatNode],
    content: content ?? {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "alpha" }],
        },
        {
          type: "sceneBeat",
          attrs: {
            id: "beat-1",
            collapsed: false,
            beatType: "free",
            pov: null,
          },
          content: [{ type: "text", text: "first beat" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "omega" }],
        },
      ],
    },
  });
  editors.push(editor);
  return editor;
}

function findNode(
  doc: ProseMirrorNode,
  nodeType: string,
  occurrence = 0,
): { pos: number; nodeSize: number } {
  let seen = 0;
  let result: { pos: number; nodeSize: number } | null = null;
  doc.descendants((node, pos) => {
    if (node.type.name !== nodeType || result) return true;
    if (seen === occurrence) {
      result = { pos, nodeSize: node.nodeSize };
      return false;
    }
    seen += 1;
    return true;
  });
  if (!result) throw new Error(`Missing ${nodeType} at ${occurrence}`);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("sceneBeatIndex", () => {
  it("updates one Beat preview from step ranges without a full document walk", () => {
    const editor = createEditor();
    const source = buildSceneBeatIndex(editor.state.doc);
    const beat = findNode(editor.state.doc, "sceneBeat");
    const transaction = editor.state.tr.insertText("updated ", beat.pos + 1);
    const descendants = vi.spyOn(ProseMirrorNode.prototype, "descendants");

    const update = updateSceneBeatIndex(source, transaction);

    expect(update.rebuilt).toBe(false);
    expect(update.removed).toEqual([]);
    expect(update.addedIds).toEqual([]);
    expect(placedBeatPreviewFromIndex(update.index)).toBe(
      JSON.stringify(["updated first beat"]),
    );
    expect(descendants).not.toHaveBeenCalled();
  });

  it("reports only placed membership changes for undo reconciliation", () => {
    const editor = createEditor();
    const source = buildSceneBeatIndex(editor.state.doc);
    const beat = findNode(editor.state.doc, "sceneBeat");
    const remove = editor.state.tr.delete(beat.pos, beat.pos + beat.nodeSize);

    const removed = updateSceneBeatIndex(source, remove);

    expect(removed.removed.map((snapshot) => snapshot.id)).toEqual(["beat-1"]);
    expect(removed.addedIds).toEqual([]);
    expect(placedBeatPreviewFromIndex(removed.index)).toBe("[]");

    editor.view.dispatch(remove);
    const insertedNode = editor.schema.nodes.sceneBeat.create(
      {
        id: "beat-2",
        collapsed: false,
        beatType: "summary",
        pov: "codex-1",
      },
      editor.schema.text("second beat"),
    );
    const insert = editor.state.tr.insert(
      editor.state.doc.content.size,
      insertedNode,
    );
    const added = updateSceneBeatIndex(removed.index, insert);

    expect(added.removed).toEqual([]);
    expect(added.addedIds).toEqual(["beat-2"]);
    expect(placedBeatPreviewFromIndex(added.index)).toBe(
      JSON.stringify(["second beat"]),
    );
  });

  it("maps Beat positions through ordinary prose edits for a later Beat edit", () => {
    const editor = createEditor();
    const source = buildSceneBeatIndex(editor.state.doc);
    const paragraph = findNode(editor.state.doc, "paragraph");
    const proseEdit = editor.state.tr.insertText("prefix ", paragraph.pos + 1);

    expect(transactionTouchesSceneBeat(proseEdit)).toBe(false);
    const mapped = mapSceneBeatIndex(source, proseEdit.mapping, proseEdit.doc);
    editor.view.dispatch(proseEdit);

    const beat = findNode(editor.state.doc, "sceneBeat");
    expect(mapped.byId.get("beat-1")?.pos).toBe(beat.pos);
    const beatEdit = editor.state.tr.insertText("!", beat.pos + 1);
    const update = updateSceneBeatIndex(mapped, beatEdit);
    expect(update.rebuilt).toBe(false);
    expect(placedBeatPreviewFromIndex(update.index)).toBe(
      JSON.stringify(["!first beat"]),
    );
  });

  it("keeps the 200k-character / 200-Beat dispatch fixture off descendants", () => {
    const editor = createEditor(
      createSceneBeatPerformanceDocument({
        characterCount: 200_000,
        beatCount: 200,
      }),
    );
    const source = buildSceneBeatIndex(editor.state.doc);
    const paragraph = findNode(editor.state.doc, "paragraph");
    const transaction = editor.state.tr.insertText("!", paragraph.pos + 1);
    const descendants = vi.spyOn(ProseMirrorNode.prototype, "descendants");

    expect(transactionTouchesSceneBeat(transaction)).toBe(false);
    const mapped = mapSceneBeatIndex(
      source,
      transaction.mapping,
      transaction.doc,
    );

    expect(mapped.byId).toHaveLength(200);
    expect(descendants).not.toHaveBeenCalled();
  });
});
