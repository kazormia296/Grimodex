export interface CreateResultMetadata {
  replayed: boolean;
  entityPresent: boolean;
}

const CREATE_RESULT_METADATA = Symbol("grimodex.createResultMetadata");

type MetadataCarrier = {
  [CREATE_RESULT_METADATA]?: CreateResultMetadata;
};

/**
 * Native create commands return their historical row plus a reserved metadata
 * object. Keep it non-enumerable on normalized domain rows so persistence,
 * history snapshots, and UI spreads retain the pre-existing row shape.
 */
export function attachCreateResultMetadata<T extends object>(
  normalized: T,
  raw: unknown,
): T {
  const candidate =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).__idempotency
      : undefined;
  if (!candidate || typeof candidate !== "object") return normalized;
  const metadata = candidate as Record<string, unknown>;
  if (
    typeof metadata.replayed !== "boolean" ||
    typeof metadata.entityPresent !== "boolean"
  ) {
    return normalized;
  }
  Object.defineProperty(normalized, CREATE_RESULT_METADATA, {
    value: {
      replayed: metadata.replayed,
      entityPresent: metadata.entityPresent,
    } satisfies CreateResultMetadata,
    enumerable: false,
  });
  return normalized;
}

export function getCreateResultMetadata(
  value: object,
): CreateResultMetadata | undefined {
  return (value as MetadataCarrier)[CREATE_RESULT_METADATA];
}

/** Missing metadata is the legacy/browser success shape and means present. */
export function isCreateResultEntityPresent(value: object): boolean {
  return getCreateResultMetadata(value)?.entityPresent !== false;
}
