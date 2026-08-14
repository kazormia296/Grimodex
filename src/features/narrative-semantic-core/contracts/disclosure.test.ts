import { describe, expect, it } from "vitest";

import {
  evaluateNarrativeDisclosure,
  type NarrativeDisclosureContext,
} from "./disclosure";

const context: NarrativeDisclosureContext = {
  projectId: "project-1",
  currentSceneId: "scene-2",
  phaseResolutionMode: "reading",
  phaseResolution: {
    axisUsed: "reading",
    fallbackReason: null,
    resolver: "adr-002",
  },
  temporalAnchor: "scene-2",
  viewpointRef: "character-a",
  knowledgeHolderRef: "character-a",
  audienceRef: "character-a",
  allowSecrets: false,
  currentPhase: 1,
  currentStoryTime: 10,
  currentSceneOrder: 2,
};

const scope = {
  scopeStatus: "explicit" as const,
  sceneRef: "scene-2",
  viewpointRef: "character-a",
  knowledgeHolderRef: "character-a",
  audienceRef: "character-a",
};

describe("narrative retrieval disclosure", () => {
  it("uses the resolved axis for temporal admission before ranking", () => {
    expect(
      evaluateNarrativeDisclosure(context, {
        projectId: "project-1",
        scope,
        phase: 2,
        storyTime: 9,
      }).admitted,
    ).toBe(false);
    const readingAxis = evaluateNarrativeDisclosure(context, {
      projectId: "project-1",
      scope,
      phase: 1,
      storyTime: 11,
    });
    expect(readingAxis.reasons).not.toContain("future-story-time");

    const storyAxis = evaluateNarrativeDisclosure(
      {
        ...context,
        phaseResolution: {
          axisUsed: "story",
          fallbackReason: null,
          resolver: "adr-002",
        },
      },
      { projectId: "project-1", scope, phase: 1, storyTime: 11 },
    );
    expect(storyAxis.reasons).toContain("future-story-time");
  });

  it("uses the same temporal result for auto mode", () => {
    const incompleteAuto = evaluateNarrativeDisclosure(
      {
        ...context,
        phaseResolutionMode: "auto",
        phaseResolution: {
          axisUsed: "reading",
          fallbackReason: "auto-incomplete-story-coverage",
          resolver: "adr-002",
        },
      },
      { projectId: "project-1", scope, phase: 2, storyTime: 11, sceneOrder: 3 },
    );
    const completeAuto = evaluateNarrativeDisclosure(
      {
        ...context,
        phaseResolutionMode: "auto",
        phaseResolution: {
          axisUsed: "story",
          fallbackReason: null,
          resolver: "adr-002",
        },
      },
      { projectId: "project-1", scope, phase: 2, storyTime: 11, sceneOrder: 3 },
    );
    expect(incompleteAuto.reasons).toContain("future-scene");
    expect(completeAuto.reasons).not.toContain("future-scene");
    expect(completeAuto.reasons).toContain("future-phase");

    const readingOrderAlreadySeen = evaluateNarrativeDisclosure(
      {
        ...context,
        currentStoryTime: 8,
        phaseResolutionMode: "reading",
      },
      { projectId: "project-1", scope, sceneOrder: 2, storyTime: 9 },
    );
    expect(readingOrderAlreadySeen.reasons).not.toContain("future-story-time");
    expect(readingOrderAlreadySeen.reasons).not.toContain("future-scene");
  });

  it("applies validFromRef and validUntilRef on the ADR-002 axis and fails closed", () => {
    const temporalOrders: Record<string, number> = {
      "scene-1:reading": 1,
      "scene-2:reading": 2,
      "scene-3:reading": 3,
      "story-1:story": 4,
      "story-2:story": 8,
    };
    const resolveTemporalRef = (ref: string, axis: "reading" | "story") =>
      temporalOrders[`${ref}:${axis}`] ?? null;

    const before = evaluateNarrativeDisclosure(
      { ...context, resolveTemporalRef },
      {
        projectId: "project-1",
        scope: { ...scope, validFromRef: "scene-3" },
      },
    );
    expect(before.reasons).toContain("future-valid-from");

    const after = evaluateNarrativeDisclosure(
      { ...context, resolveTemporalRef },
      {
        projectId: "project-1",
        scope: { ...scope, validUntilRef: "scene-1" },
      },
    );
    expect(after.reasons).toContain("expired-valid-until");

    const unresolved = evaluateNarrativeDisclosure(context, {
      projectId: "project-1",
      scope: { ...scope, validFromRef: "missing" },
    });
    expect(unresolved.reasons).toContain("unresolved-valid-from-ref");
  });

  it("does not leak secrets or character knowledge across holders", () => {
    expect(
      evaluateNarrativeDisclosure(context, {
        projectId: "project-1",
        scope,
        foreshadow: { secret: true, revealSceneOrder: 3 },
      }).reasons,
    ).toContain("secret-before-reveal");
    expect(
      evaluateNarrativeDisclosure(context, {
        projectId: "project-1",
        scope: { ...scope, knowledgeHolderRef: "character-b" },
      }).reasons,
    ).toContain("knowledge-holder-mismatch");
    expect(
      evaluateNarrativeDisclosure(context, {
        projectId: "project-1",
        scope: { ...scope, audienceRef: "reader" },
      }).reasons,
    ).toContain("reader-knowledge-not-character");
  });

  it("rejects worldline, timeline, and narrative-layer mismatches", () => {
    const scoped = {
      projectId: "project-1",
      scope: {
        ...scope,
        worldlineRef: "alternate",
        timelineRef: "timeline-b",
        narrativeLayer: "frame",
      },
    };
    expect(
      evaluateNarrativeDisclosure(
        {
          ...context,
          worldlineRef: "main",
          timelineRef: "timeline-a",
          narrativeLayer: "story",
        },
        scoped,
      ).reasons,
    ).toEqual(
      expect.arrayContaining([
        "worldline-mismatch",
        "timeline-mismatch",
        "narrative-layer-mismatch",
      ]),
    );
  });

  it("rejects unresolved or missing candidate scope instead of treating it as global", () => {
    expect(
      evaluateNarrativeDisclosure(context, {
        projectId: "project-1",
        scope: { scopeStatus: "unresolved" },
      }).reasons,
    ).toContain("unresolved-scope");
    expect(
      evaluateNarrativeDisclosure(context, {
        projectId: "project-1",
        scope: undefined as never,
      }).reasons,
    ).toContain("unresolved-scope");
  });

  it("rejects explicit audience and viewpoint identities from another context", () => {
    const decision = evaluateNarrativeDisclosure(context, {
      projectId: "project-1",
      scope: {
        ...scope,
        audienceRef: "character-b",
        viewpointRef: "character-b",
      },
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["audience-mismatch", "viewpoint-mismatch"]),
    );
  });

  it("rejects an explicit scene scope from another scene while allowing omitted axes", () => {
    const decision = evaluateNarrativeDisclosure(context, {
      projectId: "project-1",
      scope: { scopeStatus: "explicit", sceneRef: "scene-3" },
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reasons).toContain("scene-scope-mismatch");
  });
});
