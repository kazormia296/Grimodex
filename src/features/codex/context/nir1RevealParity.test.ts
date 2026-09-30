import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  buildSceneTimeIndex,
  compareSceneTime,
  type PhaseResolutionMode,
} from "./sceneTimeIndex";

interface RevealCase {
  id: string;
  scenes: {
    sceneId: string;
    sortOrder: string;
    rawStoryKey: string | null;
  }[];
  mode: PhaseResolutionMode;
  leftSceneId: string;
  rightSceneId: string;
  expected: number;
}

const cases = JSON.parse(
  readFileSync(
    "src-tauri/crates/grimodex-db/src/narrative_extraction/reveal-cases.json",
    "utf8",
  ),
) as RevealCase[];

function scene(
  projectId: string,
  value: RevealCase["scenes"][number],
): TreeNodeData {
  return {
    id: value.sceneId,
    projectId,
    parentId: null,
    nodeType: "scene",
    title: value.sceneId,
    synopsis: null,
    intent: null,
    sortOrder: value.sortOrder,
    status: null,
    storyTimeOrder: value.rawStoryKey,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

it.each(cases)("$id: matches Native reveal pair ordering", (value) => {
  const projectId = `nir1-reveal-parity-${value.id}`;
  const result = compareSceneTime(
    buildSceneTimeIndex(value.scenes.map((item) => scene(projectId, item))),
    value.mode,
    value.leftSceneId,
    value.rightSceneId,
  );
  expect(Math.sign(result ?? 0)).toBe(Math.sign(value.expected));
});
