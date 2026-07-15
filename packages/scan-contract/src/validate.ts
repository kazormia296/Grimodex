import { Ajv, type ErrorObject } from "ajv";
import { ID_PATTERNS, SCAN_LIMITS, type ScanIdKind } from "./limits.js";
import { scanBundleV1Schema } from "./schema.js";
import type {
  EvidenceRef,
  ScanBundleV1,
  ScanEntity,
  ScanSection,
} from "./scanBundleV1.js";

export interface ScanValidationError {
  code: string;
  path: string;
  message: string;
}

export type ScanValidationResult =
  | { ok: true; value: ScanBundleV1 }
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

function checkSemantic(bundle: ScanBundleV1): ScanValidationError[] {
  const errors: ScanValidationError[] = [];
  const limits = SCAN_LIMITS;

  if (bundle.source.title.length > limits.maxTitleLength) {
    errors.push(error("limit", "/source/title", "source title is too long"));
  }
  if (bundle.source.fingerprint.length > limits.maxFingerprintLength) {
    errors.push(error("limit", "/source/fingerprint", "source fingerprint is too long"));
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
    section.paragraphIds.forEach((paragraphId, paragraphIndex) => {
      if (paragraphs.has(paragraphId)) {
        errors.push(error("duplicate-id", `/sections/${index}/paragraphIds/${paragraphIndex}`, "duplicate paragraph id"));
      }
      paragraphs.set(paragraphId, `${section.ordinal}:${paragraphIndex}`);
      checkId(paragraphId, "paragraph", `/sections/${index}/paragraphIds/${paragraphIndex}`, errors);
    });
  });

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
    checkEvidence(finding.evidence, `/findings/${index}/evidence`, true, sections, paragraphs, errors);
    finding.relatedEntityIds?.forEach((entityId, entityIndex) => {
      if (!entityIds.has(entityId)) {
        errors.push(error("missing-reference", `/findings/${index}/relatedEntityIds/${entityIndex}`, "finding references an unknown entity"));
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
    checkEvidence(evidence, `/summary/${index}/evidence`, false, sections, paragraphs, errors);
  });
  [...bundle.summary.genreCandidates, ...bundle.summary.themes].forEach((item, index) => {
    checkConfidence(item.confidence, `/summary/inferred/${index}/confidence`, errors);
  });

  return errors;
}

export function validateScanBundle(input: unknown): ScanValidationResult {
  if (!validateShape(input)) {
    return { ok: false, errors: shapeErrors(validateShape.errors) };
  }
  const errors = checkSemantic(input as ScanBundleV1);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: input as ScanBundleV1 };
}

export function parseScanBundle(input: unknown): ScanValidationResult {
  return validateScanBundle(input);
}
