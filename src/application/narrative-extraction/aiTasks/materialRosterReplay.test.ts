import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bindEvidenceSpanCatalog } from "@/features/narrative-extraction/evidence/spanCatalog";
import { buildChroniclePromptDigests } from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import { buildCitationIdObservationPromptArtifactFromCaptured } from "./citationIdObservation";
import { buildSynthesisPromptArtifact } from "./runEventSynthesisTask";

const directory =
  "src-tauri/crates/grimodex-db/src/narrative_extraction/material_roster/";
const golden = JSON.parse(
  readFileSync(directory + "production-golden.json", "utf8"),
);
it("replays independent cold production receipt seals with the live TS builders", async () => {
  const contracts: Record<string, unknown> = {};
  const snap = golden.snapshot;
  for (const receipt of golden.receipts) {
    const execution = receipt.stageExecution;
    let artifact;
    if (execution.stageId === "narrative_observation_extract") {
      const window = golden.plan.windows[0];
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
      artifact = buildCitationIdObservationPromptArtifactFromCaptured(
        [{ ...window, text: sourceView.text }],
        binding,
      );
    } else {
      const output = golden.outputs.find(
        (v: { rootStageExecutionId: string }) =>
          v.rootStageExecutionId === execution.stageExecutionId,
      );
      artifact = buildSynthesisPromptArtifact({
        clusterRef: output.clusterRef,
        observations: output.rawObservations.observations,
      });
    }
    const digests = await buildChroniclePromptDigests(artifact);
    expect(digests).toEqual({
      contextSetDigest: receipt.contextSetDigest,
      componentContractDigest: receipt.componentContractDigest,
      finalRequestDigest: receipt.finalRequestDigest,
    });
    contracts[execution.stageId] = artifact.componentContract;
  }
  expect(contracts).toEqual(
    JSON.parse(readFileSync(directory + "contracts.json", "utf8")),
  );
});
