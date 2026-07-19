import type { ChunkExtractionV1, ScanBundleV1 } from "@grimodex/scan-contract";

export interface ChunkParagraphInput {
  paragraphId: string;
  sectionId: string;
  text: string;
}

export interface ChunkExtractionInput {
  language: "ja" | "en";
  chunkId: string;
  sourceFingerprint: string;
  text: string;
  sectionIds: string[];
  paragraphIds: string[];
  paragraphSectionIds?: Record<string, string>;
  paragraphs: ChunkParagraphInput[];
}

export interface AdjudicationInput {
  language: "ja" | "en";
  sourceFingerprint: string;
  ambiguityId: string;
  evidenceParagraphs: Array<{ paragraphId: string; text: string }>;
  candidateSummary: string;
}

export interface AdjudicationResultV1 {
  schemaVersion: "grimodex-scan/adjudication/1";
  ambiguityId: string;
  decision: "merge" | "keep-separate" | "uncertain";
  rationale: string;
}

export interface ReportInput {
  bundle: ScanBundleV1;
}

export interface ReportNarrativeV1 {
  schemaVersion: "grimodex-scan/report-narrative/1";
  premise?: string;
  strengths: string[];
  risks: string[];
}

export interface ScanAiProvider {
  extractChunk(input: ChunkExtractionInput): Promise<ChunkExtractionV1>;
  adjudicate(input: AdjudicationInput): Promise<AdjudicationResultV1>;
  writeReport(input: ReportInput): Promise<ReportNarrativeV1>;
}

export interface ScanModelProfile {
  provider: "workers-ai" | "ai-gateway" | "openrouter";
  model: string;
  maxInputCharacters: number;
  maxOutputCharacters: number;
  allowFallback: boolean;
}

export class ScanProviderError extends Error {
  constructor(
    readonly code:
      | "timeout"
      | "rate-limited"
      | "invalid-json"
      | "schema-invalid"
      | "unavailable",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ScanProviderError";
  }
}
