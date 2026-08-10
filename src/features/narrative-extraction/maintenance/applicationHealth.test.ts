import { describe, expect, it } from "vitest";
import { evaluateContributionHealth } from "./applicationContribution";

describe("evaluateContributionHealth", () => {
  it("returns target-modified when the target digest no longer matches", () => {
    expect(
      evaluateContributionHealth({
        evidenceStatuses: ["fresh"],
        targetDigestMatchesCommitted: false,
        ownership: "maintained",
      }),
    ).toBe("target-modified");
  });

  it("returns target-modified for user-owned contributions", () => {
    expect(
      evaluateContributionHealth({
        evidenceStatuses: ["fresh"],
        targetDigestMatchesCommitted: true,
        ownership: "user-owned",
      }),
    ).toBe("target-modified");
  });

  it("returns unsupported when there is no evidence", () => {
    expect(
      evaluateContributionHealth({
        evidenceStatuses: [],
        targetDigestMatchesCommitted: true,
        ownership: "maintained",
      }),
    ).toBe("unsupported");
  });

  it("returns partially-supported when some evidence is content-stale", () => {
    expect(
      evaluateContributionHealth({
        evidenceStatuses: ["fresh", "content-stale"],
        targetDigestMatchesCommitted: true,
        ownership: "maintained",
      }),
    ).toBe("partially-supported");
  });

  it("returns supported-after-reanchor when only positions shifted", () => {
    expect(
      evaluateContributionHealth({
        evidenceStatuses: ["fresh", "reanchorable"],
        targetDigestMatchesCommitted: true,
        ownership: "maintained",
      }),
    ).toBe("supported-after-reanchor");
  });

  it("returns supported when the target is untouched and evidence is fresh", () => {
    expect(
      evaluateContributionHealth({
        evidenceStatuses: ["fresh"],
        targetDigestMatchesCommitted: true,
        ownership: "maintained",
      }),
    ).toBe("supported");
  });

  it("returns undone without auto-reproposing", () => {
    expect(
      evaluateContributionHealth({
        evidenceStatuses: ["fresh"],
        targetDigestMatchesCommitted: true,
        ownership: "maintained",
        undone: true,
      }),
    ).toBe("undone");
  });
});
