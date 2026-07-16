import {
  parseEditorSeed,
  sha256Hex,
  type EditorSeedV1,
  type EvidenceRef,
  type ScanBundleV1,
  type ScanEntityType,
  type ScanFinding,
  type ScanRelation,
  type ScanPhase,
  type ScanEvent,
} from "@grimodex/scan-contract";
import type { ImportedNode } from "../importTypes";

export type ScanImportCodexType =
  | "character"
  | "location"
  | "organization"
  | "item"
  | "lore";

export interface ScanIdMap {
  sections: Record<string, string>;
  paragraphs: Record<string, string>;
  entities: Record<string, string>;
  relations: Record<string, string>;
  phases: Record<string, string>;
  events: Record<string, string>;
  findings: Record<string, string>;
}

export interface ScanCodexImportPlan {
  id: string;
  sourceEntityId: string;
  type: ScanImportCodexType;
  name: string;
  aliases: string[];
  summary?: string;
  parentId?: string;
  confidence: number;
  evidence: EvidenceRef[];
}

export interface ScanRelationImportPlan {
  id: string;
  sourceRelationId: string;
  fromCodexId: string;
  toCodexId: string;
  type: string;
  label?: string;
  confidence: number;
  evidence: EvidenceRef[];
}

export interface ScanPhaseImportPlan {
  id: string;
  sourcePhaseId: string;
  title: string;
  entityIds: string[];
  anchorNodeId?: string;
  anchorNodeIds?: string[];
  anchors: EvidenceRef[];
  summary?: string;
  confidence: number;
}

export interface ScanEventImportPlan {
  id: string;
  sourceEventId: string;
  sectionId: string;
  sourceSectionId: string;
  sceneId: string;
  paragraphIds: string[];
  entityIds: string[];
  title: string;
  summary?: string;
  order: number;
  evidence: EvidenceRef[];
}

export type ScanFindingImportPlan = Omit<
  ScanFinding,
  "id" | "relatedEntityIds" | "relatedEventIds"
> & {
  id: string;
  sourceFindingId: string;
  relatedEntityIds?: string[];
  relatedEventIds?: string[];
};

export interface ScanImportPlan {
  schemaVersion: "grimodex-scan/import-plan/1";
  importInstanceId: string;
  projectTitle: string;
  language: "ja" | "en";
  sourceFingerprint: string;
  nodes: ImportedNode[];
  codexEntries: ScanCodexImportPlan[];
  relations: ScanRelationImportPlan[];
  phases: ScanPhaseImportPlan[];
  events: ScanEventImportPlan[];
  findings: ScanFindingImportPlan[];
  idMap: ScanIdMap;
  warnings: string[];
}

export function deriveScanImportId(
  fingerprint: string,
  namespace: string,
  sourceId: string,
  importInstanceId: string,
): string {
  const hex = sha256Hex(
    `grimodex-scan-import\u0000${fingerprint}\u0000${importInstanceId}\u0000${namespace}\u0000${sourceId}`,
  )
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function mapEntityType(type: ScanEntityType): ScanImportCodexType {
  switch (type) {
    case "character":
      return "character";
    case "place":
      return "location";
    case "organization":
      return "organization";
    case "object":
      return "item";
    case "alias":
    case "unknown":
      return "lore";
  }
}

function mapRecord<T>(
  records: readonly T[],
  getId: (record: T) => string,
  fingerprint: string,
  namespace: string,
  importInstanceId: string,
): Record<string, string> {
  return Object.fromEntries(
    records.map((record) => {
      const sourceId = getId(record);
      return [
        sourceId,
        deriveScanImportId(fingerprint, namespace, sourceId, importInstanceId),
      ];
    }),
  );
}

function sourceParagraphsForSection(
  seed: EditorSeedV1,
  sectionId: string,
): string[] {
  return seed.source.paragraphs
    .filter((paragraph) => paragraph.sectionId === sectionId)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((paragraph) => paragraph.text);
}

function buildNodes(
  seed: EditorSeedV1,
  idMap: ScanIdMap,
  importInstanceId: string,
): ImportedNode[] {
  return seed.source.sections.map((section) => {
    const paragraphTexts = sourceParagraphsForSection(seed, section.id);
    const children: ImportedNode[] =
      paragraphTexts.length > 0
        ? [
            {
              kind: "scene",
              id: deriveScanImportId(
                seed.source.fingerprint,
                "scene",
                section.id,
                importInstanceId,
              ),
              title: section.title || "Untitled",
              body: paragraphTexts.join("\n\n"),
            },
          ]
        : [];
    return {
      kind: "folder",
      id: idMap.sections[section.id]!,
      title: section.title || "Untitled",
      children,
    };
  });
}

function mapRelations(
  bundle: ScanBundleV1,
  idMap: ScanIdMap,
): ScanRelationImportPlan[] {
  return bundle.relations.map((relation: ScanRelation) => ({
    id: idMap.relations[relation.id]!,
    sourceRelationId: relation.id,
    fromCodexId: idMap.entities[relation.fromEntityId]!,
    toCodexId: idMap.entities[relation.toEntityId]!,
    type: relation.type,
    label: relation.label,
    confidence: relation.confidence,
    evidence: relation.evidence,
  }));
}

function mapPhases(
  bundle: ScanBundleV1,
  idMap: ScanIdMap,
  importInstanceId: string,
): ScanPhaseImportPlan[] {
  return bundle.phases.map((phase: ScanPhase) => ({
    id: idMap.phases[phase.id]!,
    sourcePhaseId: phase.id,
    title: phase.title,
    entityIds: phase.entityIds.map((entityId) => idMap.entities[entityId]!),
    anchorNodeId: phase.anchors[0]
      ? deriveScanImportId(
          bundle.source.fingerprint,
          "scene",
          phase.anchors[0].sectionId,
          importInstanceId,
        )
      : undefined,
    anchorNodeIds: phase.anchors.map((anchor) =>
      deriveScanImportId(
        bundle.source.fingerprint,
        "scene",
        anchor.sectionId,
        importInstanceId,
      ),
    ),
    anchors: phase.anchors,
    summary: phase.summary,
    confidence: phase.confidence,
  }));
}

function mapEvents(
  bundle: ScanBundleV1,
  idMap: ScanIdMap,
  importInstanceId: string,
): ScanEventImportPlan[] {
  return bundle.events.map((event: ScanEvent) => ({
    id: idMap.events[event.id]!,
    sourceEventId: event.id,
    sectionId: idMap.sections[event.sectionId]!,
    sourceSectionId: event.sectionId,
    sceneId: deriveScanImportId(
      bundle.source.fingerprint,
      "scene",
      event.sectionId,
      importInstanceId,
    ),
    paragraphIds: event.paragraphIds.map(
      (paragraphId) => idMap.paragraphs[paragraphId]!,
    ),
    entityIds: event.entityIds.map((entityId) => idMap.entities[entityId]!),
    title: event.title,
    summary: event.summary,
    order: event.order,
    evidence: event.evidence,
  }));
}

function mapFindings(
  bundle: ScanBundleV1,
  idMap: ScanIdMap,
): ScanFindingImportPlan[] {
  return bundle.findings.map((finding) => ({
    ...finding,
    id: idMap.findings[finding.id]!,
    sourceFindingId: finding.id,
    relatedEntityIds: finding.relatedEntityIds?.map(
      (entityId) => idMap.entities[entityId]!,
    ),
    relatedEventIds: finding.relatedEventIds?.map(
      (eventId) => idMap.events[eventId]!,
    ),
  }));
}

export function buildScanImportPlan(
  input: unknown,
  options: { importInstanceId?: string } = {},
): ScanImportPlan {
  const validation = parseEditorSeed(input);
  if (!validation.ok) {
    throw new Error(
      `Scan editor seed is invalid: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`,
    );
  }
  const seed = validation.value;
  if (seed.source.language === "other") {
    throw new Error(
      "Scan editor seed uses unsupported language: other (only ja and en can be imported)",
    );
  }
  const { bundle } = seed;
  const importInstanceId = options.importInstanceId ?? crypto.randomUUID();
  if (importInstanceId.trim().length === 0) {
    throw new Error("Scan import instance ID must not be empty");
  }
  const idMap: ScanIdMap = {
    sections: mapRecord(
      bundle.sections,
      (record) => record.id,
      seed.source.fingerprint,
      "section",
      importInstanceId,
    ),
    paragraphs: Object.fromEntries(
      seed.source.paragraphs.map((paragraph) => [
        paragraph.id,
        deriveScanImportId(
          seed.source.fingerprint,
          "scene",
          paragraph.sectionId,
          importInstanceId,
        ),
      ]),
    ),
    entities: mapRecord(
      bundle.entities,
      (record) => record.id,
      seed.source.fingerprint,
      "entity",
      importInstanceId,
    ),
    relations: mapRecord(
      bundle.relations,
      (record) => record.id,
      seed.source.fingerprint,
      "relation",
      importInstanceId,
    ),
    phases: mapRecord(
      bundle.phases,
      (record) => record.id,
      seed.source.fingerprint,
      "phase",
      importInstanceId,
    ),
    events: mapRecord(
      bundle.events,
      (record) => record.id,
      seed.source.fingerprint,
      "event",
      importInstanceId,
    ),
    findings: mapRecord(
      bundle.findings,
      (record) => record.id,
      seed.source.fingerprint,
      "finding",
      importInstanceId,
    ),
  };

  return {
    schemaVersion: "grimodex-scan/import-plan/1",
    importInstanceId,
    projectTitle: seed.source.title,
    language: seed.source.language === "en" ? "en" : "ja",
    sourceFingerprint: seed.source.fingerprint,
    nodes: buildNodes(seed, idMap, importInstanceId),
    codexEntries: bundle.entities.map((entity) => ({
      id: idMap.entities[entity.id]!,
      sourceEntityId: entity.id,
      type: mapEntityType(entity.type),
      name: entity.name,
      aliases: entity.aliases,
      summary: entity.summary,
      parentId: entity.parentId ? idMap.entities[entity.parentId] : undefined,
      confidence: entity.confidence,
      evidence: entity.evidence,
    })),
    relations: mapRelations(bundle, idMap),
    phases: mapPhases(bundle, idMap, importInstanceId),
    events: mapEvents(bundle, idMap, importInstanceId),
    findings: mapFindings(bundle, idMap),
    idMap,
    warnings: seed.source.sections
      .filter((section) => section.paragraphIds.length === 0)
      .map(
        (section) =>
          `section ${section.title} has no paragraphs and will be imported as an empty folder`,
      ),
  };
}

/** Rebuild a persisted plan without changing any imported database IDs. */
export function rebuildScanImportPlan(
  input: unknown,
  persistedPlan: unknown,
): ScanImportPlan {
  if (
    typeof persistedPlan !== "object" ||
    persistedPlan === null ||
    Array.isArray(persistedPlan) ||
    (persistedPlan as Record<string, unknown>).schemaVersion !==
      "grimodex-scan/import-plan/1" ||
    typeof (persistedPlan as Record<string, unknown>).importInstanceId !==
      "string" ||
    !(persistedPlan as Record<string, unknown>).importInstanceId
  ) {
    throw new Error("Persisted Scan import plan is invalid");
  }
  return buildScanImportPlan(input, {
    importInstanceId: (persistedPlan as { importInstanceId: string })
      .importInstanceId,
  });
}
