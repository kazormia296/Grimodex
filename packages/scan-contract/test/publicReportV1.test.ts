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

  it("redacts and bounds public genre, theme, and relation labels", async () => {
    const bundle = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./fixtures/minimal-ja.json", import.meta.url)),
        "utf8",
      ),
    ) as ScanBundleV1;
    bundle.summary.genreCandidates = [
      {
        value: `secret@example.com ${"長い本文".repeat(40)}`,
        confidence: 0.9,
        evidence: bundle.entities[0]?.evidence ?? [],
      },
    ];
    bundle.summary.themes = [
      {
        value: "連絡先 +81 (90) 1234-5678",
        confidence: 0.8,
        evidence: bundle.entities[0]?.evidence ?? [],
      },
    ];
    bundle.relations[0]!.type = `secret@example.com ${"relationship".repeat(20)}`;

    const report = toPublicReport(bundle, {
      authorConfirmedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(report.summary.genreCandidates[0]).not.toContain(
      "secret@example.com",
    );
    expect(report.summary.genreCandidates[0]?.length).toBeLessThanOrEqual(80);
    expect(report.summary.themes[0]).not.toContain("1234-5678");
    expect(report.summary.themes[0]?.length).toBeLessThanOrEqual(80);
    expect(report.relations[0]?.type).not.toContain("secret@example.com");
    expect(report.relations[0]?.type.length).toBeLessThanOrEqual(80);
  });

  it("bounds redaction work for adversarial public labels", async () => {
    const bundle = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./fixtures/minimal-ja.json", import.meta.url)),
        "utf8",
      ),
    ) as ScanBundleV1;
    bundle.source.title = "+".repeat(100_000);

    const report = toPublicReport(bundle, {
      authorConfirmedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(report.title).toBe(`${"+".repeat(79)}…`);
  });

  it("redacts maximum-length PII that starts near the public label boundary", async () => {
    const bundle = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./fixtures/minimal-ja.json", import.meta.url)),
        "utf8",
      ),
    ) as ScanBundleV1;
    const prefix = "x".repeat(60);
    const email = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    const evidence = bundle.entities[0]?.evidence ?? [];
    bundle.summary.genreCandidates = [
      {
        value: `${prefix} ${email} ${"+".repeat(1_000)}`,
        confidence: 0.9,
        evidence,
      },
    ];
    bundle.summary.themes = [
      {
        value: `${prefix} +123 (456) 789-0123-45`,
        confidence: 0.8,
        evidence,
      },
    ];

    const report = toPublicReport(bundle, {
      authorConfirmedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(report.summary.genreCandidates[0]).toContain("[redacted email]");
    expect(report.summary.genreCandidates[0]).not.toContain("@b");
    expect(report.summary.themes[0]).toContain("[redacted phone]");
    expect(report.summary.themes[0]).not.toContain("789-0123");
  });
});
