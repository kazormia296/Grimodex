import { describe, expect, it } from "vitest";
import type { CodexEntryPhase } from "@/db/schema";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { buildSceneTimeIndex } from "./sceneTimeIndex";
import {
  canIncludeResolvedCodexContext,
  materializeResolvedCodexContext,
  resolveCodexContextExposure,
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
    version: 0,
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
  const triggers = [
    "explicit-pin",
    "current-mention",
    "active-scope",
    "active-tab",
    "always",
    "child",
    "relation",
    "detail-reference",
    "map-reference",
  ] as const;

  it.each([
    { mode: "hidden", allowed: [] },
    { mode: "suppress", allowed: ["explicit-pin", "active-scope"] },
    {
      mode: "mentioned",
      allowed: [
        "explicit-pin",
        "current-mention",
        "active-scope",
        "active-tab",
      ],
    },
    { mode: "always", allowed: triggers },
  ] as const)("applies the $mode trigger matrix", ({ mode, allowed }) => {
    const allowedTriggers = new Set<string>(allowed);
    for (const trigger of triggers) {
      expect(
        canIncludeResolvedCodexContext(mode, trigger),
        `${mode} via ${trigger}`,
      ).toBe(allowedTriggers.has(trigger));
    }
  });

  it("fails closed for an unknown persisted mode", () => {
    for (const mode of [
      "future-mode",
      "toString",
      "constructor",
      "__proto__",
    ]) {
      for (const trigger of triggers) {
        expect(canIncludeResolvedCodexContext(mode, trigger)).toBe(false);
      }
    }
  });

  it.each(["child", "relation", "detail-reference", "map-reference"] as const)(
    "limits a mentioned %s trigger to identity-only exposure",
    (trigger) => {
      expect(resolveCodexContextExposure("mentioned", trigger)).toBe(
        "identity-only",
      );
      expect(canIncludeResolvedCodexContext("mentioned", trigger)).toBe(false);
      expect(resolveCodexContextExposure("always", trigger)).toBe("content");
    },
  );
});
