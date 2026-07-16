import { describe, expect, it } from "vitest";
import { publicReportArtifactKey } from "./publicReportPublication";

describe("public report publication objects", () => {
  it("uses one immutable object key per publish operation", () => {
    const first = publicReportArtifactKey("scan-1", "publication-1");
    const second = publicReportArtifactKey("scan-1", "publication-2");

    expect(first).not.toBe(second);
    expect(first).toBe("public/scan-1/publication-1.json");
    expect(second).toBe("public/scan-1/publication-2.json");
  });

  it("keeps identifiers inside their path segments", () => {
    expect(publicReportArtifactKey("scan/1", "publication/1")).toBe(
      "public/scan%2F1/publication%2F1.json",
    );
  });
});
