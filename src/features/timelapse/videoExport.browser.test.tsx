// Browser test (real Chromium): exercises the actual MediaRecorder +
// canvas.captureStream encoding path that every happy-dom unit test stubs.
// Proves the frameProducer -> canvas -> captureCanvasToWebm pipeline emits a
// real, non-empty WebM blob — the one thing "implemented + unit-green" can't.
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { createReplayCursor, type ReplayEvent } from "./replayEngine";
import { buildFrameSchedule, makeDrawFrame } from "./frameProducer";
import { captureCanvasToWebm, pickSupportedWebmMime } from "./videoExport";

function captureSteps(initial: string, inserts: string[]): ReplayEvent[] {
  const ed = new Editor({ extensions: [StarterKit], content: initial });
  const out: ReplayEvent[] = [];
  let seq = 0;
  ed.on("transaction", ({ transaction }) => {
    if (!transaction.docChanged) return;
    seq += 1;
    out.push({
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
  ed.destroy();
  return out;
}

describe("captureCanvasToWebm (real Chromium MediaRecorder)", () => {
  it("encodes replayed frames into a non-empty WebM blob", async () => {
    const mime = pickSupportedWebmMime();
    expect(mime, "Chromium should support a WebM mime").toBeTruthy();

    const base = new Editor({ extensions: [StarterKit], content: "<p></p>" });
    const captured = captureSteps("<p></p>", ["Hello ", "timelapse ", "world"]);
    expect(captured.length).toBeGreaterThan(0);

    // Synthetic timestamps for the schedule; keep it short so the real-time
    // recorder loop stays fast (~0.5s).
    const scheduleEvents = captured.map((e) => ({
      sequence: e.sequence,
      timestamp: e.sequence * 100,
    }));
    const schedule = buildFrameSchedule(scheduleEvents, {
      fps: 30,
      targetDurationSec: 0.5,
    });

    const initial = base.schema.topNodeType.createAndFill();
    expect(initial).toBeTruthy();
    const cursor = createReplayCursor(base.schema, initial!, captured);

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    expect(ctx).toBeTruthy();

    const drawFrame = makeDrawFrame({
      cursor,
      ctx: ctx!,
      width: canvas.width,
      height: canvas.height,
      schedule,
    });

    const blob = await captureCanvasToWebm(canvas, {
      fps: 30,
      drawFrame,
      ...(mime ? { mimeType: mime } : {}),
    });

    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain("webm");
    expect(cursor.doc.textContent).toContain("Hello");
    base.destroy();
  });
});
