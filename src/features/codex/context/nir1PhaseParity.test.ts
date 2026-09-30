import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { CodexEntryPhase } from "@/db/schema";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  buildSceneTimeIndex,
  type PhaseResolutionMode,
} from "./sceneTimeIndex";
import { resolveApplicablePhases } from "./resolveApplicablePhases";

interface PhaseCase {
  id: string;
  scenes: {
    sceneId: string;
    sortOrder: string;
    rawStoryKey: string | null;
  }[];
  phases: {
    id: string;
    label: string;
    anchorNodeId: string | null;
    createdAt: string;
  }[];
  phaseValue: string;
  mode: PhaseResolutionMode;
  querySceneId: string;
  expected: { eligible: boolean; reason: string | null };
}

const cases = JSON.parse(
  readFileSync(
    "src-tauri/crates/grimodex-db/src/narrative_extraction/phase-cases.json",
    "utf8",
  ),
) as PhaseCase[];

function scene(
  projectId: string,
  value: PhaseCase["scenes"][number],
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

function phase(
  projectId: string,
  value: PhaseCase["phases"][number],
): CodexEntryPhase {
  return {
    id: value.id,
    entryId: `${projectId}-entry`,
    anchorNodeId: value.anchorNodeId,
    label: value.label,
    summaryOverride: null,
    contentOverride: null,
    contextModeOverride: null,
    version: 0,
    createdAt: value.createdAt,
    updatedAt: value.createdAt,
  };
}

function resolvePhaseValue(value: PhaseCase) {
  const projectId = `phase-parity-${value.id}`;
  const index = buildSceneTimeIndex(
    value.scenes.map((item) => scene(projectId, item)),
  );
  if (value.phaseValue === "draft") {
    return { eligible: true, reason: null };
  }
  const phases = value.phases.map((item) => phase(projectId, item));
  const matches = phases.filter(
    (item) => item.id === value.phaseValue || item.label === value.phaseValue,
  );
  if (matches.length === 0) {
    return { eligible: false, reason: "a3-phase-unavailable" };
  }
  if (matches.length !== 1) {
    return { eligible: false, reason: "a3-phase-ambiguous" };
  }
  const target = matches[0];
  if (
    target.anchorNodeId === null ||
    !index.readingOrder.has(target.anchorNodeId)
  ) {
    return { eligible: false, reason: "a3-phase-anchor-unavailable" };
  }
  const resolution = resolveApplicablePhases({
    phases,
    index,
    mode: value.mode,
    anchor: { kind: "scene", sceneId: value.querySceneId },
  });
  if (resolution.applicablePhases.some((item) => item.id === target.id)) {
    return { eligible: true, reason: null };
  }
  return { eligible: false, reason: "a3-phase-future" };
}

it.each(cases)("$id: matches Native phase eligibility", (value) => {
  expect(resolvePhaseValue(value)).toEqual(value.expected);
});
