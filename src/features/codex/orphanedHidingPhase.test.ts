import { describe, expect, it } from "vitest";
import { buildSceneTimeIndex } from "./context/sceneTimeIndex";
import { getOrphanedHidingPhaseDisplay } from "./orphanedHidingPhase";
import type { TreeNodeData } from "@/features/tree/treeStore";

const scene = (id: string, sortOrder: string): TreeNodeData =>
  ({
    id,
    projectId: "p",
    parentId: null,
    nodeType: "scene",
    title: id,
    sortOrder,
    archivedAt: null,
  }) as unknown as TreeNodeData;

const phase = (
  id: string,
  anchorNodeId: string | null,
  mode: string | null,
) => ({
  id,
  label: id,
  anchorNodeId,
  contextModeOverride: mode,
});

describe("getOrphanedHidingPhaseDisplay", () => {
  const index = buildSceneTimeIndex([scene("s1", "a0")]);
  const phases = [phase("o", null, "hidden"), phase("ok", "s1", "hidden")];

  it("warns about the orphaned hiding Phase only", () => {
    const d = getOrphanedHidingPhaseDisplay({
      entryContextMode: "mentioned",
      phases,
      index,
    });
    expect(d.sceneResolvable).toBe(true);
    expect(d.warned.map((p) => p.id)).toEqual(["o"]);
  });

  it("does not warn while the scene order is unresolved, but still lists the Phase", () => {
    const d = getOrphanedHidingPhaseDisplay({
      entryContextMode: "mentioned",
      phases,
      index: buildSceneTimeIndex([]),
    });
    expect(d.sceneResolvable).toBe(false);
    expect(d.warned).toEqual([]);
    expect(d.orphaned.length).toBe(2);
  });

  it("does not warn when the entry is already hidden at base", () => {
    const d = getOrphanedHidingPhaseDisplay({
      entryContextMode: "hidden",
      phases,
      index,
    });
    expect(d.warned).toEqual([]);
    expect(d.orphaned.map((p) => p.id)).toEqual(["o"]);
  });

  it("warns when the entry is hidden at base but a placeable public Phase could release it (the orphaned Phase is what closes it)", () => {
    const d = getOrphanedHidingPhaseDisplay({
      entryContextMode: "hidden",
      phases: [phase("o", null, "hidden"), phase("open", "s1", "always")],
      index,
    });
    expect(d.warned.map((p) => p.id)).toEqual(["o"]);
  });
});
