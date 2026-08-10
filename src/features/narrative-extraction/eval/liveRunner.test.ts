import { describe, expect, it, vi } from "vitest";
import { runLegacyChronicleLiveBaseline } from "./liveRunner";
import type { NarrativeEvalCaseV1 } from "./types";

const CASE: NarrativeEvalCaseV1 = {
  schemaVersion: 1,
  id: "chronicle.micro.live-runner-001",
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

describe("runLegacyChronicleLiveBaseline", () => {
  it("runs once per isolated case, seals replay provenance, and never certifies legacy output", async () => {
    const dispatch = vi.fn(async (_prompt: string) => ({
      rawText:
        '{"events":[{"title":"鐘が鳴る","evidenceSceneIds":["scene-001"]}]}',
      requestedModel: "openai/gpt-5.6-luna",
      resolvedModel: "openai/gpt-5.6-luna-20260709",
      provider: "openrouter",
      reasoningEffort: "medium",
      inputTokens: 100,
      outputTokens: 20,
      runtimeMs: 500,
      costUsd: 0.001,
    }));

    const report = await runLegacyChronicleLiveBaseline([CASE], dispatch, {
      runId: "run-001",
      now: () => "2026-08-10T01:02:03.000Z",
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toContain("鐘が三度鳴った");
    expect(report.certificationEligible).toBe(false);
    expect(report.summary).toMatchObject({ total: 1, measured: 1, passed: 0 });
    expect(report.cases[0]).toMatchObject({
      caseId: CASE.id,
      evaluation: { passed: false },
      replay: {
        caseId: CASE.id,
        model: {
          requestedModel: "openai/gpt-5.6-luna",
          resolvedModel: "openai/gpt-5.6-luna-20260709",
        },
      },
    });
    expect(JSON.stringify(report)).not.toMatch(/apiKey|authorization|Bearer/i);
  });
});
