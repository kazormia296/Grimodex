// @vitest-environment happy-dom
/**
 * Integration guard: the export path builds its schema from the REAL editor
 * extensions (getSchema(getEditorExtensions())) and replays REAL captured
 * steps — not StarterKit fixtures. If getEditorExtensions/getSchema throws, or
 * Step.fromJSON can't resolve genuine captured steps against that schema, the
 * whole feature is dead on arrival and the stubbed unit tests would miss it.
 */
import { describe, it, expect, vi } from "vitest";
import { Editor, getSchema } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { createReplayCursor, type ReplayEvent } from "./replayEngine";
import { renderDocToCanvas } from "./renderers/editorRenderer";

function mockCtx() {
  return {
    fillStyle: "",
    font: "",
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((t: string) => ({ width: t.length * 8 })),
  } as unknown as CanvasRenderingContext2D;
}

describe("production schema replay + render", () => {
  it("builds the real editor schema and an empty initial doc without throwing", () => {
    const schema = getSchema(getEditorExtensions());
    expect(schema.nodes.doc).toBeDefined();
    expect(schema.topNodeType.createAndFill()).toBeTruthy();
  });

  it("replays a real captured step against the production schema and renders its text", () => {
    const extensions = getEditorExtensions();
    const schema = getSchema(extensions);

    // Capture a genuine doc.step from an editor built with the SAME extensions.
    const ed = new Editor({ extensions, content: "<p></p>" });
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
    ed.commands.insertContent("Hello timelapse");
    expect(captured.length).toBeGreaterThan(0);

    const initial = schema.topNodeType.createAndFill();
    expect(initial).toBeTruthy();
    const cursor = createReplayCursor(schema, initial!, captured);
    cursor.applyUntil(Number.POSITIVE_INFINITY);

    expect(cursor.failure).toBeNull();
    expect(cursor.doc.textContent).toContain("Hello timelapse");

    const ctx = mockCtx();
    renderDocToCanvas(ctx, cursor.doc, 320, 200);
    const painted = (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(painted).toContain("Hello");

    ed.destroy();
  });
});
