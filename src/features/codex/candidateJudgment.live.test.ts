/**
 * RETIRED live harness (Codex Vertical Slice PR6).
 * Product path `codex_judgment` no longer sends fixed-4-type / real-DB-ID prompts.
 * Entity resolution quality is covered by narrative_entity_resolve live suites.
 */
import { describe, it, expect } from "vitest";
import {
  CandidateJudgmentRetiredError,
  judgeCandidates,
} from "./candidateJudgment";

describe("codex candidate judgment live E2E", () => {
  it("product path is retired and does not call the model", async () => {
    await expect(judgeCandidates([], [])).rejects.toBeInstanceOf(
      CandidateJudgmentRetiredError,
    );
  });
});
