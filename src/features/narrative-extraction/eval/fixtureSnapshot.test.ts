import { describe, expect, it } from "vitest";
import { buildNarrativeEvalFixture } from "./fixtureSnapshot";
import type { NarrativeEvalCaseV1 } from "./types";

function fixtureCase(): NarrativeEvalCaseV1 {
  return {
    schemaVersion: 1,
    id: "chronicle.micro.fixture-001",
    scope: { slice: "chronicle", tier: "micro" },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-08-10T00:00:00.000Z",
    coverage: {
      mode: "complete",
      includedDocumentIds: ["scene-001"],
      omittedDocumentIds: [],
    },
    documents: [
      {
        id: "scene-001",
        title: "鐘楼",
        text: "鐘が三度鳴った。\n旅人は走った。",
      },
    ],
    expected: {
      observations: {
        required: [
          {
            id: "bell",
            semanticKey: "bell-rang",
            dimensions: {
              evidence: [{ documentId: "scene-001", quote: "鐘が三度鳴った" }],
            },
          },
        ],
        forbidden: [],
      },
    },
    criticalViolationClasses: [],
  };
}

describe("buildNarrativeEvalFixture", () => {
  it("plain text fixtureを本番Snapshot/SourceView/Evidence resolverへ通す", async () => {
    const built = await buildNarrativeEvalFixture(fixtureCase());

    expect(built.snapshot.documents).toHaveLength(1);
    expect(built.snapshot.documents[0]?.canonical.text).toBe(
      "鐘が三度鳴った。\n旅人は走った。",
    );
    expect(built.sourceViews).toEqual([
      expect.objectContaining({
        ref: "scene-001",
        text: "鐘が三度鳴った。\n旅人は走った。",
      }),
    ]);
    expect(built.goldEvidence).toEqual([
      expect.objectContaining({
        expectationId: "bell",
        status: "resolved",
        quote: "鐘が三度鳴った",
      }),
    ]);
  });
});
