import type {
  EditorSeedV1,
  ScanBundleV1,
  ScanEntity,
} from "@grimodex/scan-contract";
import { sha256Hex } from "@grimodex/scan-contract";
import type { ImportAdapter, ImportAdapterParseInput } from "../adapterTypes";
import type { ImportCodexEntryRecord } from "../../core/importSourceRecord";
import type { ImportSourcePackageDraft } from "../../core/importSourcePackage";
import { IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION } from "../../core/importSourcePackage";
import { EMPTY_PROSEMIRROR_DOC } from "../../core/importSourceDocument";
import { importDiagnostic } from "../../core/importDiagnostics";
import { validateImportSourcePackageDraft } from "../adapterValidation";

const DESCRIPTOR = {
  id: "scan",
  version: "1",
  label: "Scan Bundle",
  inputKinds: ["scan-bundle", "editor-seed"] as const,
  capabilities: {
    supportsStructure: true,
    supportsCodex: true,
    supportsSnippets: false,
    supportsReimport: true,
  },
} as const;

function isScanBundle(value: unknown): value is ScanBundleV1 {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === "grimodex-scan/1" && Array.isArray(record.sections);
}

function isEditorSeed(value: unknown): value is EditorSeedV1 {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === "grimodex-scan/editor-seed/1" &&
    isScanBundle((record as unknown as EditorSeedV1).bundle)
  );
}

function mapEntityToCodexRecord(entity: ScanEntity): ImportCodexEntryRecord {
  return {
    id: entity.id,
    origin: "external-analysis",
    kind: "codex-entry",
    sourceKey: entity.id,
    name: entity.name,
    entryType: entity.type,
    aliases: entity.aliases,
    summary: entity.summary,
    parentRecordId: entity.parentId,
    confidence: entity.confidence,
  };
}

function buildDraftFromScanBundle(
  bundle: ScanBundleV1,
  label: string,
  inputKind: "scan-bundle" | "editor-seed",
): ImportSourcePackageDraft {
  const now = new Date().toISOString();
  const nodes = bundle.sections.map((section) => ({
    key: section.id,
    parentKey: null as string | null,
    title: section.title,
    orderIndex: section.ordinal,
    kind: "folder" as const,
  }));

  const documents = bundle.sections.map((section) => ({
    key: `doc:${section.id}`,
    nodeKey: section.id,
    title: section.title,
    orderIndex: section.ordinal,
    proseMirrorJson: EMPTY_PROSEMIRROR_DOC,
    plainText: "",
  }));

  const codexEntries = bundle.entities.map(mapEntityToCodexRecord);

  const draft: ImportSourcePackageDraft = {
    schemaVersion: IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION,
    identity: {
      sourceSetId: `scan:${bundle.source.fingerprint}`,
      fingerprint: bundle.source.fingerprint,
      hints: {
        adapterId: DESCRIPTOR.id,
        adapterVersion: DESCRIPTOR.version,
        originalFormat: inputKind,
        titleHint: bundle.source.title,
        languageHint: bundle.source.language,
      },
    },
    manifest: {
      entries: [{ kind: inputKind, label }],
    },
    nodes,
    documents,
    structure: {
      codexEntries,
      snippets: [],
    },
    diagnostics: [],
    createdAt: now,
  };

  return draft;
}

function parseScanInput(input: ImportAdapterParseInput): ImportSourcePackageDraft | null {
  if (input.kind === "editor-seed" && isEditorSeed(input.data)) {
    return buildDraftFromScanBundle(input.data.bundle, input.label, "editor-seed");
  }
  if (input.kind === "scan-bundle" && isScanBundle(input.data)) {
    return buildDraftFromScanBundle(input.data, input.label, "scan-bundle");
  }
  if (isEditorSeed(input.data)) {
    return buildDraftFromScanBundle(input.data.bundle, input.label, "editor-seed");
  }
  if (isScanBundle(input.data)) {
    return buildDraftFromScanBundle(input.data, input.label, "scan-bundle");
  }
  return null;
}

export const scanImportAdapter: ImportAdapter = {
  descriptor: DESCRIPTOR,
  parse(input) {
    const draft = parseScanInput(input);
    if (!draft) {
      return {
        ok: false,
        diagnostics: [
          importDiagnostic(
            "error",
            "unsupported-input",
            "Expected ScanBundleV1 or EditorSeedV1 input",
          ),
        ],
      };
    }

    const validationDiagnostics = validateImportSourcePackageDraft(draft);
    const diagnostics = [...draft.diagnostics, ...validationDiagnostics];
    return {
      ok: diagnostics.every((d) => d.severity !== "error"),
      draft: { ...draft, diagnostics },
      diagnostics,
    };
  },
};

export function fingerprintScanBundle(bundle: ScanBundleV1): string {
  return sha256Hex(JSON.stringify({ fingerprint: bundle.source.fingerprint }));
}
