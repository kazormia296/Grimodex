export const SCAN_SCHEMA_VERSION = "grimodex-scan/1" as const;

export type ScanSchemaVersion = typeof SCAN_SCHEMA_VERSION;
export type ScanLanguage = "ja" | "en" | "other";
export type ScanEntityType =
  | "character"
  | "place"
  | "organization"
  | "object"
  | "alias"
  | "unknown";
export type FindingStatus =
  | "candidate"
  | "confirmed"
  | "rejected"
  | "intentional";
export type ScanFindingKind =
  | "continuity"
  | "timeline"
  | "knowledge"
  | "ambiguity"
  | "other";

export interface EvidenceRef {
  sectionId: string;
  paragraphId: string;
  sentenceIndex?: number;
  excerpt?: string;
}

export interface InferredValue<T> {
  value: T;
  confidence: number;
  evidence: EvidenceRef[];
}

export interface ScanSource {
  title: string;
  language: ScanLanguage;
  fingerprint: string;
  characterCount: number;
  paragraphCount: number;
  sectionCount: number;
}

export interface ScanSection {
  id: string;
  ordinal: number;
  title: string;
  paragraphIds: string[];
}

export interface ScanEntity {
  id: string;
  type: ScanEntityType;
  name: string;
  aliases: string[];
  summary?: string;
  parentId?: string;
  evidence: EvidenceRef[];
  confidence: number;
}

export interface ScanRelation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  label?: string;
  confidence: number;
  evidence: EvidenceRef[];
}

export interface ScanPhase {
  id: string;
  title: string;
  entityIds: string[];
  anchors: EvidenceRef[];
  summary?: string;
  confidence: number;
}

export interface ScanEvent {
  id: string;
  title: string;
  summary?: string;
  sectionId: string;
  paragraphIds: string[];
  entityIds: string[];
  order: number;
  evidence: EvidenceRef[];
}

export interface ScanFinding {
  id: string;
  kind: ScanFindingKind;
  status: FindingStatus;
  title: string;
  summary: string;
  evidence: EvidenceRef[];
  relatedEntityIds?: string[];
  relatedEventIds?: string[];
}

export interface ScanObservation {
  title: string;
  summary: string;
  evidence: EvidenceRef[];
}

export interface ScanModelUsage {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

export interface ScanSummary {
  premise?: string;
  genreCandidates: InferredValue<string>[];
  themes: InferredValue<string>[];
  strengths: ScanObservation[];
  risks: ScanObservation[];
}

export interface ScanProvenance {
  pipelineVersion: string;
  promptVersions: Record<string, string>;
  models: ScanModelUsage[];
  generatedAt: string;
}

export interface ScanBundleV1 {
  schemaVersion: ScanSchemaVersion;
  source: ScanSource;
  sections: ScanSection[];
  entities: ScanEntity[];
  relations: ScanRelation[];
  phases: ScanPhase[];
  events: ScanEvent[];
  findings: ScanFinding[];
  summary: ScanSummary;
  provenance: ScanProvenance;
}
