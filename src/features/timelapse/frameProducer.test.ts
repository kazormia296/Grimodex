// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { buildFrameSchedule, makeDrawFrame } from "./frameProducer";
import { createReplayCursor, type ReplayEvent } from "./replayEngine";

function evs(pairs: [number, number][]) {
  return pairs.map(([sequence, timestamp]) => ({ sequence, timestamp }));
}

function isNonDecreasing(xs: number[]) {
  return xs.every((x, i) => i === 0 || x >= xs[i - 1]);
}

describe("buildFrameSchedule", () => {
  it("returns an empty schedule for no events", () => {
    expect(buildFrameSchedule([], { fps: 10, targetDurationSec: 1 })).toEqual(
      [],
    );
  });

  it("produces fps*duration frames, non-decreasing, spanning first..last sequence", () => {
    const events = evs([
      [1, 0],
      [2, 100],
      [3, 200],
      [4, 300],
    ]);
    const schedule = buildFrameSchedule(events, {
      fps: 10,
      targetDurationSec: 1,
    });
    expect(schedule).toHaveLength(10);
    expect(isNonDecreasing(schedule)).toBe(true);
    expect(schedule[0]).toBe(1);
    expect(schedule[schedule.length - 1]).toBe(4);
  });

  it("handles all-equal timestamps by sampling on event index", () => {
    const events = evs([
      [5, 1000],
      [6, 1000],
      [7, 1000],
    ]);
    const schedule = buildFrameSchedule(events, {
      fps: 6,
      targetDurationSec: 1,
    });
    expect(schedule).toHaveLength(6);
    expect(isNonDecreasing(schedule)).toBe(true);
    expect(schedule[0]).toBe(5);
    expect(schedule[schedule.length - 1]).toBe(7);
  });

  it("collapses long idle gaps: events after the gap get more frames with compression", () => {
    // Burst at 0ms, then 5 s idle, then 100ms burst.
    // With maxIdleMs=100 the idle collapses → event 2 fills ~40% of frames.
    // With maxIdleMs=5000 (no effective compression) → event 2 appears in 0–1 frames.
    const events = evs([
      [1, 0],
      [2, 5000],
      [3, 5100],
    ]);

    const compressed = buildFrameSchedule(events, {
      fps: 10,
      targetDurationSec: 1,
      maxIdleMs: 100,
    });
    const uncompressed = buildFrameSchedule(events, {
      fps: 10,
      targetDurationSec: 1,
      maxIdleMs: 5000,
    });

    const seq2WithCap = compressed.filter((s) => s === 2).length;
    const seq2NoCap = uncompressed.filter((s) => s === 2).length;
    expect(seq2WithCap).toBeGreaterThan(seq2NoCap);
  });
});

function mockCtx() {
  return {
    fillStyle: "",
    font: "",
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((t: string) => ({ width: t.length * 8 })),
  } as unknown as CanvasRenderingContext2D;
}

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

describe("makeDrawFrame", () => {
  it("advances the cursor and paints each frame, signalling done past the end", () => {
    const base = new Editor({ extensions: [StarterKit], content: "<p>x</p>" });
    const captured = captureSteps("<p>x</p>", ["a", "b", "c"]);
    const cursor = createReplayCursor(base.schema, base.state.doc, captured);
    const ctx = mockCtx();
    const schedule = captured.map((e) => e.sequence); // one frame per event

    const drawFrame = makeDrawFrame({
      cursor,
      ctx,
      width: 320,
      height: 200,
      schedule,
    });

    expect(drawFrame(0)).toBe(false);
    expect(
      (ctx.fillText as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThan(0);
    // run remaining real frames
    for (let i = 1; i < schedule.length; i += 1) {
      expect(drawFrame(i)).toBe(false);
    }
    // past the end -> stop, last frame already painted
    expect(drawFrame(schedule.length)).toBe(true);
    expect(cursor.appliedSteps).toBeGreaterThan(0);
    base.destroy();
  });
});
