// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  replayEditorSteps,
  createReplayCursor,
  type ReplayEvent,
} from "./replayEngine";

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

  it("reports failedAt when a step throws on apply (out-of-range position)", () => {
    const editor = makeEditor("<p>x</p>");
    const result = replayEditorSteps(editor.schema, editor.state.doc, [
      {
        domain: "editor",
        opType: "doc.step",
        payload: JSON.stringify({
          steps: [
            {
              stepType: "replace",
              from: 1519,
              to: 1519,
              structure: true,
              slice: { content: [{ type: "text", text: "z" }] },
            },
          ],
        }),
        sequence: 11,
      },
    ]);
    expect(result.failedAt).toBe(11);
    expect(result.reason).toMatch(/out of range/);
    expect(result.appliedSteps).toBe(0);
    editor.destroy();
  });
});

function captureInserts(
  initial: string,
  inserts: string[],
): { captured: ReplayEvent[]; finalJson: unknown } {
  const ed = makeEditor(initial);
  const captured: ReplayEvent[] = [];
  let seq = 0;
  ed.on("transaction", ({ transaction }) => {
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
  ed.commands.focus("end");
  for (const t of inserts) ed.commands.insertContent(t);
  const finalJson = ed.state.doc.toJSON();
  ed.destroy();
  return { captured, finalJson };
}

describe("createReplayCursor", () => {
  it("advancing to the end matches the one-shot replay", () => {
    const initial = "<p>Hello</p>";
    const { captured, finalJson } = captureInserts(initial, [
      "a",
      "b",
      "c",
      "d",
    ]);
    const base = makeEditor(initial);
    const cursor = createReplayCursor(base.schema, base.state.doc, captured);
    cursor.applyUntil(Number.POSITIVE_INFINITY);
    expect(cursor.failure).toBeNull();
    expect(cursor.doc.toJSON()).toEqual(finalJson);

    const oneShot = replayEditorSteps(base.schema, base.state.doc, captured);
    expect(cursor.doc.toJSON()).toEqual(oneShot.doc.toJSON());
    expect(cursor.appliedSteps).toBe(oneShot.appliedSteps);
    base.destroy();
  });

  it("applyUntil stops at the target sequence and resumes incrementally", () => {
    const initial = "<p>Hello</p>";
    const { captured } = captureInserts(initial, ["a", "b", "c", "d"]);
    const base = makeEditor(initial);
    const cursor = createReplayCursor(base.schema, base.state.doc, captured);

    cursor.applyUntil(2);
    expect(cursor.atSequence).toBe(2);
    const partial = cursor.appliedSteps;
    expect(partial).toBeGreaterThan(0);

    cursor.applyUntil(Number.POSITIVE_INFINITY);
    expect(cursor.appliedSteps).toBeGreaterThanOrEqual(partial);
    expect(cursor.atSequence).toBe(captured[captured.length - 1].sequence);
    base.destroy();
  });

  it("applyNext advances one event at a time and reports exhaustion", () => {
    const { captured } = captureInserts("<p>x</p>", ["a", "b"]);
    const base = makeEditor("<p>x</p>");
    const cursor = createReplayCursor(base.schema, base.state.doc, captured);
    let advances = 0;
    while (cursor.applyNext()) advances += 1;
    expect(advances).toBe(captured.length);
    expect(cursor.applyNext()).toBe(false);
    base.destroy();
  });

  it("records failure (does not throw) when a step position is out of range", () => {
    // Reproduces the export crash: a recorded ReplaceStep whose position
    // exceeds the reconstructed doc (un-seedable scene, or a chain gap from a
    // dropped/conflicting batch). ProseMirror's step.apply *throws* RangeError
    // here rather than returning result.failed, so the cursor must catch it and
    // halt gracefully instead of rejecting the whole export.
    const editor = makeEditor("<p>x</p>"); // doc.content.size === 3
    const outOfRange: ReplayEvent = {
      domain: "editor",
      opType: "doc.step",
      payload: JSON.stringify({
        steps: [
          {
            stepType: "replace",
            from: 1519,
            to: 1519,
            structure: true,
            slice: { content: [{ type: "text", text: "z" }] },
          },
        ],
      }),
      sequence: 11,
    };
    const cursor = createReplayCursor(editor.schema, editor.state.doc, [
      outOfRange,
    ]);
    expect(() => cursor.applyUntil(Number.POSITIVE_INFINITY)).not.toThrow();
    expect(cursor.failure?.failedAt).toBe(11);
    expect(cursor.failure?.reason).toMatch(/out of range/);
    // Last coherent doc is preserved (nothing was applied).
    expect(cursor.doc.toJSON()).toEqual(editor.state.doc.toJSON());
    expect(cursor.applyNext()).toBe(false);
    editor.destroy();
  });

  it("failure halts the cursor", () => {
    const editor = makeEditor("<p>x</p>");
    const cursor = createReplayCursor(editor.schema, editor.state.doc, [
      {
        domain: "editor",
        opType: "doc.step",
        payload: "not json",
        sequence: 3,
      },
      {
        domain: "editor",
        opType: "doc.step",
        payload: '{"steps":[]}',
        sequence: 4,
      },
    ]);
    cursor.applyUntil(Number.POSITIVE_INFINITY);
    expect(cursor.failure?.failedAt).toBe(3);
    expect(cursor.applyNext()).toBe(false);
    editor.destroy();
  });
});
