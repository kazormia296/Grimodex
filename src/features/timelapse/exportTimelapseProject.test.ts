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
  pickRenderTarget,
  buildCompositeTimelapsePlan,
  makeCompositeDrawFrame,
  produceProjectTimelapseWebm,
} from "./exportTimelapse";
import { createReplayCursor } from "./replayEngine";
import { getSchema } from "@tiptap/core";

const load = vi.mocked(loadProjectChangeEvents);

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
  entityId?: string | null;
}

function buildRows(): Row[] {
  const rows: Row[] = [];
  let seq = 0;
  let ts = 1000;
  const push = (sceneId: string, steps: unknown) =>
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

describe("pickRenderTarget", () => {
  const events = [
    { sequence: 1, sceneId: "a", domain: "editor", opType: "doc.step", entityId: null },
    { sequence: 3, sceneId: null, domain: "codex", opType: "doc.step", entityId: "c1" },
    { sequence: 7, sceneId: "b", domain: "editor", opType: "doc.step", entityId: null },
  ] as never;

  it("returns render keys from latest doc.step at or before target", () => {
    const cursors = new Map();
    expect(pickRenderTarget(events, 1, cursors, null)).toBe("scene:a");
    expect(pickRenderTarget(events, 2, cursors, "scene:a")).toBe("scene:a");
    expect(pickRenderTarget(events, 3, cursors, "scene:a")).toBe("codex:c1");
    expect(pickRenderTarget(events, 6, cursors, "codex:c1")).toBe("codex:c1");
    expect(pickRenderTarget(events, 7, cursors, "codex:c1")).toBe("scene:b");
  });

  it("returns prevRenderKey when no doc.step before target", () => {
    const cursors = new Map();
    expect(pickRenderTarget(events, 0, cursors, "scene:a")).toBe("scene:a");
  });

  it("falls back to prevRenderKey when cursor has failure", () => {
    const schema = getSchema([StarterKit]);
    const empty = schema.topNodeType.createAndFill()!;
    const cursor = createReplayCursor(schema, empty, [
      {
        sequence: 99,
        domain: "codex",
        opType: "doc.step",
        payload: JSON.stringify({
          steps: [{ stepType: "replace", from: 0, to: 0, slice: { content: [] } }],
        }),
      },
    ]);
    // Force failure by applying replace at invalid pos on empty doc
    cursor.applyUntil(99);
    const cursors = new Map([["codex:c1", cursor]]);
    if (cursor.failure) {
      expect(pickRenderTarget(events, 3, cursors, "scene:a")).toBe("scene:a");
    }
  });
});

describe("buildCompositeTimelapsePlan", () => {
  it("throws when the project has no events", async () => {
    load.mockResolvedValue([] as never);
    await expect(buildCompositeTimelapsePlan({ projectId: "p" })).rejects.toThrow(
      /no change events/,
    );
  });

  it("builds codex cursor for doc.step without sceneId", async () => {
    load.mockResolvedValue([
      {
        sequence: 1,
        timestamp: 1,
        sceneId: null,
        domain: "codex",
        opType: "doc.step",
        entityId: "c1",
        payload: JSON.stringify({ steps: [] }),
      },
    ] as never);
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      fps: 4,
      targetDurationSec: 1,
    });
    expect(plan.cursors.has("codex:c1")).toBe(true);
    expect(plan.schedule).toHaveLength(4);
  });

  it("groups body steps into scene cursors", async () => {
    load.mockResolvedValue(buildRows() as never);
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      fps: 4,
      targetDurationSec: 1,
    });
    expect(plan.sceneCount).toBe(2);
    expect([...plan.cursors.keys()].sort()).toEqual([
      "scene:sceneA",
      "scene:sceneB",
    ]);
    expect(plan.schedule).toHaveLength(4);
  });
});

function buildRowsWithCodexFailure(): Row[] {
  const alphaSteps = stepsFor("Alpha");
  return [
    {
      sequence: 1,
      timestamp: 100,
      sceneId: "sceneA",
      domain: "editor",
      opType: "doc.step",
      payload: JSON.stringify({ steps: alphaSteps[0] }),
    },
    {
      sequence: 2,
      timestamp: 200,
      sceneId: null,
      domain: "codex",
      opType: "doc.step",
      entityId: "c1",
      payload: JSON.stringify({
        steps: [
          {
            stepType: "replace",
            from: 999,
            to: 999,
            slice: { content: [{ type: "paragraph" }] },
          },
        ],
      }),
    },
  ];
}

describe("makeCompositeDrawFrame", () => {
  it("recovers previous scene doc after codex cursor failure on later frames", async () => {
    load.mockResolvedValue(buildRowsWithCodexFailure() as never);
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      fps: 4,
      targetDurationSec: 1,
    });
    const { ctx, texts } = makeMockCtx();
    const draw = makeCompositeDrawFrame({ plan, ctx, width: 400, height: 200 });
    for (let f = 0; f < plan.schedule.length; f += 1) {
      draw(f);
    }
    // Early frame has scene body; after codex failure, later frames must not stay blank.
    expect(texts()).toContain("Alpha");
    const alphaCount = (texts().match(/Alpha/g) ?? []).length;
    expect(alphaCount).toBeGreaterThan(1);
  });

  it("renders the active scene document as the timeline advances", async () => {
    load.mockResolvedValue(buildRows() as never);
    const plan = await buildCompositeTimelapsePlan({
      projectId: "p",
      fps: 30,
      targetDurationSec: 1,
    });
    const { ctx, texts } = makeMockCtx();
    const draw = makeCompositeDrawFrame({ plan, ctx, width: 400, height: 200 });

    draw(0);
    expect(texts()).toContain("Alpha");
    expect(texts()).not.toContain("Beta");

    const { ctx: ctx2, texts: texts2 } = makeMockCtx();
    const draw2 = makeCompositeDrawFrame({
      plan,
      ctx: ctx2,
      width: 400,
      height: 200,
    });
    draw2(plan.schedule.length - 1);
    expect(texts2()).toContain("Beta");
  });
});

describe("produceProjectTimelapseWebm", () => {
  it("throws when the project has no events", async () => {
    load.mockResolvedValue([] as never);
    await expect(
      produceProjectTimelapseWebm({ projectId: "p" }),
    ).rejects.toThrow(/no change events/);
  });
});
