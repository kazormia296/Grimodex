// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { replayEditorSteps } from "./replayEngine";

function makeEditor(initialContent: string) {
  return new Editor({
    extensions: [StarterKit],
    content: initialContent,
  });
}

describe("replayEditorSteps", () => {
  it("replays captured steps to the same final doc as the live editor", () => {
    const initial = "<p>Hello</p>";
    const recorder = makeEditor(initial);
    const replayBase = makeEditor(initial);

    const captured: {
      domain: string;
      opType: string;
      payload: string;
      sequence: number;
    }[] = [];
    let seq = 0;

    recorder.on("transaction", ({ transaction }) => {
      if (!transaction.docChanged) return;
      seq += 1;
      captured.push({
        domain: "editor",
        opType: "doc.step",
        payload: JSON.stringify({
          steps: transaction.steps.map((s) => s.toJSON()),
        }),
        sequence: seq,
      });
    });

    // Type a few characters at the end of "Hello" and then bold one word.
    recorder.commands.focus("end");
    recorder.commands.insertContent(" world");
    recorder.commands.selectAll();
    recorder.commands.toggleBold();

    const expectedJson = recorder.state.doc.toJSON();

    const result = replayEditorSteps(
      replayBase.schema,
      replayBase.state.doc,
      captured,
    );
    expect(result.failedAt).toBeUndefined();
    expect(result.appliedSteps).toBeGreaterThan(0);
    expect(result.doc.toJSON()).toEqual(expectedJson);

    recorder.destroy();
    replayBase.destroy();
  });

  it("skips events from unrelated domains", () => {
    const editor = makeEditor("<p>x</p>");
    const result = replayEditorSteps(editor.schema, editor.state.doc, [
      {
        domain: "map",
        opType: "doc.step",
        payload: '{"steps":[]}',
        sequence: 1,
      },
    ]);
    expect(result.appliedSteps).toBe(0);
    expect(result.failedAt).toBeUndefined();
    editor.destroy();
  });

  it("reports failedAt on malformed payload", () => {
    const editor = makeEditor("<p>x</p>");
    const result = replayEditorSteps(editor.schema, editor.state.doc, [
      {
        domain: "editor",
        opType: "doc.step",
        payload: "not json",
        sequence: 7,
      },
    ]);
    expect(result.failedAt).toBe(7);
    editor.destroy();
  });
});
