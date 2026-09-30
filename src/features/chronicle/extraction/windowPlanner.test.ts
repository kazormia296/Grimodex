import { describe, expect, it } from "vitest";
import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import type { NarrativeSnapshotBuildInput } from "@/features/narrative-extraction/source/types";
import {
  assertOwnedRangesPartition,
  planExtractionWindows,
} from "./windowPlanner";

function prose(...paragraphs: string[]): string {
  return JSON.stringify({
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : [],
    })),
  });
}

function snapshotInput(
  documents: NarrativeSnapshotBuildInput["documents"],
): NarrativeSnapshotBuildInput {
  return {
    snapshotId: "snapshot-window",
    language: "ja",
    origin: { kind: "grimodex-project", projectId: "project-a" },
    documents,
    omissions: [],
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

describe("planExtractionWindows", () => {
  it("uses one window per short scene with S0001-style source refs", async () => {
    const built = await buildNarrativeCorpusSnapshot(
      snapshotInput([
        {
          sourceKey: "project:scene:one",
          parentSourceKey: null,
          title: "第一場",
          orderIndex: 0,
          proseMirrorJson: prose("雨が降った。門が開いた。"),
          origin: {
            kind: "project-node",
            projectId: "project-a",
            nodeId: "scene-one",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
            sourceUri: null,
          },
        },
        {
          sourceKey: "project:scene:two",
          parentSourceKey: null,
          title: "第二場",
          orderIndex: 1,
          proseMirrorJson: prose("鐘が鳴った。"),
          origin: {
            kind: "project-node",
            projectId: "project-a",
            nodeId: "scene-two",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-09T00:01:00.000Z",
            sourceUri: null,
          },
        },
      ]),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const plan = planExtractionWindows(built.snapshot);
    expect(plan.windows).toHaveLength(2);
    expect(plan.windows.map((window) => window.sourceRef)).toEqual([
      "S0001",
      "S0002",
    ]);
    expect(assertOwnedRangesPartition(built.snapshot, plan)).toBe(true);
    for (const window of plan.windows) {
      expect(window.ownedRanges).toHaveLength(1);
      expect(window.contextRanges).toEqual([]);
    }
  });

  it("splits long scenes on block boundaries without owned gaps or overlaps", async () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, index) => `段落${index}。${"あ".repeat(80)}`,
    );
    const built = await buildNarrativeCorpusSnapshot(
      snapshotInput([
        {
          sourceKey: "project:scene:long",
          parentSourceKey: null,
          title: "長い場",
          orderIndex: 0,
          proseMirrorJson: prose(...paragraphs),
          origin: {
            kind: "project-node",
            projectId: "project-a",
            nodeId: "scene-long",
            sourceVersion: 1,
            sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
            sourceUri: null,
          },
        },
      ]),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const textLength = built.snapshot.documents[0].canonical.text.length;
    expect(textLength).toBeGreaterThan(500);

    const plan = planExtractionWindows(built.snapshot, {
      maxOwnedChars: 500,
      contextRadiusChars: 40,
    });
    expect(plan.windows.length).toBeGreaterThan(1);
    expect(assertOwnedRangesPartition(built.snapshot, plan)).toBe(true);

    for (const window of plan.windows) {
      const ownedLen = window.ownedRanges.reduce(
        (sum, range) => sum + (range.end - range.start),
        0,
      );
      expect(ownedLen).toBeLessThanOrEqual(500);
      for (const context of window.contextRanges) {
        for (const owned of window.ownedRanges) {
          expect(context.end <= owned.start || context.start >= owned.end).toBe(
            true,
          );
        }
      }
    }
  });
});
