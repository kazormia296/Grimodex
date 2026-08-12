/** Prefer specialized adapters over generic unless explicitly forced. */
export const SPECIALIZED_IMPORT_ADAPTER_IDS = [
  "novelcrafter",
  "scan",
  "kakuyomu",
  "markdown",
] as const;

export type SpecializedImportAdapterId =
  (typeof SPECIALIZED_IMPORT_ADAPTER_IDS)[number];

export function isSpecializedImportAdapter(adapterId: string): boolean {
  return (SPECIALIZED_IMPORT_ADAPTER_IDS as readonly string[]).includes(
    adapterId,
  );
}

export function resolvePreferredImportAdapterId(input: {
  readonly detectedAdapterId?: string;
  readonly forceGeneric?: boolean;
}): string {
  if (input.forceGeneric) return "generic";
  if (
    input.detectedAdapterId &&
    isSpecializedImportAdapter(input.detectedAdapterId)
  ) {
    return input.detectedAdapterId;
  }
  return input.detectedAdapterId ?? "generic";
}

export function shouldUseGenericImportAdapter(input: {
  readonly detectedAdapterId?: string;
  readonly forceGeneric?: boolean;
}): boolean {
  return resolvePreferredImportAdapterId(input) === "generic";
}
