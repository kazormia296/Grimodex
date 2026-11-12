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
  // Made after DMS/1: each proposal declares only the scenes its synthesis
  // request read (src-tauri/crates/grimodex-db/tests/support/nir1-declared-scope-cold.*).
  ["production-declared-scope-folder-golden.json", 3, undefined],
  // The split folder: the request of the tide proposal read scenes 2 and 3, its
  // event cites scene 2 only (the root Envelope in this golden is that proposal's).
  ["production-declared-scope-split-golden.json", 3, undefined],
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

it("the declared-scope golden declares exactly the scenes of its synthesis request's windows", () => {
  const golden = readGolden("production-declared-scope-folder-golden.json");
  const output = golden.outputs.find((o: { rootStageExecutionId: string }) =>
    golden.receipts.some(
      (r: { stageExecution: { stageId: string; stageExecutionId: string } }) =>
        r.stageExecution.stageId === "narrative_event_synthesize" &&
        r.stageExecution.stageExecutionId === o.rootStageExecutionId,
    ),
  );
  const documentOf = new Map<string, string>(
    golden.snapshot.snapshot.documents.map(
      (d: { ref: string; sourceKey: string }) => [d.ref, d.sourceKey],
    ),
  );
  const sceneOfWindow = new Map<string, string>(
    golden.plan.windows.map((w: { windowId: string; documentRef: string }) => [
      w.windowId,
      documentOf.get(w.documentRef)!,
    ]),
  );
  const expected = new Set<string>(
    output.rawObservations.observations.map((o: { localId: string }) =>
      sceneOfWindow.get(o.localId.slice(0, o.localId.lastIndexOf(":obs-"))),
    ),
  );
  expect(expected.size).toBeGreaterThan(1);
  const basis = golden.rootEnvelope.effectiveMaterialBasis;
  const declared = new Set<string>(
    basis.sourceBasis
      .filter((s: { sourceKind: string }) => s.sourceKind === "scene-body")
      .map((s: { sourceKey: string }) => s.sourceKey),
  );
  expect(declared).toEqual(expected);
  // The scene the plan reads but the request never did is not declared.
  expect(declared.size).toBeLessThan(new Set(sceneOfWindow.values()).size);
});

it("the split golden declares the scenes its request read, though the event cites one", () => {
  const golden = readGolden("production-declared-scope-split-golden.json");
  const sourceKeyOfWindow = (windowId: string) => {
    const plan = golden.plan.windows.find(
      (w: { windowId: string }) => w.windowId === windowId,
    );
    return golden.snapshot.snapshot.documents.find(
      (d: { ref: string }) => d.ref === plan.documentRef,
    ).sourceKey as string;
  };
  const basis = golden.rootEnvelope.effectiveMaterialBasis;
  const declared = basis.sourceBasis
    .filter((s: { sourceKind: string }) => s.sourceKind === "scene-body")
    .map((s: { sourceKey: string }) => s.sourceKey);
  expect(declared).toEqual([
    sourceKeyOfWindow("window-002"),
    sourceKeyOfWindow("window-003"),
  ]);
  const evidenceScenes = new Set<string>(
    basis.evidenceSet
      .map((e: { sourceKey?: string }) => e.sourceKey)
      .filter((key?: string) => key?.startsWith("project:scene:")),
  );
  expect([...evidenceScenes]).toEqual([sourceKeyOfWindow("window-002")]);
  // The request listed an Observation of window 3 that the event did not cite.
  const contexts = golden.rootEnvelope.revisionBasis.contextSet.map(
    (c: { contextId: string }) => c.contextId,
  );
  expect(contexts).toContain("event-observation:window-003:obs-001");
});
