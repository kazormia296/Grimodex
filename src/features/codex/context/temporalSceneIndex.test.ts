import { describe, expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { TemporalNodeId } from "@/features/narrative-extraction/temporal/nodes";
import { resolveStoryRanks } from "@/features/narrative-extraction/temporal/solver/resolveStoryRanks";
import {
  buildSceneTimeIndex,
  buildTemporalSceneIndex,
  compareSceneTime,
  isAutoStoryReady,
} from "./sceneTimeIndex";

function node(
  id: string,
  sortOrder: string,
  storyTimeOrder: string | null = null,
  overrides: Partial<TreeNodeData> = {},
): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder,
    status: null,
    storyTimeOrder,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const nodeA = "tn:scene-a" as TemporalNodeId;
const nodeB = "tn:scene-b" as TemporalNodeId;

describe("buildTemporalSceneIndex", () => {
  it("keeps reading mode graph-independent", () => {
    // Reading order: b(0), a(1). Graph: a before b (contradicts reading).
    const base = buildSceneTimeIndex([node("b", "a0"), node("a", "a1")]);
    const storyRanks = resolveStoryRanks(
      [nodeA, nodeB],
      [{ earlier: nodeA, later: nodeB }],
    );
    const index = buildTemporalSceneIndex(base, {
      storyRanks,
      sceneIdByNodeId: new Map([
        [nodeA, "a"],
        [nodeB, "b"],
      ]),
    });

    // reading is unaffected by the graph: b still comes before a.
    expect(compareSceneTime(index, "reading", "a", "b")).toBeGreaterThan(0);
    // story mode picks up the graph override: a comes before b.
    expect(compareSceneTime(index, "story", "a", "b")).toBeLessThan(0);
  });

  it("falls back to manual storyTimeOrder for scenes the graph does not resolve, then reading order", () => {
    const base = buildSceneTimeIndex([
      node("a", "a0"), // graph-resolved pair (a before b)
      node("b", "a1"),
      node("d", "a2", "k0"), // manual pair (d before c)
      node("c", "a3", "z0"),
      node("e", "a4"), // no graph, no manual info -> reading fallback
      node("f", "a5"),
    ]);
    const storyRanks = resolveStoryRanks(
      [nodeA, nodeB],
      [{ earlier: nodeA, later: nodeB }],
    );
    const index = buildTemporalSceneIndex(base, {
      storyRanks,
      sceneIdByNodeId: new Map([
        [nodeA, "a"],
        [nodeB, "b"],
      ]),
    });

    expect(compareSceneTime(index, "story", "a", "b")).toBeLessThan(0);
    expect(compareSceneTime(index, "story", "d", "c")).toBeLessThan(0);
    expect(compareSceneTime(index, "story", "e", "f")).toBeLessThan(0);
  });

  it("treats a conflicted scene's graph position as untrusted", () => {
    const base = buildSceneTimeIndex([node("b", "a0"), node("a", "a1")]);
    const storyRanks = resolveStoryRanks(
      [nodeA, nodeB],
      [{ earlier: nodeA, later: nodeB }],
    );
    const sceneIdByNodeId = new Map([
      [nodeA, "a"],
      [nodeB, "b"],
    ]);
    const index = buildTemporalSceneIndex(base, {
      storyRanks,
      sceneIdByNodeId,
      conflictNodeIds: [nodeA],
    });

    // Graph says a before b, but a is conflicted -> falls back to reading (b before a).
    expect(compareSceneTime(index, "story", "a", "b")).toBeGreaterThan(0);
  });

  it("marks auto-ready once every live scene is graph-comparable, without manual scheduling", () => {
    const base = buildSceneTimeIndex([node("a", "a0"), node("b", "a1")]);
    const storyRanks = resolveStoryRanks(
      [nodeA, nodeB],
      [{ earlier: nodeA, later: nodeB }],
    );
    const sceneIdByNodeId = new Map([
      [nodeA, "a"],
      [nodeB, "b"],
    ]);
    const ready = buildTemporalSceneIndex(base, {
      storyRanks,
      sceneIdByNodeId,
    });
    expect(base.scheduledSceneCount).toBe(0);
    expect(isAutoStoryReady(ready)).toBe(true);

    const conflicted = buildTemporalSceneIndex(base, {
      storyRanks,
      sceneIdByNodeId,
      conflictNodeIds: [nodeB],
    });
    expect(isAutoStoryReady(conflicted)).toBe(false);
  });

  it("falls back to manual-scheduling auto readiness when the graph leaves a scene unresolved", () => {
    const base = buildSceneTimeIndex([
      node("a", "a0", "k0"),
      node("b", "a1", "k1"),
    ]);
    // Graph only knows about "a"; "b" has no mapping so it stays unresolved.
    const storyRanks = resolveStoryRanks([nodeA], []);
    const index = buildTemporalSceneIndex(base, {
      storyRanks,
      sceneIdByNodeId: new Map([[nodeA, "a"]]),
    });

    expect(index.unresolvedSceneIds.has("b")).toBe(true);
    // Not all live scenes are graph-comparable, but every scene has a manual
    // story key, so auto readiness still succeeds via the legacy path.
    expect(isAutoStoryReady(index)).toBe(true);
  });

  it("places a flashback before its later-reading-position present scene via graph rank", () => {
    // Reading order: "present" is read first, "flashback" second — but the
    // flashback recounts an earlier story moment, so the graph orders it first.
    const base = buildSceneTimeIndex([
      node("present", "a0"),
      node("flashback", "a1"),
    ]);
    const nodePresent = "tn:present" as TemporalNodeId;
    const nodeFlashback = "tn:flashback" as TemporalNodeId;
    const storyRanks = resolveStoryRanks(
      [nodePresent, nodeFlashback],
      [{ earlier: nodeFlashback, later: nodePresent }],
    );
    const index = buildTemporalSceneIndex(base, {
      storyRanks,
      sceneIdByNodeId: new Map([
        [nodePresent, "present"],
        [nodeFlashback, "flashback"],
      ]),
    });

    // Reading order alone would say present(0) < flashback(1).
    expect(compareSceneTime(index, "reading", "present", "flashback")).toBe(-1);
    // Story (graph-aware) order reverses that: flashback happened first.
    expect(compareSceneTime(index, "story", "flashback", "present")).toBe(-1);
    expect(index.resolvedStoryRanks.get("flashback")).toBeLessThan(
      index.resolvedStoryRanks.get("present")!,
    );
  });
});
