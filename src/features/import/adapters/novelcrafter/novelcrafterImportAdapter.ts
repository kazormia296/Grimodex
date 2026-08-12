import type { ImportAdapter, ImportAdapterParseInput } from "../adapterTypes";
import type { ImportSourcePackageDraft } from "../../core/importSourcePackage";
import { IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION } from "../../core/importSourcePackage";
import { EMPTY_PROSEMIRROR_DOC } from "../../core/importSourceDocument";
import type { ImportSourceDocument } from "../../core/importSourceDocument";
import type { ImportSourceNode } from "../../core/importSourceNode";
import { importDiagnostic } from "../../core/importDiagnostics";
import type { ParsedChapter } from "../../importTypes";
import { chaptersToImportedNodes } from "../../importTypes";
import type { ParseResult } from "../../novelcrafterParser";
import { validateImportSourcePackageDraft } from "../adapterValidation";
import { sha256Hex } from "@grimodex/scan-contract";

const DESCRIPTOR = {
  id: "novelcrafter",
  version: "1",
  label: "Novelcrafter",
  inputKinds: ["zip", "unknown"] as const,
  capabilities: {
    supportsStructure: true,
    supportsCodex: true,
    supportsSnippets: true,
    supportsReimport: false,
  },
} as const;

export interface ParsedNovelcrafterLike {
  readonly projectTitle: string;
  readonly chapters: readonly ParsedChapter[];
  readonly codexEntries?: ParseResult["codexEntries"];
  readonly snippets?: ParseResult["snippets"];
}

function isParsedNovelcrafterLike(value: unknown): value is ParsedNovelcrafterLike {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.projectTitle === "string" && Array.isArray(record.chapters);
}

function buildDraftFromParsed(parsed: ParsedNovelcrafterLike, label: string): ImportSourcePackageDraft {
  const now = new Date().toISOString();
  const importedNodes = chaptersToImportedNodes([...parsed.chapters]);
  const fingerprint = sha256Hex(
    JSON.stringify({
      title: parsed.projectTitle,
      chapterCount: parsed.chapters.length,
    }),
  );

  const nodes: ImportSourceNode[] = [];
  const documents: ImportSourceDocument[] = [];

  function walk(
    items: ReturnType<typeof chaptersToImportedNodes>,
    parentKey: string | null,
  ): void {
    items.forEach((item, index) => {
      if (item.kind === "folder") {
        nodes.push({
          key: item.id,
          parentKey,
          title: item.title,
          orderIndex: index,
          kind: "folder",
        });
        walk(item.children, item.id);
        return;
      }
      nodes.push({
        key: item.id,
        parentKey,
        title: item.title,
        orderIndex: index,
        kind: "scene",
      });
      documents.push({
        key: `doc:${item.id}`,
        nodeKey: item.id,
        title: item.title,
        orderIndex: index,
        proseMirrorJson: item.bodyProseMirror ?? EMPTY_PROSEMIRROR_DOC,
        plainText: item.body ?? item.bodyMarkdown ?? "",
      });
    });
  }

  walk(importedNodes, null);

  const codexEntries =
    parsed.codexEntries?.map((entry) => ({
      id: entry.id,
      origin: "source-native" as const,
      kind: "codex-entry" as const,
      sourceKey: entry.ncId,
      name: entry.name,
      entryType: entry.type,
      aliases: entry.aliases,
      summary: entry.summary,
      parentRecordId: entry.parentId,
    })) ?? [];

  const snippets =
    parsed.snippets?.map((snippet) => ({
      id: snippet.id,
      origin: "source-native" as const,
      kind: "snippet" as const,
      sourceKey: snippet.ncId,
      title: snippet.title,
      content: snippet.content,
    })) ?? [];

  return {
    schemaVersion: IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION,
    identity: {
      sourceSetId: `novelcrafter:${fingerprint}`,
      fingerprint,
      hints: {
        adapterId: DESCRIPTOR.id,
        adapterVersion: DESCRIPTOR.version,
        originalFormat: "novelcrafter-zip",
        titleHint: parsed.projectTitle,
      },
    },
    manifest: {
      entries: [{ kind: "zip", label }],
    },
    nodes,
    documents,
    structure: { codexEntries, snippets },
    diagnostics: [],
    createdAt: now,
  };
}

export const novelcrafterImportAdapter: ImportAdapter = {
  descriptor: DESCRIPTOR,
  parse(input: ImportAdapterParseInput) {
    if (!isParsedNovelcrafterLike(input.data)) {
      return {
        ok: false,
        diagnostics: [
          importDiagnostic(
            "error",
            "unsupported-input",
            "Expected ParsedNovelcrafter-like parsed export data",
          ),
        ],
      };
    }

    const draft = buildDraftFromParsed(input.data, input.label);
    const validationDiagnostics = validateImportSourcePackageDraft(draft);
    const diagnostics = [...draft.diagnostics, ...validationDiagnostics];
    return {
      ok: diagnostics.every((d) => d.severity !== "error"),
      draft: { ...draft, diagnostics },
      diagnostics,
    };
  },
};
