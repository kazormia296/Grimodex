export interface NativeMutationMetadata {
  maintenanceTransactionId: string;
}

const NATIVE_MUTATION_METADATA = Symbol("grimodex.nativeMutationMetadata");

type MetadataCarrier = {
  [NATIVE_MUTATION_METADATA]?: NativeMutationMetadata;
};

/**
 * Keep Native-only lineage outside enumerable domain rows. History replay can
 * still name the root maintenance transaction without leaking transport
 * metadata into snapshots, optimistic copies, or renderer persistence.
 */
export function attachNativeMutationMetadata<T extends object>(
  normalized: T,
  raw: unknown,
): T {
  const transactionId =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>).maintenanceTransactionId
      : undefined;
  if (typeof transactionId !== "string" || transactionId.length === 0) {
    return normalized;
  }
  Object.defineProperty(normalized, NATIVE_MUTATION_METADATA, {
    value: { maintenanceTransactionId: transactionId },
    enumerable: false,
  });
  return normalized;
}

export function getNativeMutationMetadata(
  value: object,
): NativeMutationMetadata | undefined {
  return (value as MetadataCarrier)[NATIVE_MUTATION_METADATA];
}
