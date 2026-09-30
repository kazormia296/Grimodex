export type GenericSchemaFieldType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "record-ref";

export interface GenericSchemaFieldDef {
  readonly fieldId: string;
  readonly label: string;
  readonly type: GenericSchemaFieldType;
  readonly required?: boolean;
  readonly enumValues?: readonly string[];
  readonly targetColumn?: string;
}

export interface GenericSchemaRecordDef {
  readonly recordId: string;
  readonly label: string;
  readonly fields: readonly GenericSchemaFieldDef[];
  readonly nestedRecords?: readonly GenericSchemaRecordDef[];
}

export interface GenericExtractionSchema {
  readonly schemaId: string;
  readonly version: number;
  readonly label: string;
  readonly records: readonly GenericSchemaRecordDef[];
}

export interface GenericSchemaTargetMapping {
  readonly recordId: string;
  readonly targetKind: "codex-entry" | "snippet" | "metadata";
  readonly fieldMappings: Readonly<Record<string, string>>;
}

export const GENERIC_SCHEMA_LIMITS = {
  maxRecords: 16,
  maxFields: 64,
  maxDepth: 2,
} as const;

export const GENERIC_SCHEMA_FIELD_TYPES: readonly GenericSchemaFieldType[] = [
  "string",
  "number",
  "boolean",
  "enum",
  "record-ref",
];
