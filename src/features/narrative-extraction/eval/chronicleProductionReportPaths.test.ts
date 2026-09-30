import path from "node:path";
import { describe, expect, it } from "vitest";
import { chronicleProductionStableReportRoot } from "./chronicleProductionReportPaths";

describe("Chronicle production report paths", () => {
  it("does not expose a legacy stable report path for diagnostic suites", () => {
    expect(
      chronicleProductionStableReportRoot({
        repoRoot: "/tmp/grimodex",
        diagnosticOnly: true,
        localQualification: false,
      }),
    ).toBeNull();
  });

  it("keeps the stable report path for the existing non-diagnostic run", () => {
    expect(
      chronicleProductionStableReportRoot({
        repoRoot: "/tmp/grimodex",
        diagnosticOnly: false,
        localQualification: false,
      }),
    ).toBe(
      path.join(
        "/tmp/grimodex",
        ".artifacts",
        "narrative-eval",
        "chronicle-production-live",
      ),
    );
  });

  it("keeps local qualification reports run-specific", () => {
    expect(
      chronicleProductionStableReportRoot({
        repoRoot: "/tmp/grimodex",
        diagnosticOnly: false,
        localQualification: true,
      }),
    ).toBeNull();
  });
});
