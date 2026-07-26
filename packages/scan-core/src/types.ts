import type {
  EvidenceRef,
  ScanEntityType,
  ScanEntity,
  ScanEvent,
  ScanFinding,
  ScanPhase,
  ScanRelation,
  ScanLanguage,
  ScanModelUsage,
  ScanSection,
  ScanSource,
  ScanSummary,
} from "@grimodex/scan-contract";

export interface SourceDocumentInput {
  title: string;
  text: string;
  language: ScanLanguage;
}

export interface NormalizedParagraph {
  id: string;
  sectionId: string;
  sectionOrdinal: number;
  ordinal: number;
  text: string;
}

export interface NormalizedSection extends ScanSection {
  paragraphs: NormalizedParagraph[];
}

export interface NormalizedDocument {
  title: string;
  text: string;
  source: ScanSource;
  sections: NormalizedSection[];
  paragraphs: NormalizedParagraph[];
}

export interface ScanChunk {
  id: string;
  text: string;
  paragraphIds: string[];
  overlapParagraphIds: string[];
  sectionIds: string[];
}

export interface BuildChunksOptions {
  maxCharacters: number;
  overlapParagraphs?: number;
}

export interface EntityExtractionCandidate {
  type: ScanEntityType;
  name: string;
  aliases: string[];
  summary?: string;
  evidence: EvidenceRef[];
  confidence: number;
}

export interface AmbiguityCluster {
  id: string;
  names: string[];
  candidateIndexes: number[];
}

export interface EntityMergeResult {
  entities: ScanEntity[];
  ambiguities: AmbiguityCluster[];
}

export interface RelationExtractionCandidate {
  fromName: string;
  toName: string;
  type: string;
  label?: string;
  evidence: EvidenceRef[];
  confidence: number;
}

export interface RelationMergeResult {
  relations: ScanRelation[];
  unresolved: RelationExtractionCandidate[];
}

export interface EventExtractionCandidate {
  title: string;
  summary?: string;
  sectionId: string;
  paragraphIds: string[];
  entityNames: string[];
  order: number;
  evidence: EvidenceRef[];
}

export interface EventMergeResult {
  events: ScanEvent[];
  unresolved: EventExtractionCandidate[];
}

export interface PhaseExtractionCandidate {
  title: string;
  entityNames: string[];
  anchors: EvidenceRef[];
  summary?: string;
  confidence: number;
}

export interface PhaseBuildResult {
  phases: ScanPhase[];
  unresolved: PhaseExtractionCandidate[];
}

export interface BuildScanBundleInput {
  document: NormalizedDocument;
  entities: ScanEntity[];
  relations: ScanRelation[];
  phases?: ScanPhase[];
  events?: ScanEvent[];
  findings?: ScanFinding[];
  summary?: ScanSummary;
  pipelineVersion: string;
  promptVersions?: Record<string, string>;
  models?: ScanModelUsage[];
}
