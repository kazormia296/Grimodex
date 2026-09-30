import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/tauri";
import {
  getNarrativeRuntimePolicy,
  parseNativeNarrativeRuntimePolicy,
} from "./narrativeRuntimePolicyApi";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

describe("narrativeRuntimePolicyApi", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("reads the Native-owned policy", async () => {
    vi.mocked(invoke).mockResolvedValue({
      runtimeMode: "manual-apply",
      effectiveMode: "manual-apply",
      maintenanceEnabled: true,
      maintenancePreviewAllowed: true,
      genericImportEnabled: false,
      backgroundAiEnabled: false,
      version: 3,
    });

    await expect(getNarrativeRuntimePolicy()).resolves.toEqual({
      runtimeMode: "manual-apply",
      effectiveMode: "manual-apply",
      maintenanceEnabled: true,
      maintenancePreviewAllowed: true,
      genericImportEnabled: false,
      backgroundAiEnabled: false,
    });
    expect(invoke).toHaveBeenCalledWith("narrative_runtime_policy_get");
  });

  it("fails closed when Native returns a malformed policy", () => {
    expect(
      parseNativeNarrativeRuntimePolicy({
        runtimeMode: "automatic",
        effectiveMode: "automatic",
        maintenanceEnabled: "true",
        maintenancePreviewAllowed: true,
        genericImportEnabled: false,
        backgroundAiEnabled: true,
      }),
    ).toEqual({
      runtimeMode: "review-only",
      effectiveMode: "review-only",
      maintenanceEnabled: false,
      maintenancePreviewAllowed: false,
      genericImportEnabled: false,
      backgroundAiEnabled: false,
    });
  });

  it("fails closed when Native omits an effective capability field", () => {
    expect(
      parseNativeNarrativeRuntimePolicy({
        runtimeMode: "automatic",
        effectiveMode: "automatic",
        maintenanceEnabled: true,
        genericImportEnabled: false,
        backgroundAiEnabled: false,
      }),
    ).toEqual({
      runtimeMode: "review-only",
      effectiveMode: "review-only",
      maintenanceEnabled: false,
      maintenancePreviewAllowed: false,
      genericImportEnabled: false,
      backgroundAiEnabled: false,
    });
  });
});
