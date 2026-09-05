import currentProtocol from "../../../../evals/qualifications/narrative-current-protocol-v2.json";
import {
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  LEGACY_OBSERVATION_EVIDENCE_MODE,
} from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import {
  CITATION_ID_PRODUCTION_CHRONICLE_EVAL_VERSIONS,
  PRODUCTION_CHRONICLE_EVAL_VERSIONS,
} from "./productionChronicleAdapter";
import { describe, expect, it } from "vitest";

describe("current Narrative evaluation protocol", () => {
  it("pins the canonical declaration to the citation-ID production seam", () => {
    expect(currentProtocol.evidenceMode).toBe(
      CITATION_ID_OBSERVATION_EVIDENCE_MODE,
    );
    expect(currentProtocol.receiptMode).toBe(
      CITATION_ID_OBSERVATION_EVIDENCE_MODE,
    );
    expect(currentProtocol.versions).toEqual(
      CITATION_ID_PRODUCTION_CHRONICLE_EVAL_VERSIONS,
    );
    expect(currentProtocol.versions.prompt).toBe(
      "narrative-observation-extract/citation-id-v3+narrative-event-synthesize/2",
    );
    expect(currentProtocol.versions).not.toEqual(
      PRODUCTION_CHRONICLE_EVAL_VERSIONS,
    );
    expect(currentProtocol.evidenceMode).not.toBe(
      LEGACY_OBSERVATION_EVIDENCE_MODE,
    );
  });
});
