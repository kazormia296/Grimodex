// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import StarterKit from "@tiptap/starter-kit";

const queryMock = vi.hoisted(() => ({
  loadProjectChangeEvents: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
}));
vi.mock("./queryEvents", () => ({
  loadProjectChangeEvents: queryMock.loadProjectChangeEvents,
  loadSceneChangeEvents: vi.fn(),
}));
vi.mock("./snapshots", () => ({
  loadLatestSnapshot: vi.fn(async () => null),
}));
vi.mock("@/features/editor/extensions", () => ({
  getEditorExtensions: () => [StarterKit],
}));

import { Editor } from "@tiptap/core";
import {
  produceSceneTimelapseWebm,
  saveWebmBlob,
  buildReplayStart,
} from "./exportTimelapse";
import type { ReplayEvent } from "./replayEngine";

function fakeEvents(seqs: number[]): ReplayEvent[] {
  return seqs.map((sequence) => ({
    domain: "editor",
    opType: "doc.step",
    payload: '{"steps":[]}',
    sequence,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.loadProjectChangeEvents.mockResolvedValue([]);
});

describe("produceSceneTimelapseWebm", () => {
  it("throws when the scene has no exportable events", async () => {
    queryMock.loadProjectChangeEvents.mockResolvedValue([]);
    await expect(
      produceSceneTimelapseWebm({ projectId: "p", sceneId: "s" }),
    ).rejects.toThrow(/no change events/);
  });

  it("allows chrome-only scene plan without editor doc.step", async () => {
    queryMock.loadProjectChangeEvents.mockResolvedValue([
      {
        sequence: 1,
        timestamp: 1,
        sceneId: null,
        domain: "chat",
        opType: "chat.message.add",
        payload: JSON.stringify({ role: "user", text: "hi" }),
      },
    ]);
    const { buildCompositeTimelapsePlan } =
      await import("./compositeTimelapse");
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      sceneId: "s",
      fps: 4,
      targetDurationSec: 1,
    });
    expect(plan.eventCount).toBe(1);
    expect(plan.frameCaptions.some((c) => c.length > 0)).toBe(true);
  });

  it("uses loadProjectChangeEvents for scene export", async () => {
    queryMock.loadProjectChangeEvents.mockResolvedValue([
      {
        sequence: 1,
        timestamp: 1,
        sceneId: "s",
        domain: "editor",
        opType: "doc.step",
        payload: '{"steps":[]}',
      },
    ]);
    const { buildCompositeTimelapsePlan } =
      await import("./compositeTimelapse");
    await buildCompositeTimelapsePlan({
      projectId: "p1",
      sceneId: "s",
      fps: 4,
      targetDurationSec: 1,
    });
    expect(queryMock.loadProjectChangeEvents).toHaveBeenCalledWith("p1");
  });
});

describe("saveWebmBlob", () => {
  it("browser fallback creates an object URL and triggers a download", async () => {
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.fn();
    const realCreateEl = document.createElement.bind(document);
    const createElSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = realCreateEl(tag);
        if (tag === "a") el.click = clickSpy;
        return el;
      });

    try {
      const blob = new Blob(["x"], { type: "video/webm" });
      const ok = await saveWebmBlob(blob, "scene.webm");
      expect(ok).toBe(true);
      expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
      expect(clickSpy).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    } finally {
      createElSpy.mockRestore();
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});

describe("buildReplayStart", () => {
  it("without a snapshot: empty doc + all events", () => {
    const ed = new Editor({ extensions: [StarterKit], content: "<p>seed</p>" });
    const { initialDoc, replayEvents } = buildReplayStart(
      ed.schema,
      fakeEvents([1, 2, 3]),
      null,
    );
    expect(replayEvents).toHaveLength(3);
    expect(initialDoc.textContent).toBe("");
    ed.destroy();
  });

  it("with a snapshot: seeds the doc and replays only events after the anchor", () => {
    const ed = new Editor({
      extensions: [StarterKit],
      content: "<p>baseline</p>",
    });
    const payload = ed.state.doc.toJSON();
    const { initialDoc, replayEvents } = buildReplayStart(
      ed.schema,
      fakeEvents([1, 2, 3, 4]),
      { payload, anchorSequence: 2 },
    );
    expect(initialDoc.textContent).toBe("baseline");
    expect(replayEvents.map((e) => e.sequence)).toEqual([3, 4]);
    ed.destroy();
  });
});
