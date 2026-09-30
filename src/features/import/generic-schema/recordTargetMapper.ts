import type {
  ImportCodexEntryRecord,
  ImportSnippetRecord,
} from "../core/importSourceRecord";
import type { GenericSchemaTargetMapping } from "./schemaTypes";

export interface MappedTableRow {
  readonly rowIndex: number;
  readonly sourceValues: Readonly<Record<string, string>>;
}

export interface RecordTargetMapResult {
  readonly codexEntries: readonly ImportCodexEntryRecord[];
  readonly snippets: readonly ImportSnippetRecord[];
}

/**
 * Deterministically map table rows when source-authored mapping is provided.
 */
export function mapTableRowsToTargets(input: {
  readonly mapping: GenericSchemaTargetMapping;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly sourceKey: string;
}): RecordTargetMapResult {
  const codexEntries: ImportCodexEntryRecord[] = [];
  const snippets: ImportSnippetRecord[] = [];

  input.rows.forEach((row, rowIndex) => {
    const sourceValues: Record<string, string> = {};
    input.headers.forEach((header, colIndex) => {
      sourceValues[header] = row[colIndex] ?? "";
    });

    const mapped: Record<string, string> = {};
    for (const [fieldId, columnName] of Object.entries(
      input.mapping.fieldMappings,
    )) {
      mapped[fieldId] = sourceValues[columnName] ?? "";
    }

    if (input.mapping.targetKind === "codex-entry") {
      codexEntries.push({
        id: `${input.mapping.recordId}:${input.sourceKey}:${rowIndex}`,
        kind: "codex-entry",
        origin: "source-native",
        name: mapped.name ?? mapped.title ?? `Row ${rowIndex + 1}`,
        entryType: mapped.type ?? mapped.entryType ?? "unknown",
        aliases: [],
        summary: mapped.summary,
        sourceKey: input.sourceKey,
      });
    }

    if (input.mapping.targetKind === "snippet") {
      snippets.push({
        id: `${input.mapping.recordId}:${input.sourceKey}:${rowIndex}`,
        kind: "snippet",
        origin: "source-native",
        title: mapped.title ?? mapped.name ?? `Snippet ${rowIndex + 1}`,
        content: mapped.content ?? mapped.body ?? "",
        sourceKey: input.sourceKey,
      });
    }
  });

  return { codexEntries, snippets };
}

export function mapTableRowsFromMappings(input: {
  readonly mappings: readonly GenericSchemaTargetMapping[];
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly sourceKey: string;
}): RecordTargetMapResult {
  const codexEntries: ImportCodexEntryRecord[] = [];
  const snippets: ImportSnippetRecord[] = [];

  for (const mapping of input.mappings) {
    const result = mapTableRowsToTargets({
      mapping,
      headers: input.headers,
      rows: input.rows,
      sourceKey: input.sourceKey,
    });
    codexEntries.push(...result.codexEntries);
    snippets.push(...result.snippets);
  }

  return { codexEntries, snippets };
}
