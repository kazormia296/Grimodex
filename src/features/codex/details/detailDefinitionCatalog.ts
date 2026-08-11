export const DETAIL_FIELD_TYPES = Object.freeze([
  "text",
  "dropdown",
  "codex_reference",
] as const);

export type DetailFieldType = (typeof DETAIL_FIELD_TYPES)[number];

export interface DetailDefinitionCatalogInput {
  readonly id: string;
  readonly projectId: string;
  readonly typeSlug: string;
  readonly name: string;
  readonly fieldType: string;
  readonly fieldConfig: string | null;
  readonly sortOrder: number;
}

export interface DetailDefinitionCatalogOption {
  readonly optionRef: string;
  readonly label: string;
}

interface DetailDefinitionCatalogRecordBase {
  readonly definitionRef: string;
  readonly name: string;
}

export interface TextDetailDefinitionCatalogRecord extends DetailDefinitionCatalogRecordBase {
  readonly fieldType: "text";
}

export interface DropdownDetailDefinitionCatalogRecord extends DetailDefinitionCatalogRecordBase {
  readonly fieldType: "dropdown";
  readonly options: readonly DetailDefinitionCatalogOption[];
}

export interface ReferenceDetailDefinitionCatalogRecord extends DetailDefinitionCatalogRecordBase {
  readonly fieldType: "codex_reference";
}

export type DetailDefinitionCatalogRecord =
  | TextDetailDefinitionCatalogRecord
  | DropdownDetailDefinitionCatalogRecord
  | ReferenceDetailDefinitionCatalogRecord;

export type DetailDefinitionCatalogErrorCode =
  | "unsupported-field-type"
  | "invalid-field-config"
  | "invalid-dropdown-options"
  | "duplicate-dropdown-option"
  | "duplicate-definition-id"
  | "mixed-project"
  | "mixed-type"
  | "invalid-sort-order";

export class DetailDefinitionCatalogError extends Error {
  readonly code: DetailDefinitionCatalogErrorCode;

  constructor(code: DetailDefinitionCatalogErrorCode, message: string) {
    super(message);
    this.name = "DetailDefinitionCatalogError";
    this.code = code;
  }
}

export interface DetailDefinitionCatalog {
  /** Internal authority only; never serialized into model-safe records. */
  readonly projectId: string | null;
  /** Internal Codex type boundary; never serialized into model-safe records. */
  readonly typeSlug: string | null;
  readonly records: readonly DetailDefinitionCatalogRecord[];
  recordByRef(definitionRef: string): DetailDefinitionCatalogRecord | undefined;
  definitionRefForId(definitionId: string): string | undefined;
  definitionIdForRef(definitionRef: string): string | undefined;
  optionByRef(
    definitionRef: string,
    optionRef: string,
  ): DetailDefinitionCatalogOption | undefined;
}

function opaqueRef(prefix: "D" | "O", index: number): string {
  return `${prefix}${String(index + 1).padStart(3, "0")}`;
}

function compareOpaqueSourceKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseDropdownOptions(
  input: DetailDefinitionCatalogInput,
): readonly DetailDefinitionCatalogOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.fieldConfig ?? "");
  } catch {
    throw new DetailDefinitionCatalogError(
      "invalid-field-config",
      `Dropdown Definition ${input.id} has invalid fieldConfig JSON`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("options" in parsed) ||
    !Array.isArray(parsed.options) ||
    parsed.options.length === 0 ||
    parsed.options.some(
      (option) =>
        typeof option !== "string" ||
        option.length === 0 ||
        option.trim() !== option,
    )
  ) {
    throw new DetailDefinitionCatalogError(
      "invalid-dropdown-options",
      `Dropdown Definition ${input.id} must have non-empty string options`,
    );
  }

  const labels = parsed.options as string[];
  if (new Set(labels).size !== labels.length) {
    throw new DetailDefinitionCatalogError(
      "duplicate-dropdown-option",
      `Dropdown Definition ${input.id} contains duplicate options`,
    );
  }

  return Object.freeze(
    labels.map((label, index) =>
      Object.freeze({
        optionRef: opaqueRef("O", index),
        label,
      }),
    ),
  );
}

function toCatalogRecord(
  input: DetailDefinitionCatalogInput,
  definitionRef: string,
): DetailDefinitionCatalogRecord {
  switch (input.fieldType) {
    case "text":
      return Object.freeze({
        definitionRef,
        name: input.name,
        fieldType: "text" as const,
      });
    case "dropdown":
      return Object.freeze({
        definitionRef,
        name: input.name,
        fieldType: "dropdown" as const,
        options: parseDropdownOptions(input),
      });
    case "codex_reference":
      return Object.freeze({
        definitionRef,
        name: input.name,
        fieldType: "codex_reference" as const,
      });
    default:
      throw new DetailDefinitionCatalogError(
        "unsupported-field-type",
        `Unsupported Detail field type: ${input.fieldType}`,
      );
  }
}

export function buildDetailDefinitionCatalog(
  definitions: readonly DetailDefinitionCatalogInput[],
): DetailDefinitionCatalog {
  const definitionIds = new Set<string>();
  const projectId = definitions[0]?.projectId ?? null;
  const typeSlug = definitions[0]?.typeSlug ?? null;
  for (const definition of definitions) {
    if (definition.projectId !== projectId) {
      throw new DetailDefinitionCatalogError(
        "mixed-project",
        "A Detail Definition catalog cannot mix Project authorities",
      );
    }
    if (definition.typeSlug !== typeSlug) {
      throw new DetailDefinitionCatalogError(
        "mixed-type",
        "A Detail Definition catalog cannot mix Codex types",
      );
    }
    if (definitionIds.has(definition.id)) {
      throw new DetailDefinitionCatalogError(
        "duplicate-definition-id",
        `Duplicate Detail Definition id: ${definition.id}`,
      );
    }
    if (!Number.isFinite(definition.sortOrder)) {
      throw new DetailDefinitionCatalogError(
        "invalid-sort-order",
        `Detail Definition ${definition.id} has an invalid sortOrder`,
      );
    }
    definitionIds.add(definition.id);
  }

  const sorted = [...definitions].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder ||
      compareOpaqueSourceKey(left.id, right.id),
  );
  const recordByRefMap = new Map<string, DetailDefinitionCatalogRecord>();
  const refById = new Map<string, string>();
  const idByRef = new Map<string, string>();

  const records = Object.freeze(
    sorted.map((definition, index) => {
      const definitionRef = opaqueRef("D", index);
      const record = toCatalogRecord(definition, definitionRef);
      recordByRefMap.set(definitionRef, record);
      refById.set(definition.id, definitionRef);
      idByRef.set(definitionRef, definition.id);
      return record;
    }),
  );

  const catalog = {
    records,
    recordByRef: (definitionRef: string) => recordByRefMap.get(definitionRef),
    definitionRefForId: (definitionId: string) => refById.get(definitionId),
    definitionIdForRef: (definitionRef: string) => idByRef.get(definitionRef),
    optionByRef: (definitionRef: string, optionRef: string) => {
      const record = recordByRefMap.get(definitionRef);
      return record?.fieldType === "dropdown"
        ? record.options.find((option) => option.optionRef === optionRef)
        : undefined;
    },
  } as Omit<DetailDefinitionCatalog, "projectId" | "typeSlug"> &
    Partial<Pick<DetailDefinitionCatalog, "projectId" | "typeSlug">>;
  Object.defineProperties(catalog, {
    projectId: { value: projectId, enumerable: false },
    typeSlug: { value: typeSlug, enumerable: false },
  });
  return Object.freeze(catalog) as DetailDefinitionCatalog;
}
