import { describe, expect, it } from "vitest";

import {
  evaluateMaintenanceBudget,
  shouldAutoApplyMaintenanceFix,
  shouldBuildMaintenancePreview,
  shouldRunBackgroundAi,
  shouldStartMaintenanceScheduler,
  type NarrativeMaintenanceMode,
} from "./maintenanceMode";

const modes: readonly NarrativeMaintenanceMode[] = [
  "disabled",
  "manual",
  "deterministic",
  "idle-suggestions",
];

describe("Gate C0 maintenance execution gates", () => {
  it("keeps background AI, idle scheduling, and automatic fixes disabled", () => {
    for (const mode of modes) {
      expect(
        shouldRunBackgroundAi(
          mode,
          { allowBackgroundAi: true, allowAutomaticFixes: true },
          "small",
        ),
      ).toBe(false);
      expect(shouldStartMaintenanceScheduler(mode)).toBe(false);
      expect(
        shouldAutoApplyMaintenanceFix(mode, {
          allowBackgroundAi: true,
          allowAutomaticFixes: true,
        }),
      ).toBe(false);
    }
  });

  it("allows only an explicit, in-budget preview", () => {
    const allowed = evaluateMaintenanceBudget(
      { estimatedTasks: 2, estimatedDocuments: 1 },
      { maxTasks: 2, maxDocuments: 1 },
    );
    expect(shouldBuildMaintenancePreview("deterministic", true, allowed)).toBe(
      true,
    );
    expect(shouldBuildMaintenancePreview("deterministic", false, allowed)).toBe(
      false,
    );
    expect(shouldBuildMaintenancePreview("disabled", true, allowed)).toBe(
      false,
    );
  });

  it("blocks a preview when either budget dimension is exceeded", () => {
    const decision = evaluateMaintenanceBudget(
      { estimatedTasks: 3, estimatedDocuments: 2 },
      { maxTasks: 2, maxDocuments: 1 },
    );
    expect(decision).toEqual({
      allowed: false,
      reasons: [
        "estimated tasks exceed the maintenance budget",
        "estimated documents exceed the maintenance budget",
      ],
    });
    expect(
      shouldBuildMaintenancePreview("idle-suggestions", true, decision),
    ).toBe(false);
  });

  it("rejects malformed budgets", () => {
    expect(() =>
      evaluateMaintenanceBudget(
        { estimatedTasks: 1, estimatedDocuments: 1 },
        { maxTasks: -1, maxDocuments: 1 },
      ),
    ).toThrow(RangeError);
  });
});
