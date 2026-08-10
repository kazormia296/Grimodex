import { importDiagnostic } from "../core/importDiagnostics";
import type { ImportDiagnostic } from "../core/importDiagnostics";
import type {
  GenericExtractionSchema,
  GenericSchemaFieldDef,
  GenericSchemaRecordDef,
} from "./schemaTypes";
import {
  GENERIC_SCHEMA_FIELD_TYPES,
  GENERIC_SCHEMA_LIMITS,
} from "./schemaTypes";

export interface SchemaValidationResult {
  readonly ok: boolean;
  readonly diagnostics: readonly ImportDiagnostic[];
}

function countFields(
  record: GenericSchemaRecordDef,
  seenRecordIds: Set<string> = new Set(),
): number {
  if (seenRecordIds.has(record.recordId)) return 0;
  seenRecordIds.add(record.recordId);
  let total = record.fields.length;
  for (const nested of record.nestedRecords ?? []) {
    total += countFields(nested, seenRecordIds);
  }
  return total;
}

function validateField(
  field: GenericSchemaFieldDef,
  path: string,
): readonly ImportDiagnostic[] {
  const diagnostics: ImportDiagnostic[] = [];
  if (!GENERIC_SCHEMA_FIELD_TYPES.includes(field.type)) {
    diagnostics.push(
      importDiagnostic(
        "error",
        "schema-unknown-field-type",
        `Unknown field type: ${field.type}`,
        path,
      ),
    );
  }
  if (field.type === "enum" && (!field.enumValues || field.enumValues.length === 0)) {
    diagnostics.push(
      importDiagnostic(
        "error",
        "schema-enum-empty",
        "Enum field requires enumValues",
        path,
      ),
    );
  }
  return diagnostics;
}

function validateRecord(
  record: GenericSchemaRecordDef,
  depth: number,
  seenRecordIds: Set<string>,
): readonly ImportDiagnostic[] {
  const diagnostics: ImportDiagnostic[] = [];
  const path = record.recordId;

  if (seenRecordIds.has(record.recordId)) {
    diagnostics.push(
      importDiagnostic(
        "error",
        "schema-recursive-record",
        `Recursive record reference: ${record.recordId}`,
        path,
      ),
    );
    return diagnostics;
  }

  if (depth > GENERIC_SCHEMA_LIMITS.maxDepth) {
    diagnostics.push(
      importDiagnostic(
        "error",
        "schema-depth-exceeded",
        `Schema depth exceeds ${GENERIC_SCHEMA_LIMITS.maxDepth}`,
        path,
      ),
    );
    return diagnostics;
  }

  seenRecordIds.add(record.recordId);

  for (const field of record.fields) {
    diagnostics.push(...validateField(field, `${path}.${field.fieldId}`));
  }

  for (const nested of record.nestedRecords ?? []) {
    diagnostics.push(...validateRecord(nested, depth + 1, new Set(seenRecordIds)));
  }

  seenRecordIds.delete(record.recordId);
  return diagnostics;
}

export function validateGenericExtractionSchema(
  schema: GenericExtractionSchema,
): SchemaValidationResult {
  const diagnostics: ImportDiagnostic[] = [];

  if (schema.records.length > GENERIC_SCHEMA_LIMITS.maxRecords) {
    diagnostics.push(
      importDiagnostic(
        "error",
        "schema-too-many-records",
        `Schema exceeds ${GENERIC_SCHEMA_LIMITS.maxRecords} records`,
      ),
    );
  }

  const totalFields = schema.records.reduce(
    (sum, record) => sum + countFields(record),
    0,
  );
  if (totalFields > GENERIC_SCHEMA_LIMITS.maxFields) {
    diagnostics.push(
      importDiagnostic(
        "error",
        "schema-too-many-fields",
        `Schema exceeds ${GENERIC_SCHEMA_LIMITS.maxFields} fields`,
      ),
    );
  }

  for (const record of schema.records) {
    diagnostics.push(...validateRecord(record, 1, new Set()));
  }

  return {
    ok: diagnostics.every((d) => d.severity !== "error"),
    diagnostics,
  };
}
