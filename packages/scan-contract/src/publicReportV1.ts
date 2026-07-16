import type {
  ScanBundleV1,
  ScanEntityType,
  ScanFindingKind,
} from "./scanBundleV1.js";

export const PUBLIC_REPORT_SCHEMA_VERSION =
  "grimodex-scan/public-report/1" as const;

// Public labels expose at most 80 characters. This leaves enough lookahead to
// redact a maximum-length email or formatted phone that starts in that prefix,
// while bounding backtracking work on hostile input.
const PUBLIC_LABEL_REDACTION_LIMIT = 512;

export interface PublicReportV1 {
  schemaVersion: typeof PUBLIC_REPORT_SCHEMA_VERSION;
  title: string;
  language: "ja" | "en" | "other";
  source: {
    sectionCount: number;
    paragraphCount: number;
    characterCount: number;
  };
  summary: { premise?: string; genreCandidates: string[]; themes: string[] };
  entities: Array<{
    id: string;
    type: ScanEntityType;
    name: string;
    aliases: string[];
    summary?: string;
  }>;
  relations: Array<{
    id: string;
    fromEntityId: string;
    toEntityId: string;
    type: string;
    label?: string;
  }>;
  phases: Array<{ id: string; title: string; summary?: string }>;
  events: Array<{ id: string; title: string; summary?: string; order: number }>;
  findings: Array<{
    id: string;
    kind: ScanFindingKind;
    title: string;
    summary: string;
  }>;
  publication: {
    authorConfirmedAt: string;
    evidenceOmitted: true;
    privateProvenanceOmitted: true;
  };
}

function publicId(kind: string, index: number): string {
  return `public:${kind}:${String(index + 1).padStart(4, "0")}`;
}

function redactPersonalData(value: string): string {
  const boundedValue =
    value.length > PUBLIC_LABEL_REDACTION_LIMIT
      ? value.slice(0, PUBLIC_LABEL_REDACTION_LIMIT)
      : value;
  return boundedValue
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted email]")
    .replace(/(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)/g, "[redacted phone]");
}

function publicLabel(value: string, fallback: string): string {
  const normalized = redactPersonalData(value.replace(/\s+/g, " ").trim());
  return normalized.length > 80
    ? `${normalized.slice(0, 79)}…`
    : normalized || fallback;
}

/** Project a private bundle to an author-confirmed, evidence-free report. */
export function toPublicReport(
  bundle: ScanBundleV1,
  input: { authorConfirmedAt: string },
): PublicReportV1 {
  if (!input.authorConfirmedAt.trim()) {
    throw new Error(
      "author confirmation is required before publishing a report",
    );
  }
  const entityIds = new Map(
    bundle.entities.map(
      (entity, index) => [entity.id, publicId("entity", index)] as const,
    ),
  );
  return {
    schemaVersion: PUBLIC_REPORT_SCHEMA_VERSION,
    title: publicLabel(bundle.source.title, "Grimodex Scan report"),
    language: bundle.source.language,
    source: {
      sectionCount: bundle.source.sectionCount,
      paragraphCount: bundle.source.paragraphCount,
      characterCount: bundle.source.characterCount,
    },
    summary: {
      // Premise and narrative summaries are derived from source paragraphs.
      // They are intentionally omitted from a public projection so a short
      // paragraph cannot become a verbatim public excerpt.
      genreCandidates: bundle.summary.genreCandidates.map((item, index) =>
        publicLabel(item.value, `Genre ${index + 1}`),
      ),
      themes: bundle.summary.themes.map((item, index) =>
        publicLabel(item.value, `Theme ${index + 1}`),
      ),
    },
    entities: bundle.entities.map((entity, index) => ({
      id: publicId("entity", index),
      type: entity.type,
      name: publicLabel(entity.name, `Entity ${index + 1}`),
      aliases: entity.aliases
        .map((alias) => publicLabel(alias, ""))
        .filter(Boolean),
    })),
    relations: bundle.relations.flatMap((relation, index) => {
      const fromEntityId = entityIds.get(relation.fromEntityId);
      const toEntityId = entityIds.get(relation.toEntityId);
      return fromEntityId && toEntityId
        ? [
            {
              id: publicId("relation", index),
              fromEntityId,
              toEntityId,
              type: publicLabel(relation.type, "related"),
            },
          ]
        : [];
    }),
    phases: bundle.phases.map((_, index) => ({
      id: publicId("phase", index),
      title: `Phase ${index + 1}`,
    })),
    events: bundle.events.map((event, index) => ({
      id: publicId("event", index),
      // Event titles and summaries can both be copied from source evidence.
      // Keep only a redacted label and ordering in the public report.
      title: `Event ${index + 1}`,
      order: event.order,
    })),
    findings: bundle.findings
      .filter((finding) => finding.status !== "rejected")
      .map((finding, index) => ({
        id: publicId("finding", index),
        kind: finding.kind,
        title: `Finding ${index + 1}`,
        summary: "Details are available in the private report.",
      })),
    publication: {
      authorConfirmedAt: input.authorConfirmedAt,
      evidenceOmitted: true,
      privateProvenanceOmitted: true,
    },
  };
}
