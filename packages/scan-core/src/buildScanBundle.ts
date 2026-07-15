import {
  EDITOR_SEED_SCHEMA_VERSION,
  SOURCE_DOCUMENT_SCHEMA_VERSION,
  SCAN_SCHEMA_VERSION,
  type EditorSeedV1,
  type ScanBundleV1,
  type SourceDocumentV1,
} from "@grimodex/scan-contract";
import { parseEditorSeed, parseScanBundle } from "@grimodex/scan-contract";
import type { BuildScanBundleInput, NormalizedDocument } from "./types.js";

export function buildSourceDocument(document: NormalizedDocument): SourceDocumentV1 {
  return {
    schemaVersion: SOURCE_DOCUMENT_SCHEMA_VERSION,
    title: document.source.title,
    language: document.source.language,
    fingerprint: document.source.fingerprint,
    sections: document.sections.map((section) => ({
      id: section.id,
      ordinal: section.ordinal,
      title: section.title,
      paragraphIds: [...section.paragraphIds],
    })),
    paragraphs: document.paragraphs.map((paragraph) => ({
      id: paragraph.id,
      sectionId: paragraph.sectionId,
      ordinal: paragraph.ordinal,
      text: paragraph.text,
    })),
  };
}

export function buildScanBundle(input: BuildScanBundleInput): ScanBundleV1 {
  const bundle: ScanBundleV1 = {
    schemaVersion: SCAN_SCHEMA_VERSION,
    source: input.document.source,
    sections: input.document.sections.map((section) => ({
      id: section.id,
      ordinal: section.ordinal,
      title: section.title,
      paragraphIds: [...section.paragraphIds],
    })),
    entities: input.entities,
    relations: input.relations,
    phases: input.phases ?? [],
    events: input.events ?? [],
    findings: input.findings ?? [],
    summary: input.summary ?? {
      genreCandidates: [],
      themes: [],
      strengths: [],
      risks: [],
    },
    provenance: {
      pipelineVersion: input.pipelineVersion,
      promptVersions: input.promptVersions ?? {},
      models: input.models ?? [],
      generatedAt: new Date().toISOString(),
    },
  };
  const validation = parseScanBundle(bundle);
  if (!validation.ok) {
    throw new Error(
      `ScanBundleV1 validation failed: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`,
    );
  }
  return validation.value;
}

export function buildEditorSeed(
  bundle: ScanBundleV1,
  document: NormalizedDocument,
): EditorSeedV1 {
  const seed: EditorSeedV1 = {
    schemaVersion: EDITOR_SEED_SCHEMA_VERSION,
    bundle,
    source: buildSourceDocument(document),
  };
  const validation = parseEditorSeed(seed);
  if (!validation.ok) {
    throw new Error(
      `EditorSeedV1 validation failed: ${validation.errors.map((item) => `${item.path} ${item.message}`).join("; ")}`,
    );
  }
  return validation.value;
}
