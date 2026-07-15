import { Ajv, type ErrorObject } from "ajv";
import { ID_PATTERNS, SCAN_LIMITS, type ScanIdKind } from "./limits.js";
import { scanBundleV1Schema } from "./schema.js";
import { computeSourceFingerprint, isScanLanguage } from "./sourceFingerprint.js";
import type {
  EditorSeedV1,
  EvidenceRef,
  ScanBundleV1,
  ScanEntity,
  ScanSection,
  SourceDocumentV1,
  SourceParagraphV1,
  SourceSectionV1,
} from "./scanBundleV1.js";

export interface ScanValidationError {
  code: string;
  path: string;
  message: string;
}

export type ScanValidationResult =
  | { ok: true; value: ScanBundleV1 }
  | { ok: false; errors: ScanValidationError[] };

export interface ScanValidationOptions {
  allowConfirmedFindingStatus?: boolean;
}

export type EditorSeedValidationResult =
  | { ok: true; value: EditorSeedV1 }
  | { ok: false; errors: ScanValidationError[] };

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(scanBundleV1Schema);

function shapeErrors(errors: ErrorObject[] | null | undefined): ScanValidationError[] {
  return (errors ?? []).map((error) => ({
    code: `schema:${error.keyword}`,
    path: error.instancePath || "/",
    message: error.message ?? "schema validation failed",
  }));
}

function error(code: string, path: string, message: string): ScanValidationError {
  return { code, path, message };
}

function checkId(
  value: string,
  kind: ScanIdKind,
  path: string,
  errors: ScanValidationError[],
): void {
  if (value.length > SCAN_LIMITS.maxIdLength || !ID_PATTERNS[kind].test(value)) {
    errors.push(error("invalid-id", path, `expected a valid ${kind} id`));
  }
}

function checkUniqueIds(
  records: ReadonlyArray<{ id: string }>,
  kind: ScanIdKind,
  path: string,
  errors: ScanValidationError[],
): Set<string> {
  const ids = new Set<string>();
  records.forEach((record, index) => {
    checkId(record.id, kind, `${path}/${index}/id`, errors);
    if (ids.has(record.id)) {
      errors.push(error("duplicate-id", `${path}/${index}/id`, `duplicate ${kind} id`));
    }
    ids.add(record.id);
  });
  return ids;
}

function checkConfidence(
  value: number,
  path: string,
  errors: ScanValidationError[],
): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(error("confidence-range", path, "confidence must be between 0 and 1"));
  }
}

function checkEvidence(
  evidence: readonly EvidenceRef[],
  path: string,
  required: boolean,
  sections: ReadonlyMap<string, ScanSection>,
  paragraphs: ReadonlyMap<string, string>,
  errors: ScanValidationError[],
): void {
  if (required && evidence.length === 0) {
    errors.push(error("evidence-required", path, "at least one evidence reference is required"));
  }
  if (evidence.length > SCAN_LIMITS.maxEvidencePerItem) {
    errors.push(error("limit", path, "too many evidence references"));
  }
  evidence.forEach((ref, index) => {
    const refPath = `${path}/${index}`;
    const section = sections.get(ref.sectionId);
    if (!section || !paragraphs.has(ref.paragraphId)) {
      errors.push(error("missing-reference", refPath, "evidence points to an unknown section or paragraph"));
      return;
    }
    if (!section.paragraphIds.includes(ref.paragraphId)) {
      errors.push(error("missing-reference", refPath, "paragraph does not belong to the referenced section"));
    }
    if (ref.sentenceIndex !== undefined && ref.sentenceIndex < 0) {
      errors.push(error("invalid-evidence", refPath, "sentenceIndex must be non-negative"));
    }
    if (ref.excerpt !== undefined && ref.excerpt.length > SCAN_LIMITS.maxExcerptLength) {
      errors.push(error("limit", `${refPath}/excerpt`, "evidence excerpt is too long"));
    }
  });
}

function checkEntityParents(
  entities: readonly ScanEntity[],
  entityIds: ReadonlySet<string>,
  errors: ScanValidationError[],
): void {
  const parents = new Map<string, string>();
  entities.forEach((entity, index) => {
    if (entity.parentId === undefined) return;
    if (!entityIds.has(entity.parentId)) {
      errors.push(error("missing-reference", `/entities/${index}/parentId`, "parent entity does not exist"));
      return;
    }
    parents.set(entity.id, entity.parentId);
  });

  for (const entity of entities) {
    const path = new Set<string>();
    let current: string | undefined = entity.id;
    while (current !== undefined) {
      if (path.has(current)) {
        errors.push(error("entity-cycle", `/entities/${entity.id}/parentId`, "entity parent references must be acyclic"));
        break;
      }
      path.add(current);
      current = parents.get(current);
    }
  }
}

function checkSemantic(
  bundle: ScanBundleV1,
  options: ScanValidationOptions,
): ScanValidationError[] {
  const errors: ScanValidationError[] = [];
  const limits = SCAN_LIMITS;

  if (bundle.source.title.length > limits.maxTitleLength) {
    errors.push(error("limit", "/source/title", "source title is too long"));
  }
  if (bundle.source.fingerprint.length > limits.maxFingerprintLength) {
    errors.push(error("limit", "/source/fingerprint", "source fingerprint is too long"));
  }
  if (Number.isNaN(Date.parse(bundle.provenance.generatedAt))) {
    errors.push(error("invalid-date", "/provenance/generatedAt", "generatedAt must be an ISO date-time"));
  }
  if (bundle.sections.length > limits.maxSections) {
    errors.push(error("limit", "/sections", "too many sections"));
  }
  if (bundle.entities.length > limits.maxEntities) {
    errors.push(error("limit", "/entities", "too many entities"));
  }
  if (bundle.relations.length > limits.maxRelations) {
    errors.push(error("limit", "/relations", "too many relations"));
  }
  if (bundle.phases.length > limits.maxPhases) {
    errors.push(error("limit", "/phases", "too many phases"));
  }
  if (bundle.events.length > limits.maxEvents) {
    errors.push(error("limit", "/events", "too many events"));
  }
  if (bundle.findings.length > limits.maxFindings) {
    errors.push(error("limit", "/findings", "too many findings"));
  }
  if (JSON.stringify(bundle).length > limits.maxBundleSerializedLength) {
    errors.push(error("limit", "/", "scan bundle payload is too large"));
  }

  const sectionIds = checkUniqueIds(bundle.sections, "section", "/sections", errors);
  const entityIds = checkUniqueIds(bundle.entities, "entity", "/entities", errors);
  checkUniqueIds(bundle.relations, "relation", "/relations", errors);
  checkUniqueIds(bundle.phases, "phase", "/phases", errors);
  checkUniqueIds(bundle.events, "event", "/events", errors);
  checkUniqueIds(bundle.findings, "finding", "/findings", errors);

  const sections = new Map<string, ScanSection>();
  const paragraphs = new Map<string, string>();
  bundle.sections.forEach((section, index) => {
    if (sections.has(section.id)) return;
    sections.set(section.id, section);
    if (section.ordinal !== index) {
      errors.push(error("order-mismatch", `/sections/${index}/ordinal`, "section ordinals must match array order"));
    }
    section.paragraphIds.forEach((paragraphId, paragraphIndex) => {
      if (paragraphs.has(paragraphId)) {
        errors.push(error("duplicate-id", `/sections/${index}/paragraphIds/${paragraphIndex}`, "duplicate paragraph id"));
      }
      paragraphs.set(paragraphId, `${section.ordinal}:${paragraphIndex}`);
      checkId(paragraphId, "paragraph", `/sections/${index}/paragraphIds/${paragraphIndex}`, errors);
    });
  });

  if (paragraphs.size > limits.maxParagraphs) {
    errors.push(error("limit", "/sections", "too many paragraphs"));
  }

  if (bundle.source.sectionCount !== bundle.sections.length) {
    errors.push(error("count-mismatch", "/source/sectionCount", "sectionCount does not match sections"));
  }
  if (bundle.source.paragraphCount !== paragraphs.size) {
    errors.push(error("count-mismatch", "/source/paragraphCount", "paragraphCount does not match section paragraph ids"));
  }

  bundle.entities.forEach((entity, index) => {
    if (entity.name.length > limits.maxEntityNameLength) {
      errors.push(error("limit", `/entities/${index}/name`, "entity name is too long"));
    }
    if (entity.aliases.length > limits.maxAliasesPerEntity) {
      errors.push(error("limit", `/entities/${index}/aliases`, "too many aliases"));
    }
    checkConfidence(entity.confidence, `/entities/${index}/confidence`, errors);
    checkEvidence(entity.evidence, `/entities/${index}/evidence`, true, sections, paragraphs, errors);
  });
  checkEntityParents(bundle.entities, entityIds, errors);

  bundle.relations.forEach((relation, index) => {
    if (!entityIds.has(relation.fromEntityId) || !entityIds.has(relation.toEntityId)) {
      errors.push(error("missing-reference", `/relations/${index}`, "relation references an unknown entity"));
    }
    if (relation.fromEntityId === relation.toEntityId && relation.type !== "self") {
      errors.push(error("relation-self-loop", `/relations/${index}`, "self-loop relations must use type self"));
    }
    if (relation.type.length > limits.maxRelationTypeLength) {
      errors.push(error("limit", `/relations/${index}/type`, "relation type is too long"));
    }
    checkConfidence(relation.confidence, `/relations/${index}/confidence`, errors);
    checkEvidence(relation.evidence, `/relations/${index}/evidence`, true, sections, paragraphs, errors);
  });

  const paragraphOrder = new Map<string, number>();
  bundle.sections.forEach((section) => {
    section.paragraphIds.forEach((paragraphId, paragraphIndex) => {
      paragraphOrder.set(paragraphId, section.ordinal * 100_000 + paragraphIndex);
    });
  });
  bundle.phases.forEach((phase, index) => {
    phase.entityIds.forEach((entityId, entityIndex) => {
      if (!entityIds.has(entityId)) {
        errors.push(error("missing-reference", `/phases/${index}/entityIds/${entityIndex}`, "phase references an unknown entity"));
      }
    });
    checkConfidence(phase.confidence, `/phases/${index}/confidence`, errors);
    checkEvidence(phase.anchors, `/phases/${index}/anchors`, true, sections, paragraphs, errors);
    let previousOrder = -1;
    phase.anchors.forEach((anchor) => {
      const order = paragraphOrder.get(anchor.paragraphId);
      if (order === undefined) return;
      if (order <= previousOrder) {
        errors.push(error("phase-order", `/phases/${index}/anchors`, "phase anchors must be strictly increasing"));
      }
      previousOrder = order;
    });
  });

  bundle.events.forEach((event, index) => {
    if (!sectionIds.has(event.sectionId)) {
      errors.push(error("missing-reference", `/events/${index}/sectionId`, "event references an unknown section"));
    }
    event.paragraphIds.forEach((paragraphId, paragraphIndex) => {
      if (!paragraphs.has(paragraphId)) {
        errors.push(error("missing-reference", `/events/${index}/paragraphIds/${paragraphIndex}`, "event references an unknown paragraph"));
      } else if (!sections.get(event.sectionId)?.paragraphIds.includes(paragraphId)) {
        errors.push(error("missing-reference", `/events/${index}/paragraphIds/${paragraphIndex}`, "event paragraph does not belong to event section"));
      }
    });
    event.entityIds.forEach((entityId, entityIndex) => {
      if (!entityIds.has(entityId)) {
        errors.push(error("missing-reference", `/events/${index}/entityIds/${entityIndex}`, "event references an unknown entity"));
      }
    });
    checkEvidence(event.evidence, `/events/${index}/evidence`, true, sections, paragraphs, errors);
  });

  bundle.findings.forEach((finding, index) => {
    if (
      finding.status !== "candidate" &&
      !(options.allowConfirmedFindingStatus && finding.status === "confirmed")
    ) {
      errors.push(error("finding-status", `/findings/${index}/status`, "model output findings must start as candidate"));
    }
    checkEvidence(finding.evidence, `/findings/${index}/evidence`, true, sections, paragraphs, errors);
    finding.relatedEntityIds?.forEach((entityId, entityIndex) => {
      if (!entityIds.has(entityId)) {
        errors.push(error("missing-reference", `/findings/${index}/relatedEntityIds/${entityIndex}`, "finding references an unknown entity"));
      }
    });
    finding.relatedEventIds?.forEach((eventId, eventIndex) => {
      if (!bundle.events.some((event) => event.id === eventId)) {
        errors.push(error("missing-reference", `/findings/${index}/relatedEventIds/${eventIndex}`, "finding references an unknown event"));
      }
    });
  });

  const observations = [
    ...bundle.summary.genreCandidates.map((item) => item.evidence),
    ...bundle.summary.themes.map((item) => item.evidence),
    ...bundle.summary.strengths.map((item) => item.evidence),
    ...bundle.summary.risks.map((item) => item.evidence),
  ];
  observations.forEach((evidence, index) => {
    checkEvidence(evidence, `/summary/${index}/evidence`, true, sections, paragraphs, errors);
  });
  [...bundle.summary.genreCandidates, ...bundle.summary.themes].forEach((item, index) => {
    checkConfidence(item.confidence, `/summary/inferred/${index}/confidence`, errors);
  });

  const totalEvidenceRefs = [
    ...bundle.entities.map((item) => item.evidence.length),
    ...bundle.relations.map((item) => item.evidence.length),
    ...bundle.phases.map((item) => item.anchors.length),
    ...bundle.events.map((item) => item.evidence.length),
    ...bundle.findings.map((item) => item.evidence.length),
    ...bundle.summary.genreCandidates.map((item) => item.evidence.length),
    ...bundle.summary.themes.map((item) => item.evidence.length),
    ...bundle.summary.strengths.map((item) => item.evidence.length),
    ...bundle.summary.risks.map((item) => item.evidence.length),
  ].reduce((total, count) => total + count, 0);
  if (totalEvidenceRefs > limits.maxTotalEvidenceRefs) {
    errors.push(error("limit", "/", "too many total evidence references"));
  }

  return errors;
}

export function validateScanBundle(
  input: unknown,
  options: ScanValidationOptions = {},
): ScanValidationResult {
  if (!validateShape(input)) {
    return { ok: false, errors: shapeErrors(validateShape.errors) };
  }
  const errors = checkSemantic(input as ScanBundleV1, options);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: input as ScanBundleV1 };
}

export function parseScanBundle(
  input: unknown,
  options: ScanValidationOptions = {},
): ScanValidationResult {
  return validateScanBundle(input, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSourceDocument(
  input: unknown,
  bundle: ScanBundleV1,
  errors: ScanValidationError[],
): input is SourceDocumentV1 {
  if (!isRecord(input)) {
    errors.push(error("schema:type", "/source", "source document must be an object"));
    return false;
  }
  const source = input;
  if (source.schemaVersion !== "grimodex-scan/source-document/1") {
    errors.push(error("schema:const", "/source/schemaVersion", "invalid source document schema version"));
  }
  if (typeof source.title !== "string") {
    errors.push(error("schema:type", "/source/title", "source title must be a string"));
  }
  if (typeof source.fingerprint !== "string") {
    errors.push(error("schema:type", "/source/fingerprint", "source fingerprint must be a string"));
  }
  if (!isScanLanguage(source.language)) {
    errors.push(error("schema:enum", "/source/language", "source language is invalid"));
  }
  if (source.fingerprint !== bundle.source.fingerprint) {
    errors.push(error("fingerprint-mismatch", "/source/fingerprint", "source and bundle fingerprints must match"));
  }
  if (source.title !== bundle.source.title) {
    errors.push(error("source-mismatch", "/source/title", "source and bundle titles must match"));
  }
  if (source.language !== bundle.source.language) {
    errors.push(error("source-mismatch", "/source/language", "source and bundle languages must match"));
  }
  if (!Array.isArray(source.sections)) {
    errors.push(error("schema:type", "/source/sections", "source sections must be an array"));
  }
  if (!Array.isArray(source.paragraphs)) {
    errors.push(error("schema:type", "/source/paragraphs", "source paragraphs must be an array"));
  }
  if (!Array.isArray(source.sections) || !Array.isArray(source.paragraphs)) return false;
  if (source.sections.length > SCAN_LIMITS.maxSections) {
    errors.push(error("limit", "/source/sections", "too many source sections"));
  }
  if (source.paragraphs.length > SCAN_LIMITS.maxParagraphs) {
    errors.push(error("limit", "/source/paragraphs", "too many source paragraphs"));
  }

  const sectionIds = new Set<string>();
  const paragraphIdsInSections = new Set<string>();
  const sectionParagraphs = new Map<string, Set<string>>();
  const paragraphOrdinals = new Map<string, number>();
  const sourceSections: SourceSectionV1[] = [];
  source.sections.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(error("schema:type", `/source/sections/${index}`, "source section must be an object"));
      return;
    }
    if (typeof value.id !== "string") {
      errors.push(error("schema:type", `/source/sections/${index}/id`, "section id must be a string"));
      return;
    }
    if (typeof value.ordinal !== "number" || !Number.isInteger(value.ordinal) || value.ordinal < 0) {
      errors.push(error("schema:type", `/source/sections/${index}/ordinal`, "section ordinal must be a non-negative integer"));
    } else if (value.ordinal !== index) {
      errors.push(error("order-mismatch", `/source/sections/${index}/ordinal`, "source section ordinals must match array order"));
    }
    if (typeof value.title !== "string") {
      errors.push(error("schema:type", `/source/sections/${index}/title`, "source section title must be a string"));
    } else if (value.title.length > SCAN_LIMITS.maxTitleLength) {
      errors.push(error("limit", `/source/sections/${index}/title`, "source section title is too long"));
    }
    checkId(value.id, "section", `/source/sections/${index}/id`, errors);
    if (sectionIds.has(value.id)) {
      errors.push(error("duplicate-id", `/source/sections/${index}/id`, "duplicate source section id"));
    }
    sectionIds.add(value.id);
    if (!Array.isArray(value.paragraphIds)) {
      errors.push(error("schema:type", `/source/sections/${index}/paragraphIds`, "paragraphIds must be an array"));
      return;
    }
    if (value.paragraphIds.length > SCAN_LIMITS.maxParagraphs) {
      errors.push(error("limit", `/source/sections/${index}/paragraphIds`, "too many source paragraph references"));
    }
    const paragraphIds = new Set<string>();
    value.paragraphIds.forEach((paragraphId, paragraphIndex) => {
      if (typeof paragraphId !== "string") {
        errors.push(error("schema:type", `/source/sections/${index}/paragraphIds/${paragraphIndex}`, "paragraph id must be a string"));
        return;
      }
      checkId(paragraphId, "paragraph", `/source/sections/${index}/paragraphIds/${paragraphIndex}`, errors);
      if (paragraphIdsInSections.has(paragraphId)) {
        errors.push(error("duplicate-id", `/source/sections/${index}/paragraphIds/${paragraphIndex}`, "duplicate source paragraph id"));
      }
      paragraphIdsInSections.add(paragraphId);
      paragraphIds.add(paragraphId);
      paragraphOrdinals.set(paragraphId, paragraphIndex);
    });
    sectionParagraphs.set(value.id, paragraphIds);
    if (
      typeof value.ordinal === "number" &&
      Number.isInteger(value.ordinal) &&
      value.ordinal >= 0 &&
      typeof value.title === "string"
    ) {
      sourceSections.push({
        id: value.id,
        ordinal: value.ordinal,
        title: value.title,
        paragraphIds: [...value.paragraphIds],
      });
    }
  });

  const paragraphIds = new Set<string>();
  const sourceParagraphs: SourceParagraphV1[] = [];
  source.paragraphs.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(error("schema:type", `/source/paragraphs/${index}`, "source paragraph must be an object"));
      return;
    }
    if (typeof value.id !== "string") {
      errors.push(error("schema:type", `/source/paragraphs/${index}/id`, "paragraph id must be a string"));
      return;
    }
    checkId(value.id, "paragraph", `/source/paragraphs/${index}/id`, errors);
    if (paragraphIds.has(value.id)) {
      errors.push(error("duplicate-id", `/source/paragraphs/${index}/id`, "duplicate source paragraph id"));
    }
    paragraphIds.add(value.id);
    if (typeof value.sectionId !== "string" || !sectionParagraphs.has(value.sectionId)) {
      errors.push(error("missing-reference", `/source/paragraphs/${index}/sectionId`, "paragraph references an unknown section"));
    } else if (!sectionParagraphs.get(value.sectionId)?.has(value.id)) {
      errors.push(error("missing-reference", `/source/paragraphs/${index}`, "paragraph is not listed by its section"));
    }
    if (typeof value.ordinal !== "number" || !Number.isInteger(value.ordinal) || value.ordinal < 0) {
      errors.push(error("schema:type", `/source/paragraphs/${index}/ordinal`, "paragraph ordinal must be a non-negative integer"));
    } else if (
      typeof value.sectionId === "string" &&
      sectionParagraphs.has(value.sectionId)
    ) {
      const expectedOrdinal = paragraphOrdinals.get(value.id);
      if (expectedOrdinal === undefined || value.ordinal !== expectedOrdinal) {
        errors.push(error("order-mismatch", `/source/paragraphs/${index}/ordinal`, "paragraph ordinal does not match its section order"));
      }
    }
    if (typeof value.text !== "string") {
      errors.push(error("schema:type", `/source/paragraphs/${index}/text`, "paragraph text must be a string"));
    } else if (value.text.length > SCAN_LIMITS.maxTextLength) {
      errors.push(error("limit", `/source/paragraphs/${index}/text`, "paragraph text is too long"));
    }
    if (
      typeof value.sectionId === "string" &&
      typeof value.ordinal === "number" &&
      Number.isInteger(value.ordinal) &&
      value.ordinal >= 0 &&
      typeof value.text === "string"
    ) {
      sourceParagraphs.push({
        id: value.id,
        sectionId: value.sectionId,
        ordinal: value.ordinal,
        text: value.text,
      });
    }
  });

  const bundleSectionIds = new Set(bundle.sections.map((section) => section.id));
  const bundleParagraphIds = new Set(bundle.sections.flatMap((section) => section.paragraphIds));
  if (sectionIds.size !== bundleSectionIds.size || [...bundleSectionIds].some((id) => !sectionIds.has(id))) {
    errors.push(error("source-mismatch", "/source/sections", "source and bundle sections must match"));
  }
  if (paragraphIds.size !== bundleParagraphIds.size || [...bundleParagraphIds].some((id) => !paragraphIds.has(id))) {
    errors.push(error("source-mismatch", "/source/paragraphs", "source and bundle paragraphs must match"));
  }

  bundle.sections.forEach((bundleSection, index) => {
    const sourceSection = sourceSections[index];
    if (!sourceSection) return;
    if (
      sourceSection.id !== bundleSection.id ||
      sourceSection.ordinal !== bundleSection.ordinal ||
      sourceSection.title !== bundleSection.title ||
      sourceSection.paragraphIds.length !== bundleSection.paragraphIds.length ||
      sourceSection.paragraphIds.some((id, paragraphIndex) => id !== bundleSection.paragraphIds[paragraphIndex])
    ) {
      errors.push(error("source-mismatch", `/source/sections/${index}`, "source and bundle section structure must match exactly"));
    }
  });

  if (isScanLanguage(source.language) && typeof source.title === "string") {
    const expectedFingerprint = computeSourceFingerprint({
      title: source.title,
      language: source.language,
      sections: sourceSections,
      paragraphs: sourceParagraphs,
    });
    if (source.fingerprint !== expectedFingerprint) {
      errors.push(error("fingerprint-content-mismatch", "/source/fingerprint", "source fingerprint does not match source structure and text"));
    }
  }
  return true;
}

function sentenceCount(text: string): number {
  const count = text.match(/[。！？!?]+/g)?.length ?? 0;
  return Math.max(1, count);
}

function checkSeedEvidenceAgainstSource(
  bundle: ScanBundleV1,
  source: SourceDocumentV1,
  errors: ScanValidationError[],
): void {
  const paragraphText = new Map(source.paragraphs.map((paragraph) => [paragraph.id, paragraph.text]));
  const carriers: Array<{ path: string; evidence: readonly EvidenceRef[] }> = [
    ...bundle.entities.map((item, index) => ({ path: `/bundle/entities/${index}/evidence`, evidence: item.evidence })),
    ...bundle.relations.map((item, index) => ({ path: `/bundle/relations/${index}/evidence`, evidence: item.evidence })),
    ...bundle.phases.map((item, index) => ({ path: `/bundle/phases/${index}/anchors`, evidence: item.anchors })),
    ...bundle.events.map((item, index) => ({ path: `/bundle/events/${index}/evidence`, evidence: item.evidence })),
    ...bundle.findings.map((item, index) => ({ path: `/bundle/findings/${index}/evidence`, evidence: item.evidence })),
    ...bundle.summary.genreCandidates.map((item, index) => ({ path: `/bundle/summary/genreCandidates/${index}/evidence`, evidence: item.evidence })),
    ...bundle.summary.themes.map((item, index) => ({ path: `/bundle/summary/themes/${index}/evidence`, evidence: item.evidence })),
    ...bundle.summary.strengths.map((item, index) => ({ path: `/bundle/summary/strengths/${index}/evidence`, evidence: item.evidence })),
    ...bundle.summary.risks.map((item, index) => ({ path: `/bundle/summary/risks/${index}/evidence`, evidence: item.evidence })),
  ];

  carriers.forEach(({ path, evidence }) => {
    evidence.forEach((ref, index) => {
      const text = paragraphText.get(ref.paragraphId);
      if (text === undefined) return;
      if (ref.excerpt !== undefined && !text.includes(ref.excerpt)) {
        errors.push(error("invalid-evidence", `${path}/${index}/excerpt`, "evidence excerpt is not present in source paragraph"));
      }
      if (ref.sentenceIndex !== undefined && ref.sentenceIndex >= sentenceCount(text)) {
        errors.push(error("invalid-evidence", `${path}/${index}/sentenceIndex`, "sentenceIndex is outside the source paragraph"));
      }
    });
  });
}

export function parseEditorSeed(
  input: unknown,
  options: ScanValidationOptions = {},
): EditorSeedValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: [error("schema:type", "/", "editor seed must be an object")] };
  }
  const errors: ScanValidationError[] = [];
  if (input.schemaVersion !== "grimodex-scan/editor-seed/1") {
    errors.push(error("schema:const", "/schemaVersion", "invalid editor seed schema version"));
  }
  const bundleResult = validateScanBundle(input.bundle, options);
  if (!bundleResult.ok) errors.push(...bundleResult.errors);
  const bundle = bundleResult.ok ? bundleResult.value : null;
  if (bundle) validateSourceDocument(input.source, bundle, errors);
  else if (!isRecord(input.source)) errors.push(error("schema:type", "/source", "editor seed source is invalid"));
  if (
    bundle &&
    isRecord(input.source) &&
    Array.isArray(input.source.paragraphs)
  ) {
    checkSeedEvidenceAgainstSource(bundle, input.source as unknown as SourceDocumentV1, errors);
  }
  if (errors.length > 0 || !bundle || !isRecord(input.source)) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      schemaVersion: "grimodex-scan/editor-seed/1",
      bundle,
      source: input.source as unknown as SourceDocumentV1,
    },
  };
}
