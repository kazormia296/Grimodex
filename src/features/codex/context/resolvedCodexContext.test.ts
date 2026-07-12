import { describe, expect, it } from "vitest";
import type { CodexEntryPhase } from "@/db/schema";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { buildSceneTimeIndex } from "./sceneTimeIndex";
import {
  canIncludeResolvedCodexContext,
  materializeResolvedCodexContext,
  resolveCodexContexts,
} from "./resolvedCodexContext";

const NOW = "2026-01-01T00:00:00.000Z";

function phase(
  overrides: Partial<CodexEntryPhase> & Pick<CodexEntryPhase, "id" | "entryId">,
): CodexEntryPhase {
  return {
    anchorNodeId: "scene-1",
    label: "Now",
    summaryOverride: null,
    contentOverride: null,
    contextModeOverride: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const scene: TreeNodeData = {
  id: "scene-1",
  projectId: "project-1",
  parentId: null,
  nodeType: "scene",
  title: "Scene",
  synopsis: null,
  intent: null,
  sortOrder: "a0",
  status: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  charCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("resolveCodexContexts", () => {
  it("resolves content and visibility for every candidate before selection", () => {
    const entry = {
      id: "entry-1",
      summary: "Base summary",
      content: "Base content",
      contextMode: "hidden",
    };
    const result = resolveCodexContexts({
      entries: [entry],
      phases: [
        phase({
          id: "phase-1",
          entryId: entry.id,
          summaryOverride: "Phase summary",
          contentOverride: "Phase content",
          contextModeOverride: "mentioned",
        }),
      ],
      anchor: { kind: "scene", sceneId: scene.id },
      sceneTimeIndex: buildSceneTimeIndex([scene]),
      resolutionMode: "reading",
    });

    const resolved = result.resolvedById.get(entry.id)!;
    expect(materializeResolvedCodexContext(entry, resolved)).toEqual({
      id: "entry-1",
      summary: "Phase summary",
      content: "Phase content",
      contextMode: "mentioned",
    });
  });
});

describe("canIncludeResolvedCodexContext", () => {
  it("allows suppress only for an explicit pin and never allows hidden", () => {
    expect(canIncludeResolvedCodexContext("suppress", "mention")).toBe(false);
    expect(canIncludeResolvedCodexContext("suppress", "explicit-pin")).toBe(
      true,
    );
    expect(canIncludeResolvedCodexContext("hidden", "explicit-pin")).toBe(
      false,
    );
  });

  it("allows mentioned/always through derived context paths", () => {
    expect(canIncludeResolvedCodexContext("mentioned", "derived")).toBe(true);
    expect(canIncludeResolvedCodexContext("always", "derived")).toBe(true);
  });
});
