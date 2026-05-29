// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

vi.mock("./queryEvents", () => ({
  loadProjectChangeEvents: vi.fn(),
  loadSceneChangeEvents: vi.fn(),
}));
vi.mock("./snapshots", () => ({
  loadLatestSnapshot: vi.fn(async () => null),
}));
vi.mock("@/features/editor/extensions", () => ({
  getEditorExtensions: () => [StarterKit],
}));

import { loadProjectChangeEvents } from "./queryEvents";
import {
  pickActiveScene,
  buildProjectTimelapsePlan,
  makeProjectDrawFrame,
  produceProjectTimelapseWebm,
} from "./exportTimelapse";

const load = vi.mocked(loadProjectChangeEvents);

/** doc.step payloads (one per transaction) for typing `text` into a fresh doc. */
function stepsFor(text: string): unknown[][] {
  const editor = new Editor({ extensions: [StarterKit] });
  const out: unknown[][] = [];
  editor.on("transaction", ({ transaction }) => {
    if (transaction.docChanged) {
      out.push(transaction.steps.map((s) => s.toJSON()));
    }
  });
  editor.commands.insertContent(text);
  editor.destroy();
  return out;
}

interface Row {
  sequence: number;
  timestamp: number;
  sceneId: string | null;
  domain: string;
  opType: string;
  payload: string;
}

/** Build interleaved project events: sceneA first, then sceneB. */
function buildRows(): Row[] {
  const rows: Row[] = [];
  let seq = 0;
  let ts = 1000;
  const push = (sceneId: string, steps: unknown[]) =>
    rows.push({
      sequence: ++seq,
      timestamp: (ts += 100),
      sceneId,
      domain: "editor",
      opType: "doc.step",
      payload: JSON.stringify({ steps }),
    });
  for (const steps of stepsFor("Alpha")) push("sceneA", steps);
  for (const steps of stepsFor("Beta")) push("sceneB", steps);
  return rows;
}

interface MockCtx {
  ctx: CanvasRenderingContext2D;
  texts: () => string;
}
function makeMockCtx(): MockCtx {
  const painted: string[] = [];
  const ctx = {
    fillStyle: "",
    font: "",
    fillRect() {},
    fillText(t: string) {
      painted.push(t);
    },
    measureText(t: string) {
      return { width: t.length * 8 };
    },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    texts: () => painted.join(""),
  };
}

beforeEach(() => {
  load.mockReset();
});

describe("pickActiveScene", () => {
  const events = [
    { sequence: 1, sceneId: "a" },
    { sequence: 3, sceneId: "b" },
    { sequence: 7, sceneId: "a" },
  ];
  it("returns the scene of the latest event at or before the target", () => {
    expect(pickActiveScene(events, 1)).toBe("a");
    expect(pickActiveScene(events, 2)).toBe("a");
    expect(pickActiveScene(events, 3)).toBe("b");
    expect(pickActiveScene(events, 6)).toBe("b");
    expect(pickActiveScene(events, 7)).toBe("a");
    expect(pickActiveScene(events, 999)).toBe("a");
  });
  it("clamps targets before the first event to the first scene", () => {
    expect(pickActiveScene(events, 0)).toBe("a");
  });
  it("returns null for an empty list", () => {
    expect(pickActiveScene([], 5)).toBeNull();
  });
});

describe("buildProjectTimelapsePlan", () => {
  it("throws when the project has no recorded body steps", async () => {
    load.mockResolvedValue([] as never);
    await expect(buildProjectTimelapsePlan({ projectId: "p" })).rejects.toThrow(
      /no recorded editor steps/,
    );
  });

  it("ignores doc.step events without a sceneId (codex/snippet body)", async () => {
    load.mockResolvedValue([
      {
        sequence: 1,
        timestamp: 1,
        sceneId: null,
        domain: "codex",
        opType: "doc.step",
        payload: JSON.stringify({ steps: [] }),
      },
    ] as never);
    await expect(buildProjectTimelapsePlan({ projectId: "p" })).rejects.toThrow(
      /no recorded editor steps/,
    );
  });

  it("groups body steps into one cursor per scene", async () => {
    load.mockResolvedValue(buildRows() as never);
    const plan = await buildProjectTimelapsePlan({
      projectId: "p",
      fps: 4,
      targetDurationSec: 1,
    });
    expect(plan.sceneCount).toBe(2);
    expect([...plan.cursors.keys()].sort()).toEqual(["sceneA", "sceneB"]);
    expect(plan.schedule).toHaveLength(4); // fps 4 * 1s
    expect(plan.eventCount).toBe(plan.events.length);
  });
});

describe("makeProjectDrawFrame", () => {
  it("renders the active scene's document as the timeline advances", async () => {
    load.mockResolvedValue(buildRows() as never);
    const plan = await buildProjectTimelapsePlan({
      projectId: "p",
      fps: 30,
      targetDurationSec: 1,
    });
    const { ctx, texts } = makeMockCtx();
    const draw = makeProjectDrawFrame({ plan, ctx, width: 400, height: 200 });

    draw(0); // earliest target → sceneA
    expect(texts()).toContain("Alpha");
    expect(texts()).not.toContain("Beta");

    const { ctx: ctx2, texts: texts2 } = makeMockCtx();
    const draw2 = makeProjectDrawFrame({
      plan,
      ctx: ctx2,
      width: 400,
      height: 200,
    });
    draw2(plan.schedule.length - 1); // latest target → sceneB
    expect(texts2()).toContain("Beta");
  });
});

describe("produceProjectTimelapseWebm", () => {
  it("throws when the project has no recorded steps (before touching MediaRecorder)", async () => {
    load.mockResolvedValue([] as never);
    await expect(
      produceProjectTimelapseWebm({ projectId: "p" }),
    ).rejects.toThrow(/no recorded editor steps/);
  });
});
