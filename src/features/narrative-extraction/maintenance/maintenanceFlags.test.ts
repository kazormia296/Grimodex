import { describe, expect, it } from "vitest";

import {
  isNarrativeBackgroundAiUiEnabled,
  isNarrativeGenericImportUiEnabled,
  isNarrativeMaintenanceUiEnabled,
} from "./maintenanceFlags";
import type { NarrativeRuntimePolicy } from "../runtime/narrativeRuntimePolicy";
import type { NativeNarrativeRuntimePolicy } from "../runtime/narrativeRuntimePolicyApi";

const base: NarrativeRuntimePolicy = {
  runtimeMode: "review-only",
  maintenanceEnabled: false,
  genericImportEnabled: false,
  backgroundAiEnabled: false,
};

const nativeBase: NativeNarrativeRuntimePolicy = {
  ...base,
  effectiveMode: "review-only",
  maintenancePreviewAllowed: false,
};

describe("maintenanceFlags", () => {
  it("defaults to disabled UI surfaces under Stage 1 policy", () => {
    expect(isNarrativeMaintenanceUiEnabled()).toBe(false);
    expect(isNarrativeGenericImportUiEnabled()).toBe(false);
    expect(isNarrativeBackgroundAiUiEnabled()).toBe(false);
  });

  it("enables preview only when Native allows the capability", () => {
    expect(
      isNarrativeMaintenanceUiEnabled({
        ...nativeBase,
        runtimeMode: "automatic",
        effectiveMode: "automatic",
        maintenanceEnabled: true,
        maintenancePreviewAllowed: true,
      }),
    ).toBe(true);
  });

  it("fails closed for an engine hard-disable response", () => {
    expect(
      isNarrativeMaintenanceUiEnabled({
        ...nativeBase,
        runtimeMode: "automatic",
        effectiveMode: "disabled",
        maintenanceEnabled: true,
        maintenancePreviewAllowed: false,
      }),
    ).toBe(false);
  });

  it("fails closed for a maintenance hard-disable response", () => {
    expect(
      isNarrativeMaintenanceUiEnabled({
        ...nativeBase,
        runtimeMode: "automatic",
        effectiveMode: "automatic",
        maintenanceEnabled: true,
        maintenancePreviewAllowed: false,
      }),
    ).toBe(false);
  });

  it("keeps background AI UI disabled throughout Gate C0", () => {
    expect(
      isNarrativeBackgroundAiUiEnabled({
        ...base,
        runtimeMode: "automatic",
        backgroundAiEnabled: true,
      }),
    ).toBe(false);
    expect(
      isNarrativeBackgroundAiUiEnabled({
        ...base,
        runtimeMode: "manual-apply",
        backgroundAiEnabled: true,
      }),
    ).toBe(false);
  });
});
