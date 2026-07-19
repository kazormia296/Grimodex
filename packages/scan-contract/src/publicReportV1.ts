import type {
  ScanBundleV1,
  ScanEntityType,
  ScanFindingKind,
} from "./scanBundleV1.js";
import { SCAN_LIMITS } from "./limits.js";

export const PUBLIC_REPORT_V1_SCHEMA_VERSION =
  "grimodex-scan/public-report/1" as const;
export const PUBLIC_REPORT_SCHEMA_VERSION =
  "grimodex-scan/public-report/2" as const;

// Public labels expose at most 80 characters. This leaves enough lookahead to
// redact a maximum-length email or formatted phone that starts in that prefix,
// while bounding backtracking work on hostile input.
const PUBLIC_LABEL_REDACTION_LIMIT = 512;
const PUBLIC_LABEL_MAX_LENGTH = 80;
const PUBLIC_SUMMARY_MAX_ITEMS = 64;
export const PUBLIC_REPORT_AUTHOR_CONFIRMATION_MAX_LENGTH = 64;
const LEGACY_PUBLIC_REPORT_AUTHOR_CONFIRMATION_MAX_LENGTH = 256;
const LEGACY_PUBLIC_FINDING_SUMMARY =
  "Details are available in the private report.";
const PUBLIC_ID_PATTERNS = {
  entity: /^public:entity:(?:0{0,3}[1-9]\d*)$/,
  relation: /^public:relation:(?:0{0,3}[1-9]\d*)$/,
  phase: /^public:phase:(?:0{0,3}[1-9]\d*)$/,
  event: /^public:event:(?:0{0,3}[1-9]\d*)$/,
  finding: /^public:finding:(?:0{0,3}[1-9]\d*)$/,
} as const;

interface PublicReportCommon {
  title: string;
  language: "ja" | "en" | "other";
  source: {
    sectionCount: number;
    paragraphCount: number;
    characterCount: number;
  };
  summary: { genreCandidates: string[]; themes: string[] };
  entities: Array<{
    id: string;
    type: ScanEntityType;
    name: string;
    aliases: string[];
  }>;
  relations: Array<{
    id: string;
    fromEntityId: string;
    toEntityId: string;
    type: string;
  }>;
  publication: {
    authorConfirmedAt: string;
    evidenceOmitted: true;
    privateProvenanceOmitted: true;
  };
}

/** Legacy persisted shape. Readers normalize this to PublicReportV2. */
export interface PublicReportV1 extends PublicReportCommon {
  schemaVersion: typeof PUBLIC_REPORT_V1_SCHEMA_VERSION;
  phases: Array<{ id: string; title: string }>;
  events: Array<{ id: string; title: string; order: number }>;
  findings: Array<{
    id: string;
    kind: ScanFindingKind;
    title: string;
    summary: typeof LEGACY_PUBLIC_FINDING_SUMMARY;
  }>;
}

export interface PublicReportV2 extends PublicReportCommon {
  schemaVersion: typeof PUBLIC_REPORT_SCHEMA_VERSION;
  phases: Array<{ id: string }>;
  events: Array<{ id: string; order: number }>;
  findings: Array<{
    id: string;
    kind: ScanFindingKind;
  }>;
}

export type PublicReportValidationResult =
  | { ok: true; value: PublicReportV2 }
  | { ok: false; errors: string[] };

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
  return normalized.length > PUBLIC_LABEL_MAX_LENGTH
    ? `${normalized.slice(0, PUBLIC_LABEL_MAX_LENGTH - 1)}…`
    : normalized || fallback;
}

/** Project a private bundle to an author-confirmed, evidence-free report. */
export function toPublicReport(
  bundle: ScanBundleV1,
  input: { authorConfirmedAt: string },
): PublicReportV2 {
  if (
    !input.authorConfirmedAt.trim() ||
    input.authorConfirmedAt.length >
      PUBLIC_REPORT_AUTHOR_CONFIRMATION_MAX_LENGTH ||
    !Number.isFinite(Date.parse(input.authorConfirmedAt))
  ) {
    throw new Error(
      "a valid author confirmation timestamp is required before publishing a report",
    );
  }
  const entityIds = new Map(
    bundle.entities.map(
      (entity, index) => [entity.id, publicId("entity", index)] as const,
    ),
  );
  return {
    schemaVersion: PUBLIC_REPORT_SCHEMA_VERSION,
    title: publicLabel(bundle.source.title, ""),
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
      genreCandidates: bundle.summary.genreCandidates.map((item) =>
        publicLabel(item.value, ""),
      ),
      themes: bundle.summary.themes.map((item) => publicLabel(item.value, "")),
    },
    entities: bundle.entities.map((entity, index) => ({
      id: publicId("entity", index),
      type: entity.type,
      name: publicLabel(entity.name, ""),
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
              type: publicLabel(relation.type, ""),
            },
          ]
        : [];
    }),
    phases: bundle.phases.map((_, index) => ({
      id: publicId("phase", index),
    })),
    events: bundle.events.map((event, index) => ({
      id: publicId("event", index),
      // Event titles and summaries can both be copied from source evidence.
      // Keep only ordering in the public report.
      order: event.order,
    })),
    findings: bundle.findings
      .filter((finding) => finding.status !== "rejected")
      .map((finding, index) => ({
        id: publicId("finding", index),
        kind: finding.kind,
      })),
    publication: {
      authorConfirmedAt: input.authorConfirmedAt,
      evidenceOmitted: true,
      privateProvenanceOmitted: true,
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === expected.length &&
    expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    })
  );
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

type PublicIdKind = "entity" | "relation" | "phase" | "event" | "finding";

function isPublicId(value: unknown, kind: PublicIdKind): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    PUBLIC_ID_PATTERNS[kind].test(value)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isBoundedArray<T>(
  value: unknown,
  maxItems: number,
  predicate: (item: unknown, index: number) => item is T,
): value is T[] {
  return (
    Array.isArray(value) && value.length <= maxItems && value.every(predicate)
  );
}

function isPublicLabel(value: unknown): value is string {
  return isBoundedString(value, PUBLIC_LABEL_MAX_LENGTH);
}

function isPublicSource(value: unknown): value is PublicReportCommon["source"] {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, [
      "sectionCount",
      "paragraphCount",
      "characterCount",
    ]) &&
    isNonNegativeInteger(value.sectionCount) &&
    isNonNegativeInteger(value.paragraphCount) &&
    isNonNegativeInteger(value.characterCount)
  );
}

function isPublicSummary(
  value: unknown,
): value is PublicReportCommon["summary"] {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, ["genreCandidates", "themes"]) &&
    isBoundedArray(
      value.genreCandidates,
      PUBLIC_SUMMARY_MAX_ITEMS,
      isPublicLabel,
    ) &&
    isBoundedArray(value.themes, PUBLIC_SUMMARY_MAX_ITEMS, isPublicLabel)
  );
}

function isPublicEntity(
  value: unknown,
): value is PublicReportCommon["entities"][number] {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, ["id", "type", "name", "aliases"]) &&
    isPublicId(value.id, "entity") &&
    (value.type === "character" ||
      value.type === "place" ||
      value.type === "organization" ||
      value.type === "object" ||
      value.type === "alias" ||
      value.type === "unknown") &&
    isPublicLabel(value.name) &&
    isBoundedArray(
      value.aliases,
      SCAN_LIMITS.maxAliasesPerEntity,
      isPublicLabel,
    )
  );
}

function isPublicRelation(
  value: unknown,
): value is PublicReportCommon["relations"][number] {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, ["id", "fromEntityId", "toEntityId", "type"]) &&
    isPublicId(value.id, "relation") &&
    isPublicId(value.fromEntityId, "entity") &&
    isPublicId(value.toEntityId, "entity") &&
    isPublicLabel(value.type)
  );
}

function isPublicPhase(
  value: unknown,
): value is PublicReportV2["phases"][number] {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, ["id"]) &&
    isPublicId(value.id, "phase")
  );
}

function isPublicEvent(
  value: unknown,
): value is PublicReportV2["events"][number] {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, ["id", "order"]) &&
    isPublicId(value.id, "event") &&
    isNonNegativeInteger(value.order)
  );
}

function isPublicFinding(
  value: unknown,
): value is PublicReportV2["findings"][number] {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, ["id", "kind"]) &&
    isPublicId(value.id, "finding") &&
    (value.kind === "continuity" ||
      value.kind === "timeline" ||
      value.kind === "knowledge" ||
      value.kind === "ambiguity" ||
      value.kind === "other")
  );
}

function isLegacyPublicPhase(
  value: unknown,
  index: number,
): value is PublicReportV1["phases"][number] {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, ["id", "title"]) &&
    isPublicId(value.id, "phase") &&
    value.title === `Phase ${index + 1}`
  );
}

function isLegacyPublicEvent(
  value: unknown,
  index: number,
): value is PublicReportV1["events"][number] {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, ["id", "title", "order"]) &&
    isPublicId(value.id, "event") &&
    value.title === `Event ${index + 1}` &&
    isNonNegativeInteger(value.order)
  );
}

function isLegacyPublicFinding(
  value: unknown,
  index: number,
): value is PublicReportV1["findings"][number] {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, ["id", "kind", "title", "summary"]) &&
    isPublicId(value.id, "finding") &&
    (value.kind === "continuity" ||
      value.kind === "timeline" ||
      value.kind === "knowledge" ||
      value.kind === "ambiguity" ||
      value.kind === "other") &&
    value.title === `Finding ${index + 1}` &&
    value.summary === LEGACY_PUBLIC_FINDING_SUMMARY
  );
}

function isPublicPublication(
  value: unknown,
  maxAuthorConfirmationLength: number,
): value is PublicReportCommon["publication"] {
  return (
    isPlainRecord(value) &&
    hasExactDataKeys(value, [
      "authorConfirmedAt",
      "evidenceOmitted",
      "privateProvenanceOmitted",
    ]) &&
    isBoundedString(value.authorConfirmedAt, maxAuthorConfirmationLength) &&
    Number.isFinite(Date.parse(value.authorConfirmedAt)) &&
    value.evidenceOmitted === true &&
    value.privateProvenanceOmitted === true
  );
}

/** Parse only the evidence-free public projection that the viewer may render. */
export function parsePublicReport(
  input: unknown,
): PublicReportValidationResult {
  try {
    const isLegacy =
      isPlainRecord(input) &&
      input.schemaVersion === PUBLIC_REPORT_V1_SCHEMA_VERSION;
    if (
      !isPlainRecord(input) ||
      !hasExactDataKeys(input, [
        "schemaVersion",
        "title",
        "language",
        "source",
        "summary",
        "entities",
        "relations",
        "phases",
        "events",
        "findings",
        "publication",
      ]) ||
      (input.schemaVersion !== PUBLIC_REPORT_SCHEMA_VERSION &&
        input.schemaVersion !== PUBLIC_REPORT_V1_SCHEMA_VERSION) ||
      !isPublicLabel(input.title) ||
      (input.language !== "ja" &&
        input.language !== "en" &&
        input.language !== "other") ||
      !isPublicSource(input.source) ||
      !isPublicSummary(input.summary) ||
      !isBoundedArray(
        input.entities,
        SCAN_LIMITS.maxEntities,
        isPublicEntity,
      ) ||
      !isBoundedArray(
        input.relations,
        SCAN_LIMITS.maxRelations,
        isPublicRelation,
      ) ||
      !(isLegacy
        ? isBoundedArray(
            input.phases,
            SCAN_LIMITS.maxPhases,
            isLegacyPublicPhase,
          ) &&
          isBoundedArray(
            input.events,
            SCAN_LIMITS.maxEvents,
            isLegacyPublicEvent,
          ) &&
          isBoundedArray(
            input.findings,
            SCAN_LIMITS.maxFindings,
            isLegacyPublicFinding,
          ) &&
          isPublicPublication(
            input.publication,
            LEGACY_PUBLIC_REPORT_AUTHOR_CONFIRMATION_MAX_LENGTH,
          )
        : isBoundedArray(input.phases, SCAN_LIMITS.maxPhases, isPublicPhase) &&
          isBoundedArray(input.events, SCAN_LIMITS.maxEvents, isPublicEvent) &&
          isBoundedArray(
            input.findings,
            SCAN_LIMITS.maxFindings,
            isPublicFinding,
          ) &&
          isPublicPublication(
            input.publication,
            PUBLIC_REPORT_AUTHOR_CONFIRMATION_MAX_LENGTH,
          ))
    ) {
      return { ok: false, errors: ["invalid public report projection"] };
    }

    const common = input as unknown as PublicReportCommon;
    const legacy = input as unknown as PublicReportV1;
    const current = input as unknown as PublicReportV2;
    const normalized: PublicReportV2 = {
      schemaVersion: PUBLIC_REPORT_SCHEMA_VERSION,
      title: common.title,
      language: common.language,
      source: { ...common.source },
      summary: {
        genreCandidates: [...common.summary.genreCandidates],
        themes: [...common.summary.themes],
      },
      entities: common.entities.map((entity) => ({
        ...entity,
        aliases: [...entity.aliases],
      })),
      relations: common.relations.map((relation) => ({ ...relation })),
      phases: (isLegacy ? legacy.phases : current.phases).map(({ id }) => ({
        id,
      })),
      events: (isLegacy ? legacy.events : current.events).map(
        ({ id, order }) => ({ id, order }),
      ),
      findings: (isLegacy ? legacy.findings : current.findings).map(
        ({ id, kind }) => ({ id, kind }),
      ),
      publication: {
        ...common.publication,
        authorConfirmedAt: new Date(
          common.publication.authorConfirmedAt,
        ).toISOString(),
      },
    };
    const hasUniqueIds = (items: ReadonlyArray<{ id: string }>) =>
      new Set(items.map(({ id }) => id)).size === items.length;
    const entityIds = new Set(normalized.entities.map(({ id }) => id));
    if (
      !hasUniqueIds(normalized.entities) ||
      !hasUniqueIds(normalized.relations) ||
      !hasUniqueIds(normalized.phases) ||
      !hasUniqueIds(normalized.events) ||
      !hasUniqueIds(normalized.findings) ||
      !normalized.relations.every(
        ({ fromEntityId, toEntityId }) =>
          entityIds.has(fromEntityId) && entityIds.has(toEntityId),
      )
    ) {
      return { ok: false, errors: ["invalid public report projection"] };
    }

    return {
      ok: true,
      value: normalized,
    };
  } catch {
    return { ok: false, errors: ["invalid public report projection"] };
  }
}
