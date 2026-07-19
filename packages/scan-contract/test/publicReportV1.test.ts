import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SCAN_LIMITS } from "../src/limits";
import {
  PUBLIC_REPORT_SCHEMA_VERSION,
  PUBLIC_REPORT_V1_SCHEMA_VERSION,
  parsePublicReport,
  toPublicReport,
  type PublicReportV1,
} from "../src/publicReportV1";
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
    expect(parsePublicReport(report)).toEqual({ ok: true, value: report });
    const normalized = parsePublicReport(report);
    if (normalized.ok) expect(normalized.value).not.toBe(report);
    expect(
      parsePublicReport({ ...report, entities: [{ id: "broken" }] }).ok,
    ).toBe(false);
    expect(
      parsePublicReport({
        ...report,
        summary: { ...report.summary, premise: "private premise" },
      }).ok,
    ).toBe(false);
  });

  it("normalizes persisted V1 reports to the safe V2 projection", async () => {
    const bundle = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./fixtures/minimal-ja.json", import.meta.url)),
        "utf8",
      ),
    ) as ScanBundleV1;
    const current = toPublicReport(bundle, {
      authorConfirmedAt: "2026-07-16T00:00:00.000Z",
    });
    const legacy: PublicReportV1 = {
      ...current,
      schemaVersion: PUBLIC_REPORT_V1_SCHEMA_VERSION,
      phases: current.phases.map((phase, index) => ({
        ...phase,
        title: `Phase ${index + 1}`,
      })),
      events: current.events.map((event, index) => ({
        ...event,
        title: `Event ${index + 1}`,
      })),
      findings: current.findings.map((finding, index) => ({
        ...finding,
        title: `Finding ${index + 1}`,
        summary: "Details are available in the private report.",
      })),
      publication: {
        ...current.publication,
        authorConfirmedAt:
          "Thursday, July 16, 2026 00:00:00 GMT+0000 (Coordinated Universal Time)",
      },
    };
    legacy.title = "Grimodex Scan report";
    legacy.summary.genreCandidates[0] = "Genre 1";
    legacy.entities[0]!.name = "Entity 1";
    legacy.relations[0]!.type = "related";

    const parsed = parsePublicReport(legacy);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.schemaVersion).toBe(PUBLIC_REPORT_SCHEMA_VERSION);
      expect(parsed.value.publication.authorConfirmedAt).toBe(
        "2026-07-16T00:00:00.000Z",
      );
      expect(parsed.value.phases[0]).toEqual({ id: "public:phase:0001" });
      expect(parsed.value.events[0]).not.toHaveProperty("title");
      expect(parsed.value.findings[0]).not.toHaveProperty("summary");
      expect(parsed.value.title).toBe("Grimodex Scan report");
      expect(parsed.value.summary.genreCandidates[0]).toBe("Genre 1");
      expect(parsed.value.entities[0]?.name).toBe("Entity 1");
      expect(parsed.value.relations[0]?.type).toBe("related");
    }
    expect(
      parsePublicReport({
        ...legacy,
        summary: { ...legacy.summary, premise: "private premise" },
      }).ok,
    ).toBe(false);
  });

  it("keeps empty source labels locale-neutral for the viewer", async () => {
    const bundle = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./fixtures/minimal-ja.json", import.meta.url)),
        "utf8",
      ),
    ) as ScanBundleV1;
    bundle.source.title = "   ";
    bundle.summary.genreCandidates[0]!.value = "   ";
    bundle.summary.themes = [
      { ...bundle.summary.genreCandidates[0]!, value: "   " },
    ];
    bundle.entities[0]!.name = "   ";
    bundle.relations[0]!.type = "   ";

    const report = toPublicReport(bundle, {
      authorConfirmedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(report.title).toBe("");
    expect(report.summary.genreCandidates[0]).toBe("");
    expect(report.summary.themes[0]).toBe("");
    expect(report.entities[0]?.name).toBe("");
    expect(report.relations[0]?.type).toBe("");
  });

  it("rejects invalid confirmation dates at projection time", async () => {
    const bundle = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./fixtures/minimal-ja.json", import.meta.url)),
        "utf8",
      ),
    ) as ScanBundleV1;

    expect(() =>
      toPublicReport(bundle, { authorConfirmedAt: "not-a-date" }),
    ).toThrow("valid author confirmation timestamp");
  });

  it("accepts the source contract event limit and rejects one item beyond it", async () => {
    const bundle = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./fixtures/minimal-ja.json", import.meta.url)),
        "utf8",
      ),
    ) as ScanBundleV1;
    const baseEvent = bundle.events[0]!;
    bundle.events = Array.from(
      { length: SCAN_LIMITS.maxEvents },
      (_, index) => ({
        ...baseEvent,
        id: `event:${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
        order: index,
      }),
    );
    const report = toPublicReport(bundle, {
      authorConfirmedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(parsePublicReport(report).ok).toBe(true);
    expect(
      parsePublicReport({
        ...report,
        events: [
          ...report.events,
          {
            id: "public:event:20001",
            order: SCAN_LIMITS.maxEvents,
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it("rejects inherited fields, wrong ID kinds, duplicates, and dangling relations", async () => {
    const bundle = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./fixtures/minimal-ja.json", import.meta.url)),
        "utf8",
      ),
    ) as ScanBundleV1;
    const report = toPublicReport(bundle, {
      authorConfirmedAt: "2026-07-16T00:00:00.000Z",
    });
    const inheritedSummary = Object.assign(
      Object.create({ premise: "private manuscript excerpt" }) as object,
      report.summary,
    );
    expect(parsePublicReport({ ...report, summary: inheritedSummary }).ok).toBe(
      false,
    );

    const firstEntity = report.entities[0]!;
    expect(
      parsePublicReport({
        ...report,
        entities: [{ ...firstEntity, id: "public:finding:0001" }],
        relations: [],
      }).ok,
    ).toBe(false);
    expect(
      parsePublicReport({
        ...report,
        entities: [firstEntity, { ...firstEntity }],
      }).ok,
    ).toBe(false);

    const firstRelation = report.relations[0]!;
    expect(
      parsePublicReport({
        ...report,
        relations: [{ ...firstRelation, toEntityId: "public:entity:9999" }],
      }).ok,
    ).toBe(false);
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
