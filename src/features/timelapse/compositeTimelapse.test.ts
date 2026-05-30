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

const load = vi.mocked(loadProjectChangeEvents);

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
    expect(pickRenderTarget(events, 3, cursors, "scene:sceneA")).toBe("codex:c1");
    expect(pickRenderTarget(events, 4, cursors, "codex:c1")).toBe("codex:c1");
    expect(pickRenderTarget(events, 5, cursors, "codex:c1")).toBe("scene:sceneB");
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
    expect(
      pickRenderTarget(events, 3, cursors, "scene:sceneA"),
    ).toBe("scene:sceneA");
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
