import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  buildSceneTimeIndex,
  type PhaseResolutionMode,
} from "./sceneTimeIndex";
import { resolveApplicablePhases } from "./resolveApplicablePhases";

interface Case {
  id: string;
  scenes: { sceneId: string; rawStoryKey: string | null }[];
  mode: PhaseResolutionMode;
  s2: string;
  expected: { axisUsed: string | null; fallbackReason: string | null };
}
const cases: Case[] = JSON.parse(
  readFileSync(
    "src-tauri/crates/grimodex-db/src/narrative_extraction/disclosure_precheck/axis-cases.json",
    "utf8",
  ),
);
it.each(cases)(
  "$id: matches existing ADR-002 scene anchor with no phases/graph",
  ({ scenes, mode, s2, expected }) => {
    const nodes: TreeNodeData[] = scenes.map((scene, i) => ({
      id: scene.sceneId,
      projectId: "p1",
      parentId: null,
      nodeType: "scene",
      title: scene.sceneId,
      synopsis: null,
      intent: null,
      sortOrder: `a${i}`,
      status: null,
      storyTimeOrder: scene.rawStoryKey,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      charCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const result = resolveApplicablePhases({
      phases: [],
      index: buildSceneTimeIndex(nodes),
      mode,
      anchor: { kind: "scene", sceneId: s2 },
    });
    expect({
      axisUsed: result.axisUsed,
      fallbackReason: result.fallbackReason,
    }).toEqual(expected);
  },
);
