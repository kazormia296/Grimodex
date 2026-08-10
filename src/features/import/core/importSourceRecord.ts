/** Where imported structure metadata originated. */
export type ImportStructureOrigin =
  | "source-native"
  | "external-analysis"
  | "derived";

export interface ImportSourceRecordBase {
  readonly id: string;
  readonly origin: ImportStructureOrigin;
  readonly kind: string;
  readonly sourceKey?: string;
}

export interface ImportCodexEntryRecord extends ImportSourceRecordBase {
  readonly kind: "codex-entry";
  readonly name: string;
  readonly entryType: string;
  readonly aliases: readonly string[];
  readonly summary?: string;
  readonly parentRecordId?: string;
  readonly confidence?: number;
}

export interface ImportSnippetRecord extends ImportSourceRecordBase {
  readonly kind: "snippet";
  readonly title: string;
  readonly content: string;
}

export type ImportSourceRecord = ImportCodexEntryRecord | ImportSnippetRecord;
