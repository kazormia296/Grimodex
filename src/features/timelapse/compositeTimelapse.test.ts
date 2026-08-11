import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChangeEvent } from "@/db/schema";
import {
  pickRenderTarget,
  buildCompositeTimelapsePlan,
} from "./compositeTimelapse";
import { createReplayCursor } from "./replayEngine";
import StarterKit from "@tiptap/starter-kit";
import { getSchema } from "@tiptap/core";

vi.mock("./queryEvents", () => ({
  loadProjectChangeEvents: vi.fn(),
}));
vi.mock("./snapshots", () => ({
  loadLatestSnapshot: vi.fn(async () => null),
}));
vi.mock("@/features/editor/extensions", () => ({
  getEditorExtensions: () => [StarterKit],
}));

import { loadProjectChangeEvents } from "./queryEvents";
import { loadLatestSnapshot } from "./snapshots";

const load = vi.mocked(loadProjectChangeEvents);
const loadSnap = vi.mocked(loadLatestSnapshot);

function ev(partial: Partial<ChangeEvent> & { sequence: number }): ChangeEvent {
  return {
    id: partial.sequence,
    projectId: "p",
    sceneId: null,
    domain: "chat",
    opType: "chat.message.add",
    entityType: null,
    entityId: null,
    payload: "{}",
    sessionId: "s",
    timestamp: partial.sequence * 1000,
    prevHash: new Uint8Array(32),
    hash: new Uint8Array(32),
    ...partial,
  } as ChangeEvent;
}

describe("pickRenderTarget", () => {
  const events: ChangeEvent[] = [
    ev({
      sequence: 1,
      domain: "editor",
      opType: "doc.step",
      sceneId: "sceneA",
      payload: '{"steps":[]}',
    }),
    ev({
      sequence: 3,
      domain: "codex",
      opType: "doc.step",
      entityId: "c1",
      payload: '{"steps":[]}',
    }),
    ev({
      sequence: 5,
      domain: "editor",
      opType: "doc.step",
      sceneId: "sceneB",
      payload: '{"steps":[]}',
    }),
  ];

  it("returns scene or codex keys from latest doc.step", () => {
    const cursors = new Map();
    expect(pickRenderTarget(events, 1, cursors, null)).toBe("scene:sceneA");
    expect(pickRenderTarget(events, 3, cursors, "scene:sceneA")).toBe(
      "codex:c1",
    );
    expect(pickRenderTarget(events, 4, cursors, "codex:c1")).toBe("codex:c1");
    expect(pickRenderTarget(events, 5, cursors, "codex:c1")).toBe(
      "scene:sceneB",
    );
  });

  it("falls back to prevRenderKey when cursor has failure", () => {
    const schema = getSchema([StarterKit]);
    const empty = schema.topNodeType.createAndFill()!;
    const cursor = createReplayCursor(schema, empty, [
      {
        sequence: 99,
        domain: "codex",
        opType: "doc.step",
        payload: '{"steps":[{"stepType":"invalid"}]}',
      },
    ]);
    cursor.applyUntil(99);
    expect(cursor.failure).not.toBeNull();
    const cursors = new Map([["codex:c1", cursor]]);
    expect(pickRenderTarget(events, 3, cursors, "scene:sceneA")).toBe(
      "scene:sceneA",
    );
  });

  it("returns prevRenderKey when no doc.step before target", () => {
    const cursors = new Map();
    expect(pickRenderTarget(events, 0, cursors, "scene:sceneA")).toBe(
      "scene:sceneA",
    );
  });
});

describe("buildCompositeTimelapsePlan", () => {
  beforeEach(() => {
    load.mockReset();
    loadSnap.mockReset();
    loadSnap.mockResolvedValue(null);
  });

  it("throws when project has no events", async () => {
    load.mockResolvedValue([]);
    await expect(
      buildCompositeTimelapsePlan({ projectId: "p" }),
    ).rejects.toThrow(/no change events/);
  });

  it("accepts codex doc.step without sceneId (no throw)", async () => {
    load.mockResolvedValue([
      ev({
        sequence: 1,
        domain: "codex",
        opType: "doc.step",
        entityId: "c1",
        payload: '{"steps":[]}',
      }),
    ]);
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      fps: 4,
      targetDurationSec: 1,
    });
    expect(plan.cursors.has("codex:c1")).toBe(true);
    expect(plan.schedule.length).toBe(4);
    // buildCursors must seek a codex baseline under domain "codex" (not "editor"),
    // matching the domain the codex doc.step carries.
    expect(loadSnap).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "codex", entityId: "c1" }),
    );
  });

  it("loads entity baselines in parallel (not one roundtrip at a time)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    loadSnap.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      return null;
    });
    load.mockResolvedValue([
      ev({
        sequence: 1,
        domain: "editor",
        opType: "doc.step",
        sceneId: "sceneA",
        payload: '{"steps":[]}',
      }),
      ev({
        sequence: 2,
        domain: "codex",
        opType: "doc.step",
        entityId: "c1",
        payload: '{"steps":[]}',
      }),
      ev({
        sequence: 3,
        domain: "snippet",
        opType: "doc.step",
        entityId: "sn1",
        payload: '{"steps":[]}',
      }),
    ]);
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      fps: 4,
      targetDurationSec: 1,
    });
    expect(plan.cursors.size).toBe(3);
    expect(loadSnap).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("includes chrome captions in frameCaptions for chat events", async () => {
    load.mockResolvedValue([
      ev({
        sequence: 1,
        domain: "chat",
        opType: "chat.message.add",
        payload: JSON.stringify({ role: "user", text: "hi" }),
      }),
    ]);
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      fps: 4,
      targetDurationSec: 1,
    });
    const anyCaption = plan.frameCaptions.some((fc) => fc.length > 0);
    expect(anyCaption).toBe(true);
  });

  it("scene mode allows chrome-only export", async () => {
    load.mockResolvedValue([
      ev({
        sequence: 1,
        domain: "chat",
        opType: "chat.message.add",
        payload: JSON.stringify({ role: "user", text: "hi" }),
      }),
    ]);
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      sceneId: "sceneX",
      fps: 4,
      targetDurationSec: 1,
    });
    expect(plan.eventCount).toBe(1);
  });

  it("scene mode includes project-wide grid chrome (sceneId null)", async () => {
    load.mockResolvedValue([
      ev({
        sequence: 1,
        domain: "grid",
        opType: "note.create",
        sceneId: null,
        payload: JSON.stringify({ title: "n" }),
      }),
    ]);
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      sceneId: "sceneX",
      fps: 4,
      targetDurationSec: 1,
    });
    expect(plan.eventCount).toBe(1);
  });

  it.each([
    ["forward", "event.stamp", undefined],
    ["undo", "event.unstamp", "undo"],
    ["redo", "event.stamp", "redo"],
  ] as const)(
    "scene mode attributes a batch %s event to every payload scene",
    async (_phase, opType, direction) => {
      load.mockResolvedValue([
        ev({
          sequence: 1,
          domain: "event",
          opType,
          sceneId: null,
          entityType: "event",
          entityId: "event-1",
          payload: JSON.stringify({
            eventId: "event-1",
            sceneIds: ["sceneA", "sceneB"],
            direction,
          }),
        }),
      ]);

      const plan = await buildCompositeTimelapsePlan({
        projectId: "p",
        sceneId: "sceneB",
        fps: 4,
        targetDurationSec: 1,
      });
      expect(plan.events).toHaveLength(1);
      expect(plan.events[0].opType).toBe(opType);

      await expect(
        buildCompositeTimelapsePlan({
          projectId: "p",
          sceneId: "unrelated-scene",
        }),
      ).rejects.toThrow(/no change events/);
    },
  );

  it.each(["null", "[]"])(
    "scene mode ignores non-object batch payload %s without throwing",
    async (payload) => {
      load.mockResolvedValue([
        ev({
          sequence: 1,
          domain: "event",
          opType: "event.stamp",
          sceneId: null,
          entityType: "event",
          entityId: "event-1",
          payload,
        }),
      ]);

      await expect(
        buildCompositeTimelapsePlan({ projectId: "p", sceneId: "sceneB" }),
      ).rejects.toThrow(/no change events/);
    },
  );

  it("suppresses codex entry.update when doc.step was in an earlier frame", async () => {
    load.mockResolvedValue([
      ev({
        sequence: 1,
        domain: "codex",
        opType: "doc.step",
        entityId: "c1",
        payload: '{"steps":[]}',
      }),
      ev({
        sequence: 2,
        domain: "codex",
        opType: "entry.update",
        entityId: "c1",
        payload: JSON.stringify({
          fields: ["summary"],
          diffs: { summary: { segments: [[1, "DUAL_RECORD_MARKER"]] } },
        }),
      }),
    ]);
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      fps: 2,
      targetDurationSec: 1,
    });
    const allCaptionText = plan.frameCaptions
      .flat()
      .flatMap((c) => c.segments.map((s) => s.text))
      .join("");
    expect(allCaptionText).not.toContain("DUAL_RECORD_MARKER");
  });

  it("suppresses codex entry.update when doc.step is in the SAME frame", async () => {
    // Regression for the forward-pointer buildFrameCaptions rewrite: doc.step
    // entity keys for the current window must be accumulated BEFORE captions in
    // that same frame are evaluated, so a same-frame entry.update is suppressed.
    // fps:1 * 1s => a single frame, so both events land in one window.
    load.mockResolvedValue([
      ev({
        sequence: 1,
        domain: "codex",
        opType: "doc.step",
        entityId: "c1",
        payload: '{"steps":[]}',
      }),
      ev({
        sequence: 2,
        domain: "codex",
        opType: "entry.update",
        entityId: "c1",
        payload: JSON.stringify({
          fields: ["summary"],
          diffs: { summary: { segments: [[1, "DUAL_RECORD_MARKER"]] } },
        }),
      }),
    ]);
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      fps: 1,
      targetDurationSec: 1,
    });
    const allCaptionText = plan.frameCaptions
      .flat()
      .flatMap((c) => c.segments.map((s) => s.text))
      .join("");
    expect(allCaptionText).not.toContain("DUAL_RECORD_MARKER");
  });

  it("scene mode throws when no scene body and no chrome", async () => {
    load.mockResolvedValue([
      ev({
        sequence: 1,
        domain: "editor",
        opType: "doc.step",
        sceneId: "other",
        payload: '{"steps":[]}',
      }),
    ]);
    await expect(
      buildCompositeTimelapsePlan({ projectId: "p", sceneId: "sceneX" }),
    ).rejects.toThrow(/no change events/);
  });
});
