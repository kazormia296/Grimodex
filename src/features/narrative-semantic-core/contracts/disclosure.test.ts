import { describe, expect, it } from "vitest";

import {
  evaluateNarrativeDisclosure,
  type NarrativeDisclosureContext,
} from "./disclosure";

const context: NarrativeDisclosureContext = {
  projectId: "project-1",
  currentSceneId: "scene-2",
  phaseResolutionMode: "reading",
  temporalAnchor: "scene-2",
  viewpointRef: "character-a",
  knowledgeHolderRef: "character-a",
  audienceRef: "character-a",
  allowSecrets: false,
  currentPhase: 1,
  currentStoryTime: 10,
  currentSceneOrder: 2,
};

describe("narrative retrieval disclosure", () => {
  it("rejects future phase and story-time candidates before ranking admission", () => {
    expect(
      evaluateNarrativeDisclosure(context, {
        projectId: "project-1",
        phase: 2,
        storyTime: 9,
      }).admitted,
    ).toBe(false);
    expect(
      evaluateNarrativeDisclosure(context, {
        projectId: "project-1",
        phase: 1,
        storyTime: 11,
      }).reasons,
    ).toContain("future-story-time");
  });

  it("uses the same temporal result for auto mode", () => {
    const auto = evaluateNarrativeDisclosure(
      { ...context, phaseResolutionMode: "auto" },
      { projectId: "project-1", phase: 2, storyTime: 11 },
    );
    const story = evaluateNarrativeDisclosure(
      { ...context, phaseResolutionMode: "story" },
      { projectId: "project-1", phase: 2, storyTime: 11 },
    );
    expect(auto).toEqual(story);
  });

  it("does not leak secrets or character knowledge across holders", () => {
    expect(
      evaluateNarrativeDisclosure(context, {
        projectId: "project-1",
        foreshadow: { secret: true, revealSceneOrder: 3 },
      }).reasons,
    ).toContain("secret-before-reveal");
    expect(
      evaluateNarrativeDisclosure(context, {
        projectId: "project-1",
        knowledgeHolderRef: "character-b",
      }).reasons,
    ).toContain("knowledge-holder-mismatch");
    expect(
      evaluateNarrativeDisclosure(context, {
        projectId: "project-1",
        audienceRef: "reader",
      }).reasons,
    ).toContain("reader-knowledge-not-character");
  });

  it("rejects worldline, timeline, and narrative-layer mismatches", () => {
    const scoped = {
      projectId: "project-1",
      worldlineRef: "alternate",
      timelineRef: "timeline-b",
      narrativeLayer: "frame",
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
});
