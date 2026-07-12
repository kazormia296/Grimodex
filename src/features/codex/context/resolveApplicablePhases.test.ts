import { describe, expect, it } from "vitest";
import type { CodexEntryPhase } from "@/db/schema";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { buildSceneTimeIndex } from "./sceneTimeIndex";
import {
  findEffectiveOverridePhase,
  resolveApplicablePhases,
  resolvePhaseEditState,
} from "./resolveApplicablePhases";

function scene(
  id: string,
  sortOrder: string,
  storyTimeOrder: string | null = null,
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
  };
}

function phase(
  id: string,
  anchorNodeId: string | null,
  createdAt = "2026-01-01T00:00:00.000Z",
): CodexEntryPhase {
  return {
    id,
    entryId: "entry-1",
    anchorNodeId,
    label: id,
    summaryOverride: id,
    contentOverride: null,
    contextModeOverride: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function ids(result: ReturnType<typeof resolveApplicablePhases>): string[] {
  return result.applicablePhases.map((item) => item.id);
}

function orderedIds(
  result: ReturnType<typeof resolveApplicablePhases>,
): string[] {
  return result.orderedPhases.map((item) => item.id);
}

describe("resolveApplicablePhases", () => {
  it("prevents a lone chapter-8 story key from leaking its phase into chapter 1 in auto", () => {
    const index = buildSceneTimeIndex([
      scene("chapter-1", "a0"),
      scene("chapter-8", "a1", "a0"),
    ]);
    const result = resolveApplicablePhases({
      phases: [phase("future", "chapter-8")],
      index,
      mode: "auto",
      anchor: { kind: "scene", sceneId: "chapter-1" },
    });

    expect(ids(result)).toEqual([]);
    expect(result.axisUsed).toBe("reading");
    expect(result.fallbackReason).toBe("auto-incomplete-story-coverage");
  });

  it("makes all-unscheduled auto equivalent to reading", () => {
    const index = buildSceneTimeIndex([scene("s1", "a0"), scene("s2", "a1")]);
    const phases = [phase("p1", "s1")];
    const auto = resolveApplicablePhases({
      phases,
      index,
      mode: "auto",
      anchor: { kind: "scene", sceneId: "s2" },
    });
    const reading = resolveApplicablePhases({
      phases,
      index,
      mode: "reading",
      anchor: { kind: "scene", sceneId: "s2" },
    });

    expect(ids(auto)).toEqual(ids(reading));
    expect(auto.axisUsed).toBe("reading");
  });

  it("makes fully-scheduled auto equivalent to story", () => {
    const index = buildSceneTimeIndex([
      scene("later", "a0", "z0"),
      scene("earlier", "a1", "a0"),
    ]);
    const phases = [phase("past", "earlier"), phase("future", "later")];
    const auto = resolveApplicablePhases({
      phases,
      index,
      mode: "auto",
      anchor: { kind: "scene", sceneId: "earlier" },
    });
    const story = resolveApplicablePhases({
      phases,
      index,
      mode: "story",
      anchor: { kind: "scene", sceneId: "earlier" },
    });

    expect(ids(auto)).toEqual(["past"]);
    expect(ids(auto)).toEqual(ids(story));
    expect(auto.axisUsed).toBe("story");
    expect(auto.fallbackReason).toBeNull();
  });

  it("uses inherited story time for an unscheduled scene after an explicit key", () => {
    const index = buildSceneTimeIndex([
      scene("anchor", "a0", "k0"),
      scene("current", "a1"),
    ]);
    const result = resolveApplicablePhases({
      phases: [phase("p1", "anchor")],
      index,
      mode: "story",
      anchor: { kind: "scene", sceneId: "current" },
    });

    expect(ids(result)).toEqual(["p1"]);
    expect(result.axisUsed).toBe("story");
    expect(result.fallbackReason).toBeNull();
  });

  it("falls the whole entry back to reading when current story time is unresolved", () => {
    const index = buildSceneTimeIndex([
      scene("leading", "a0"),
      scene("scheduled", "a1", "k0"),
    ]);
    const result = resolveApplicablePhases({
      phases: [phase("future", "scheduled")],
      index,
      mode: "story",
      anchor: { kind: "scene", sceneId: "leading" },
    });

    expect(ids(result)).toEqual([]);
    expect(result.axisUsed).toBe("reading");
    expect(result.fallbackReason).toBe("story-current-unresolved");
  });

  it("falls the whole entry back to reading when a valid phase anchor has no story time", () => {
    const index = buildSceneTimeIndex([
      scene("leading", "a0"),
      scene("current", "a1", "k0"),
    ]);
    const result = resolveApplicablePhases({
      phases: [phase("leading-phase", "leading")],
      index,
      mode: "story",
      anchor: { kind: "scene", sceneId: "current" },
    });

    expect(ids(result)).toEqual(["leading-phase"]);
    expect(orderedIds(result)).toEqual(["leading-phase"]);
    expect(result.axisUsed).toBe("reading");
    expect(result.fallbackReason).toBe("story-anchor-unresolved");
  });

  it("skips null and deleted anchors without forcing a story fallback", () => {
    const index = buildSceneTimeIndex([
      scene("anchor", "a0", "a0"),
      scene("current", "a1", "b0"),
    ]);
    const result = resolveApplicablePhases({
      phases: [
        phase("null", null),
        phase("deleted", "deleted"),
        phase("valid", "anchor"),
      ],
      index,
      mode: "story",
      anchor: { kind: "scene", sceneId: "current" },
    });

    expect(ids(result)).toEqual(["valid"]);
    expect(result.axisUsed).toBe("story");
    expect(result.fallbackReason).toBeNull();
    expect(result.skippedPhaseIds).toEqual(["null", "deleted"]);
  });

  it("uses reading order as the cutoff tie-break for equal story keys", () => {
    const index = buildSceneTimeIndex([
      scene("first", "a0", "k0"),
      scene("second", "a1", "k0"),
    ]);
    const result = resolveApplicablePhases({
      phases: [phase("at-first", "first"), phase("at-second", "second")],
      index,
      mode: "story",
      anchor: { kind: "scene", sceneId: "first" },
    });

    expect(ids(result)).toEqual(["at-first"]);
    expect(orderedIds(result)).toEqual(["at-first", "at-second"]);
  });

  it("sorts equal-time phases by anchor reading order, createdAt, then id", () => {
    const index = buildSceneTimeIndex([
      scene("first", "a0", "k0"),
      scene("second", "a1", "k0"),
    ]);
    const phases = [
      phase("z", "first", "2026-01-01T00:00:00.000Z"),
      phase("a", "first", "2026-01-01T00:00:00.000Z"),
      phase("later-created", "first", "2026-01-02T00:00:00.000Z"),
      phase("second-anchor", "second", "2025-01-01T00:00:00.000Z"),
    ];
    const result = resolveApplicablePhases({
      phases: [...phases].reverse(),
      index,
      mode: "story",
      anchor: { kind: "latest" },
    });

    expect(ids(result)).toEqual(["a", "z", "later-created", "second-anchor"]);
    expect(orderedIds(result)).toEqual(ids(result));
  });

  it("does not depend on phase input permutation", () => {
    const index = buildSceneTimeIndex([
      scene("first", "a0", "k0"),
      scene("second", "a1", "k0"),
    ]);
    const phases = [phase("b", "first"), phase("a", "first")];
    const resolve = (input: CodexEntryPhase[]) =>
      ids(
        resolveApplicablePhases({
          phases: input,
          index,
          mode: "story",
          anchor: { kind: "latest" },
        }),
      );

    expect(resolve(phases)).toEqual(["a", "b"]);
    expect(resolve([...phases].reverse())).toEqual(["a", "b"]);
  });

  it("makes base explicit and latest include every valid phase", () => {
    const index = buildSceneTimeIndex([scene("s1", "a0"), scene("s2", "a1")]);
    const phases = [phase("p2", "s2"), phase("p1", "s1")];
    const base = resolveApplicablePhases({
      phases,
      index,
      mode: "reading",
      anchor: { kind: "base" },
    });
    const latest = resolveApplicablePhases({
      phases,
      index,
      mode: "reading",
      anchor: { kind: "latest" },
    });

    expect(ids(base)).toEqual([]);
    expect(orderedIds(base)).toEqual([]);
    expect(base.axisUsed).toBeNull();
    expect(ids(latest)).toEqual(["p1", "p2"]);
    expect(orderedIds(latest)).toEqual(["p1", "p2"]);
  });

  it("returns base diagnostics when the current scene no longer exists", () => {
    const index = buildSceneTimeIndex([scene("s1", "a0")]);
    const result = resolveApplicablePhases({
      phases: [phase("p1", "s1")],
      index,
      mode: "reading",
      anchor: { kind: "scene", sceneId: "deleted" },
    });

    expect(ids(result)).toEqual([]);
    expect(result.axisUsed).toBeNull();
    expect(result.fallbackReason).toBe("current-scene-missing");
  });

  it("keeps an earlier field override effective when a later phase inherits it", () => {
    const index = buildSceneTimeIndex([scene("s1", "a0"), scene("s2", "a1")]);
    const earlier = {
      ...phase("earlier", "s1"),
      summaryOverride: "effective summary",
      contentOverride: "effective content",
    };
    const later = {
      ...phase("later", "s2"),
      summaryOverride: null,
    };
    const resolution = resolveApplicablePhases({
      phases: [later, earlier],
      index,
      mode: "reading",
      anchor: { kind: "scene", sceneId: "s2" },
    });

    expect(findEffectiveOverridePhase(resolution, "summaryOverride")?.id).toBe(
      "earlier",
    );
    expect(findEffectiveOverridePhase(resolution, "contentOverride")?.id).toBe(
      "earlier",
    );
  });

  it("seeds inherited values but targets edits at the active Phase", () => {
    const index = buildSceneTimeIndex([scene("s1", "a0"), scene("s2", "a1")]);
    const earlier = {
      ...phase("earlier", "s1"),
      summaryOverride: "inherited summary",
      contentOverride: "inherited content",
    };
    const active = {
      ...phase("active", "s2"),
      summaryOverride: null,
    };
    const resolution = resolveApplicablePhases({
      phases: [active, earlier],
      index,
      mode: "reading",
      anchor: { kind: "scene", sceneId: "s2" },
    });

    expect(
      resolvePhaseEditState(resolution, {
        summary: "base summary",
        content: "base content",
      }),
    ).toEqual({
      targetPhase: active,
      summary: "inherited summary",
      content: "inherited content",
    });
  });

  it("cuts an explicit preview at the target Phase identity on a shared anchor", () => {
    const index = buildSceneTimeIndex([scene("shared", "a0")]);
    const createdAt = "2026-01-01T00:00:00.000Z";
    const earlier = {
      ...phase("a-earlier", "shared", createdAt),
      contentOverride: "inherited content",
    };
    const target = {
      ...phase("b-target", "shared", createdAt),
      contentOverride: null,
    };
    const later = {
      ...phase("c-later", "shared", createdAt),
      contentOverride: "must not leak",
    };

    const resolution = resolveApplicablePhases({
      phases: [later, target, earlier],
      index,
      mode: "reading",
      anchor: { kind: "phase", phaseId: target.id },
    });

    expect(orderedIds(resolution)).toEqual([
      "a-earlier",
      "b-target",
      "c-later",
    ]);
    expect(ids(resolution)).toEqual(["a-earlier", "b-target"]);
    expect(findEffectiveOverridePhase(resolution, "contentOverride")?.id).toBe(
      "a-earlier",
    );
  });

  it("fails closed when an explicit preview Phase identity is unknown", () => {
    const result = resolveApplicablePhases({
      phases: [phase("known", "s1")],
      index: buildSceneTimeIndex([scene("s1", "a0")]),
      mode: "reading",
      anchor: { kind: "phase", phaseId: "missing" },
    });

    expect(ids(result)).toEqual([]);
    expect(result.fallbackReason).toBe("phase-target-missing");
  });
});
