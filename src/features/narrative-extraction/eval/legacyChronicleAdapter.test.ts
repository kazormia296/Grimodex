import { describe, expect, it } from "vitest";
import {
  evaluateLegacyChronicleResponse,
  prepareLegacyChronicleEvalCase,
} from "./legacyChronicleAdapter";
import type { NarrativeEvalCaseV1 } from "./types";

function evalCase(): NarrativeEvalCaseV1 {
  return {
    schemaVersion: 1,
    id: "chronicle.micro.legacy-001",
    scope: { slice: "chronicle", tier: "micro" },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-08-10T00:00:00.000Z",
    coverage: {
      mode: "complete",
      includedDocumentIds: ["scene-001"],
      omittedDocumentIds: [],
    },
    documents: [{ id: "scene-001", title: "鐘楼", text: "鐘が三度鳴った。" }],
    expected: {
      observations: {
        required: [
          {
            id: "bell",
            semanticKey: "bell-rang",
            dimensions: {
              eventDetection: true,
              actuality: "actual",
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

describe("legacy Chronicle evaluation adapter", () => {
  it("本番prompt/parserを共有し、未提供の意味次元をpass扱いしない", async () => {
    const prepared = await prepareLegacyChronicleEvalCase(evalCase());
    expect(prepared.prompt).toContain("鐘が三度鳴った");
    expect(prepared.prompt).toContain("evidenceSceneIds");

    const result = evaluateLegacyChronicleResponse(
      prepared,
      '{"events":[{"title":"鐘が三度鳴る","evidenceSceneIds":["scene-001"]}]}',
    );

    expect(result.parseStatus).toBe("parsed");
    expect(result.passed).toBe(false);
    expect(result.actual.observations[0]?.dimensions.actuality).toEqual(
      expect.objectContaining({ status: "unobservable" }),
    );
    expect(result.criticalViolations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ classId: "unresolved-evidence" }),
      ]),
    );
  });

  it("parse failureを正常0件へ畳まずhard failureにする", async () => {
    const prepared = await prepareLegacyChronicleEvalCase(evalCase());
    const result = evaluateLegacyChronicleResponse(prepared, "not json");

    expect(result.parseStatus).toBe("invalid");
    expect(result.criticalViolations).toEqual([
      expect.objectContaining({ classId: "parse-failure-as-empty" }),
    ]);
    expect(result.passed).toBe(false);
  });
});
