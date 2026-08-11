import type { ImportAdapter, ImportAdapterParseInput } from "../adapterTypes";
import type { ImportSourcePackageDraft } from "../../core/importSourcePackage";
import { IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION } from "../../core/importSourcePackage";
import { EMPTY_PROSEMIRROR_DOC } from "../../core/importSourceDocument";
import { importDiagnostic } from "../../core/importDiagnostics";
import { sha256Hex } from "@grimodex/scan-contract";
import { validateImportSourcePackageDraft } from "../adapterValidation";

const DESCRIPTOR = {
  id: "markdown",
  version: "1",
  label: "Markdown",
  inputKinds: ["markdown", "plain-text", "file"] as const,
  capabilities: {
    supportsStructure: true,
    supportsCodex: false,
    supportsSnippets: false,
    supportsReimport: false,
  },
} as const;

interface MarkdownLikeInput {
  readonly title?: string;
  readonly text?: string;
}

function isMarkdownLikeInput(value: unknown): value is MarkdownLikeInput {
  return !!value && typeof value === "object";
}

function normalizePlainMarkdown(
  input: ImportAdapterParseInput,
): MarkdownLikeInput | null {
  if (!isMarkdownLikeInput(input.data)) return null;
  if (typeof input.data.text === "string") return input.data;
  if (typeof input.data === "string") return { text: input.data };
  return { title: input.label, text: "" };
}

function buildEmptyDocDraft(
  parsed: MarkdownLikeInput,
  input: ImportAdapterParseInput,
): ImportSourcePackageDraft {
  const now = new Date().toISOString();
  const title = parsed.title?.trim() || input.label || "Imported";
  const plainText = parsed.text ?? "";
  const nodeKey = "root-scene";
  const fingerprint = sha256Hex(
    JSON.stringify({ title, length: plainText.length }),
  );

  const draft: ImportSourcePackageDraft = {
    schemaVersion: IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION,
    identity: {
      sourceSetId: `markdown:${fingerprint}`,
      fingerprint,
      hints: {
        adapterId: DESCRIPTOR.id,
        adapterVersion: DESCRIPTOR.version,
        originalFormat: input.kind,
        titleHint: title,
      },
    },
    manifest: {
      entries: [{ kind: input.kind, label: input.label }],
    },
    nodes: [
      {
        key: nodeKey,
        parentKey: null,
        title,
        orderIndex: 0,
        kind: "scene",
      },
    ],
    documents: [
      {
        key: `doc:${nodeKey}`,
        nodeKey,
        title,
        orderIndex: 0,
        proseMirrorJson: EMPTY_PROSEMIRROR_DOC,
        plainText,
      },
    ],
    structure: {
      codexEntries: [],
      snippets: [],
    },
    diagnostics: [],
    createdAt: now,
  };

  return draft;
}

export const markdownImportAdapter: ImportAdapter = {
  descriptor: DESCRIPTOR,
  parse(input: ImportAdapterParseInput) {
    const parsed = normalizePlainMarkdown(input);
    if (!parsed) {
      return {
        ok: false,
        diagnostics: [
          importDiagnostic(
            "error",
            "unsupported-input",
            "Expected markdown/plain-text input",
          ),
        ],
      };
    }

    const draft = buildEmptyDocDraft(parsed, input);
    const validationDiagnostics = validateImportSourcePackageDraft(draft);
    const diagnostics = [...draft.diagnostics, ...validationDiagnostics];
    return {
      ok: diagnostics.every((d) => d.severity !== "error"),
      draft: { ...draft, diagnostics },
      diagnostics,
    };
  },
};
