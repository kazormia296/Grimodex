export const D1_MAX_BOUND_PARAMETERS = 100;

/** Split values so a prepared D1 statement stays within its binding limit. */
export function chunkD1Bindings<T>(
  values: readonly T[],
  fixedParameterCount = 0,
): T[][] {
  if (
    !Number.isSafeInteger(fixedParameterCount) ||
    fixedParameterCount < 0 ||
    fixedParameterCount >= D1_MAX_BOUND_PARAMETERS
  ) {
    throw new RangeError("invalid fixed D1 parameter count");
  }
  const chunkSize = D1_MAX_BOUND_PARAMETERS - fixedParameterCount;
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}
