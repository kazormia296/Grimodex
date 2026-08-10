import { describe, expect, it } from "vitest";

import {
  isNarrativeBackgroundAiUiEnabled,
  isNarrativeGenericImportUiEnabled,
  isNarrativeMaintenanceUiEnabled,
} from "./maintenanceFlags";
import type { NarrativeRuntimePolicy } from "../runtime/narrativeRuntimePolicy";

const base: NarrativeRuntimePolicy = {
  runtimeMode: "review-only",
  maintenanceEnabled: false,
  genericImportEnabled: false,
  backgroundAiEnabled: false,
};

describe("maintenanceFlags", () => {
  it("defaults to disabled UI surfaces under Stage 1 policy", () => {
    expect(isNarrativeMaintenanceUiEnabled()).toBe(false);
    expect(isNarrativeGenericImportUiEnabled()).toBe(false);
    expect(isNarrativeBackgroundAiUiEnabled()).toBe(false);
  });

  it("requires automatic mode for background AI UI", () => {
    expect(
      isNarrativeBackgroundAiUiEnabled({
        ...base,
        runtimeMode: "automatic",
        backgroundAiEnabled: true,
      }),
    ).toBe(true);
    expect(
      isNarrativeBackgroundAiUiEnabled({
        ...base,
        runtimeMode: "manual-apply",
        backgroundAiEnabled: true,
      }),
    ).toBe(false);
  });
});
