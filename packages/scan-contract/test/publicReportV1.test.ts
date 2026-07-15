import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { toPublicReport } from "../src/publicReportV1";
import type { ScanBundleV1 } from "../src/scanBundleV1";

describe("toPublicReport", () => {
  it("requires author confirmation and strips evidence/private provenance", async () => {
    const bundle = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./fixtures/minimal-ja.json", import.meta.url)),
        "utf8",
      ),
    ) as ScanBundleV1;
    expect(() => toPublicReport(bundle, { authorConfirmedAt: "" })).toThrow(
      "author confirmation",
    );

    const report = toPublicReport(bundle, {
      authorConfirmedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(report.publication).toEqual({
      authorConfirmedAt: "2026-07-16T00:00:00.000Z",
      evidenceOmitted: true,
      privateProvenanceOmitted: true,
    });
    expect(JSON.stringify(report)).not.toContain("excerpt");
    expect(JSON.stringify(report)).not.toContain(bundle.source.fingerprint);
    if (report.relations[0]) {
      expect(report.relations[0].fromEntityId).toBe("public:entity:0001");
    }
  });
});
