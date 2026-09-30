import { describe, expect, it } from "vitest";

import {
  DEFAULT_NARRATIVE_RUNTIME_POLICY,
  narrativeDomainApplyAllowed,
  narrativeExtractionAllowed,
  narrativeRedoAllowed,
  narrativeUndoAllowed,
  NARRATIVE_RUNTIME_SETTING_KEYS,
  parseNarrativeRuntimePolicy,
} from "./narrativeRuntimePolicy";

describe("parseNarrativeRuntimePolicy", () => {
  it("defaults to review-only fail-closed when settings are missing", () => {
    expect(parseNarrativeRuntimePolicy(null)).toEqual(
      DEFAULT_NARRATIVE_RUNTIME_POLICY,
    );
    expect(parseNarrativeRuntimePolicy({})).toEqual(
      DEFAULT_NARRATIVE_RUNTIME_POLICY,
    );
  });

  it("rejects unknown mode and corrupt booleans", () => {
    const policy = parseNarrativeRuntimePolicy({
      [NARRATIVE_RUNTIME_SETTING_KEYS.runtimeMode]: "full",
      [NARRATIVE_RUNTIME_SETTING_KEYS.maintenanceEnabled]: "maybe",
      [NARRATIVE_RUNTIME_SETTING_KEYS.genericImportEnabled]: "TRUE",
      [NARRATIVE_RUNTIME_SETTING_KEYS.backgroundAiEnabled]: "1",
    });
    expect(policy.runtimeMode).toBe("review-only");
    expect(policy.maintenanceEnabled).toBe(false);
    expect(policy.genericImportEnabled).toBe(true);
    expect(policy.backgroundAiEnabled).toBe(true);
  });

  it("gates apply／redo while always allowing undo", () => {
    const review = parseNarrativeRuntimePolicy({
      [NARRATIVE_RUNTIME_SETTING_KEYS.runtimeMode]: "review-only",
    });
    expect(narrativeExtractionAllowed(review)).toBe(true);
    expect(narrativeDomainApplyAllowed(review)).toBe(false);
    expect(narrativeRedoAllowed(review)).toBe(false);
    expect(narrativeUndoAllowed(review)).toBe(true);

    const manual = parseNarrativeRuntimePolicy({
      [NARRATIVE_RUNTIME_SETTING_KEYS.runtimeMode]: "manual-apply",
    });
    expect(narrativeDomainApplyAllowed(manual)).toBe(true);
    expect(narrativeRedoAllowed(manual)).toBe(true);
  });
});
