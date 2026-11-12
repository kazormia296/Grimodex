import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { bindEvidenceSpanCatalog } from "@/features/narrative-extraction/evidence/spanCatalog";
import { buildChroniclePromptDigests } from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import { buildCitationIdObservationPromptArtifactFromCaptured } from "./citationIdObservation";
import { buildSynthesisPromptArtifact } from "./runEventSynthesisTask";
import {
  frozenContractForDigest,
  withComponentContract,
} from "./chronicleFrozenContracts.testSupport";

const GOLDEN_DIR =
  "src-tauri/crates/grimodex-db/src/narrative_extraction/material_roster";
function readGolden(file: string) {
  return JSON.parse(readFileSync(`${GOLDEN_DIR}/${file}`, "utf8"));
}

// Each golden is the sealed artifacts and receipts of one Run that the normal
// planner, production extraction path and review UI persisted. The two-window
// golden comes from the evaluation-corpus setup; the multi-window goldens come
// from electron/scripts/nir1-multi-window-cold-fixture.mjs (synthetic prose).
it.each([
  // Sealed under Event Synthesis v2, which stays accepted beside v3 and v4.
  ["production-two-window-golden.json", 2, "2"],
  ["production-multi-window-long-golden.json", 3, undefined],
  ["production-multi-window-folder-golden.json", 3, undefined],
])(
  "matches every independent persisted request of %s (%i windows) with production TS builders",
  async (file, windows, synthesisVersion) => {
    await matchesEveryPersistedRequest(
      readGolden(file),
      windows,
      synthesisVersion,
    );
  },
);

async function matchesEveryPersistedRequest(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON golden
  golden: any,
  windowCount: number,
  synthesisVersion: string | undefined,
) {
  expect(golden.plan.windows).toHaveLength(windowCount);
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
      const frozen = await frozenContractForDigest(
        execution.stageId,
        receipt.componentContractDigest,
      );
      expect(frozen).toBeTruthy();
      if (!frozen) return;
      if (synthesisVersion) {
        expect(frozen.contractVersion).toBe(synthesisVersion);
      }
      expect(
        await buildChroniclePromptDigests(
          withComponentContract(artifact, frozen),
        ),
      ).toEqual(expected);
    }
  }
  expect(usedWindows.size).toBe(windowCount);
}
