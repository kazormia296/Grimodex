import { describe, expect, it } from "vitest";

import {
  buildChroniclePromptArtifact,
  buildChroniclePromptDigests,
} from "./chroniclePromptBuilder";
import type { ContextSetEntry } from "./types";

const observationEntry: ContextSetEntry = {
  contextId: "context-source-1",
  inputRef: "S0001",
  stageId: "narrative_observation_extract",
  exposure: "model-visible",
  selector: { kind: "whole-source" },
};

const contractEntry: ContextSetEntry = {
  contextId: "context-contract-1",
  inputRef: "chronicle-observation-contract",
  stageId: "narrative_observation_extract",
  exposure: "deterministic-stage",
  selector: {
    kind: "component-contract",
    contractId: "chronicle.observation.prompt",
    contractDigest: "sha256:contract" as const,
  },
};

const contract = {
  contractId: "chronicle.observation.prompt",
  contractVersion: "1",
  instruction: "Extract observations.",
  outputShape: '{"observations":[]}',
} as const;

describe("Chronicle context-only prompt builder", () => {
  it("builds a deterministic request from the declared Context Set", async () => {
    const first = buildChroniclePromptArtifact({
      stageId: "narrative_observation_extract",
      componentContract: contract,
      contextSet: [observationEntry, contractEntry],
      modelInputs: [
        { contextId: observationEntry.contextId, value: "本文の引用" },
      ],
    });
    const second = buildChroniclePromptArtifact({
      stageId: "narrative_observation_extract",
      componentContract: contract,
      contextSet: [contractEntry, observationEntry],
      modelInputs: [
        { contextId: observationEntry.contextId, value: "本文の引用" },
      ],
    });

    expect(first).toEqual(second);
    expect(first.messages[0]?.content).toContain("本文の引用");
    expect(first.messages[0]?.content).toContain("S0001");
    expect(first.messages[0]?.content).not.toContain("projectId");
    expect(first.messages[0]?.content).not.toContain("sceneId");

    await expect(buildChroniclePromptDigests(first)).resolves.toEqual({
      contextSetDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      componentContractDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      finalRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    await expect(buildChroniclePromptDigests(first)).resolves.toEqual(
      await buildChroniclePromptDigests(second),
    );
  });

  it("rejects model input that is not declared model-visible Context", () => {
    expect(() =>
      buildChroniclePromptArtifact({
        stageId: "narrative_observation_extract",
        componentContract: contract,
        contextSet: [observationEntry],
        modelInputs: [
          { contextId: "unclassified-input", value: "must be rejected" },
        ],
      }),
    ).toThrow(/Context Set/);
  });

  it("fails closed when a declared model-visible input has no value", () => {
    expect(() =>
      buildChroniclePromptArtifact({
        stageId: "narrative_observation_extract",
        componentContract: contract,
        contextSet: [observationEntry],
        modelInputs: [],
      }),
    ).toThrow(/model-visible/);
  });

  it("does not render deterministic-only Context entries as dynamic model input", () => {
    const artifact = buildChroniclePromptArtifact({
      stageId: "narrative_observation_extract",
      componentContract: contract,
      contextSet: [observationEntry, contractEntry],
      modelInputs: [
        { contextId: observationEntry.contextId, value: "本文の引用" },
      ],
    });

    expect(artifact.messages[0]?.content).not.toContain(
      "chronicle-observation-contract",
    );
  });
});
