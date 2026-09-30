// @vitest-environment happy-dom
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { replayEditorSteps, type ReplayEvent } from "./replayEngine";
import { buildReplayStart } from "./replayStart";

const schema = getSchema([StarterKit]);

function event(sequence: number): ReplayEvent {
  return {
    domain: "editor",
    opType: "doc.step",
    payload: JSON.stringify({ steps: [] }),
    sequence,
  };
}

function snapshot(payload: unknown, anchorSequence = 3) {
  return { payload, anchorSequence };
}

describe("buildReplayStart snapshot payload compatibility", () => {
  it("uses valid ProseMirror JSON and starts strictly after its anchor", () => {
    const result = buildReplayStart(
      schema,
      [event(2), event(3), event(4)],
      snapshot({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "canonical" }],
          },
        ],
      }),
    );

    expect(result.initialDoc.textContent).toBe("canonical");
    expect(result.replayEvents.map(({ sequence }) => sequence)).toEqual([4]);
  });

  it.each([{}, "{}", "", "   "])(
    "normalizes the canonical empty sentinel %#",
    (payload) => {
      const result = buildReplayStart(schema, [], snapshot(payload));

      expect(result.initialDoc.type.name).toBe("doc");
      expect(result.initialDoc.textContent).toBe("");
      expect(result.initialDoc.childCount).toBeGreaterThan(0);
    },
  );

  it("parses legacy HTML through the replay schema", () => {
    const result = buildReplayStart(
      schema,
      [],
      snapshot("<h2>Heading</h2><p>Hello <strong>world</strong></p>"),
    );

    expect(result.initialDoc.toJSON()).toMatchObject({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Heading" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", marks: [{ type: "bold" }], text: "world" },
          ],
        },
      ],
    });
  });

  it("treats legacy plain text as text rather than markup", () => {
    const result = buildReplayStart(
      schema,
      [],
      snapshot("2 < 3 & an alleged <script>never runs</script>"),
    );

    expect(result.initialDoc.textContent).toBe(
      "2 < 3 & an alleged <script>never runs</script>",
    );
  });

  it("keeps a leading dangerous or unknown tag literal as plain text", () => {
    const result = buildReplayStart(
      schema,
      [],
      snapshot("<script>literal</script><unknown>prose</unknown>"),
    );

    expect(result.initialDoc.textContent).toBe(
      "<script>literal</script><unknown>prose</unknown>",
    );
  });

  it.each([
    null,
    [],
    new Date(0),
    { content: [] },
    { type: "not-a-real-node" },
  ])("fails fast for malformed non-sentinel payload %#", (payload) => {
    expect(() => buildReplayStart(schema, [], snapshot(payload))).toThrow(
      /snapshot payload/i,
    );
  });
});

describe("editor-step-backed full-body ordering invariant", () => {
  it("models why a new-body snapshot followed by its earlier queued step corrupts replay", () => {
    const priorBody = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "A" }],
        },
      ],
    });
    const userTransaction = EditorState.create({
      schema,
      doc: priorBody,
    }).tr.insertText("B", 2);
    const queuedStep: ReplayEvent = {
      domain: "snippet",
      opType: "doc.step",
      sequence: 11,
      payload: JSON.stringify({
        steps: userTransaction.steps.map((step) => step.toJSON()),
      }),
    };

    const racedStart = buildReplayStart(
      schema,
      [queuedStep],
      snapshot(userTransaction.doc.toJSON(), 10),
    );
    const racedReplay = replayEditorSteps(
      schema,
      racedStart.initialDoc,
      racedStart.replayEvents,
    );
    expect(racedReplay.doc.textContent).toBe("ABB");

    // Contract: an editor-step-backed full-body commit must make this queued
    // step durable before any later baseline can include its resulting body.
    // With the prior body as the anchor, the same step applies exactly once.
    const orderedStart = buildReplayStart(
      schema,
      [queuedStep],
      snapshot(priorBody.toJSON(), 10),
    );
    const orderedReplay = replayEditorSteps(
      schema,
      orderedStart.initialDoc,
      orderedStart.replayEvents,
    );
    expect(orderedReplay.doc.textContent).toBe("AB");
  });
});
