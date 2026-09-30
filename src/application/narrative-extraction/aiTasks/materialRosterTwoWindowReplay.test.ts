import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bindEvidenceSpanCatalog } from "@/features/narrative-extraction/evidence/spanCatalog";
import { buildChroniclePromptDigests } from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import { buildCitationIdObservationPromptArtifactFromCaptured } from "./citationIdObservation";
import { buildSynthesisPromptArtifact } from "./runEventSynthesisTask";

const golden = JSON.parse(
  readFileSync(
    "src-tauri/crates/grimodex-db/src/narrative_extraction/material_roster/production-two-window-golden.json",
    "utf8",
  ),
);
it("matches every independent persisted two-window request with production TS builders", async () => {
  expect(golden.plan.windows).toHaveLength(2);
  const usedWindows = new Set<string>();
  const snap = golden.snapshot;
  for (const receipt of golden.receipts) {
    const execution = receipt.stageExecution;
    const expected = {
      contextSetDigest: receipt.contextSetDigest,
      componentContractDigest: receipt.componentContractDigest,
      finalRequestDigest: receipt.finalRequestDigest,
    };
    if (execution.stageId === "narrative_observation_extract") {
      const matches = [];
      for (const window of golden.plan.windows) {
        const sourceView = snap.sourceViews.find(
          (v: { ref: string }) => v.ref === window.sourceRef,
        );
        const binding = await bindEvidenceSpanCatalog(
          snap.snapshot,
          snap.evidence.catalog,
          {
            requestIdentity: `run:${execution.runId}:task:${execution.taskId}:attempt:${execution.attemptId}:window:${window.windowId}`,
            windows: [{ ...window, sourceView }],
          },
        );
        const artifact = buildCitationIdObservationPromptArtifactFromCaptured(
          [{ ...window, text: sourceView.text }],
          binding,
        );
        const digests = await buildChroniclePromptDigests(artifact);
        if (digests.contextSetDigest === expected.contextSetDigest) {
          expect(digests).toEqual(expected);
          matches.push(window.windowId);
        }
      }
      expect(matches).toHaveLength(1);
      expect(usedWindows.has(matches[0])).toBe(false);
      usedWindows.add(matches[0]);
    } else {
      const outputs = golden.outputs.filter(
        (o: { rootStageExecutionId: string }) =>
          o.rootStageExecutionId === execution.stageExecutionId,
      );
      expect(outputs).toHaveLength(1);
      const artifact = buildSynthesisPromptArtifact({
        clusterRef: outputs[0].clusterRef,
        observations: outputs[0].rawObservations.observations,
      });
      expect(await buildChroniclePromptDigests(artifact)).toEqual(expected);
    }
  }
  expect(usedWindows.size).toBe(2);
});
