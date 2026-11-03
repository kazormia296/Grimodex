import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bindEvidenceSpanCatalog } from "@/features/narrative-extraction/evidence/spanCatalog";
import { buildChroniclePromptDigests } from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import { buildCitationIdObservationPromptArtifactFromCaptured } from "./citationIdObservation";
import { buildSynthesisPromptArtifact } from "./runEventSynthesisTask";
import {
  currentFrozenContracts,
  frozenContractForDigest,
  withComponentContract,
} from "./chronicleFrozenContracts.testSupport";

const directory =
  "src-tauri/crates/grimodex-db/src/narrative_extraction/material_roster/";
const golden = JSON.parse(
  readFileSync(directory + "production-golden.json", "utf8"),
);
it("replays independent cold production receipt seals with the live TS builders", async () => {
  const contracts: Record<string, unknown> = {};
  const sealedVersions: Record<string, Set<string>> = {};
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
    // The receipt seal selects one frozen accepted contract (current or superseded).
    const frozen = await frozenContractForDigest(
      execution.stageId,
      receipt.componentContractDigest,
    );
    expect(frozen).not.toBeNull();
    if (!frozen) return;
    const digests = await buildChroniclePromptDigests(
      withComponentContract(artifact, frozen),
    );
    expect(digests).toEqual({
      contextSetDigest: receipt.contextSetDigest,
      componentContractDigest: receipt.componentContractDigest,
      finalRequestDigest: receipt.finalRequestDigest,
    });
    contracts[execution.stageId] = artifact.componentContract;
    (sealedVersions[execution.stageId] ??= new Set()).add(
      frozen.contractVersion,
    );
  }
  expect(contracts).toEqual(currentFrozenContracts());
  // This cold fixture was sealed under Event Synthesis v2, which stays accepted beside v3.
  expect([...(sealedVersions.narrative_event_synthesize ?? [])]).toEqual(["2"]);
});

it("pins the live v3 Event Synthesis requests that Native replays for the same inputs", async () => {
  const expected = JSON.parse(
    readFileSync(
      directory + "production-golden-v3-synthesis-requests.json",
      "utf8",
    ),
  );
  const actual = [];
  for (const output of golden.outputs) {
    const artifact = buildSynthesisPromptArtifact({
      clusterRef: output.clusterRef,
      observations: output.rawObservations.observations,
    });
    expect(artifact.componentContract.contractVersion).toBe("3");
    actual.push({
      rootStageExecutionId: output.rootStageExecutionId,
      ...(await buildChroniclePromptDigests(artifact)),
    });
  }
  expect(actual).toEqual(expected.requests);
});
