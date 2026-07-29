// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { StepMap } from "@tiptap/pm/transform";
import { afterEach, describe, expect, it } from "vitest";
import { SceneBeatNode } from "../SceneBeatNode";
import { transactionTouchesSceneBeat } from "./transactionTouchesSceneBeat";

const editors: Editor[] = [];

function createEditor(): Editor {
  const editor = new Editor({
    extensions: [StarterKit, SceneBeatNode],
    content: {
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
          content: [{ type: "text", text: "beat text" }],
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

function findNodeAt(
  editor: Editor,
  nodeType: string,
  occurrence = 0,
): { pos: number; nodeSize: number } {
  let seen = 0;
  let result: { pos: number; nodeSize: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== nodeType || result) return true;
    if (seen === occurrence) {
      result = { pos, nodeSize: node.nodeSize };
      return false;
    }
    seen += 1;
    return true;
  });
  if (!result)
    throw new Error(`Missing ${nodeType} at occurrence ${occurrence}`);
  return result;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("transactionTouchesSceneBeat", () => {
  it("returns false for ordinary paragraph text edits", () => {
    const editor = createEditor();
    const paragraph = findNodeAt(editor, "paragraph");
    const transaction = editor.state.tr.insertText("!", paragraph.pos + 2);

    expect(transactionTouchesSceneBeat(transaction)).toBe(false);
  });

  it("returns true for text edits inside a sceneBeat", () => {
    const editor = createEditor();
    const beat = findNodeAt(editor, "sceneBeat");
    const transaction = editor.state.tr.insertText("!", beat.pos + 2);

    expect(transactionTouchesSceneBeat(transaction)).toBe(true);
  });

  it("returns true when a sceneBeat is inserted", () => {
    const editor = createEditor();
    const beat = editor.schema.nodes.sceneBeat.create(
      {
        id: "beat-2",
        collapsed: false,
        beatType: "free",
        pov: null,
      },
      editor.schema.text("inserted"),
    );
    const transaction = editor.state.tr.insert(
      editor.state.doc.content.size,
      beat,
    );

    expect(transactionTouchesSceneBeat(transaction)).toBe(true);
  });

  it("returns true when a sceneBeat is removed", () => {
    const editor = createEditor();
    const beat = findNodeAt(editor, "sceneBeat");
    const transaction = editor.state.tr.delete(
      beat.pos,
      beat.pos + beat.nodeSize,
    );

    expect(transactionTouchesSceneBeat(transaction)).toBe(true);
  });

  it("does not treat an adjacent paragraph deletion as touching a beat", () => {
    const editor = createEditor();
    const paragraph = findNodeAt(editor, "paragraph");
    const transaction = editor.state.tr.delete(
      paragraph.pos,
      paragraph.pos + paragraph.nodeSize,
    );

    expect(transactionTouchesSceneBeat(transaction)).toBe(false);
  });

  it("returns true for a sceneBeat attribute step with an empty StepMap", () => {
    const editor = createEditor();
    const beat = findNodeAt(editor, "sceneBeat");
    const transaction = editor.state.tr.setNodeAttribute(
      beat.pos,
      "collapsed",
      true,
    );

    expect(transactionTouchesSceneBeat(transaction)).toBe(true);
  });

  it("distinguishes mark changes outside and inside a sceneBeat", () => {
    const editor = createEditor();
    const bold = editor.schema.marks.bold.create();
    const paragraph = findNodeAt(editor, "paragraph");
    const beat = findNodeAt(editor, "sceneBeat");

    const paragraphMark = editor.state.tr.addMark(
      paragraph.pos + 1,
      paragraph.pos + 3,
      bold,
    );
    const beatMark = editor.state.tr.addMark(beat.pos + 1, beat.pos + 3, bold);

    expect(transactionTouchesSceneBeat(paragraphMark)).toBe(false);
    expect(transactionTouchesSceneBeat(beatMark)).toBe(true);
  });

  it("checks the intermediate documents of multi-step transactions", () => {
    const editor = createEditor();
    const paragraph = findNodeAt(editor, "paragraph");
    const transaction = editor.state.tr.insertText("!", paragraph.pos + 2);

    let beatPos = -1;
    transaction.doc.descendants((node, pos) => {
      if (node.type.name !== "sceneBeat") return true;
      beatPos = pos;
      return false;
    });
    transaction.insertText("?", beatPos + 2);

    expect(transaction.steps).toHaveLength(2);
    expect(transactionTouchesSceneBeat(transaction)).toBe(true);
  });

  it("returns false for transactions without document steps", () => {
    const editor = createEditor();

    expect(transactionTouchesSceneBeat(editor.state.tr)).toBe(false);
  });

  it("conservatively returns true for unknown empty-map steps", () => {
    const editor = createEditor();
    const doc = editor.state.doc;

    expect(
      transactionTouchesSceneBeat({
        before: doc,
        doc,
        docs: [doc],
        steps: [
          {
            getMap: () => StepMap.empty,
            toJSON: () => ({ stepType: "futureStep" }),
          },
        ],
      }),
    ).toBe(true);
  });
});
