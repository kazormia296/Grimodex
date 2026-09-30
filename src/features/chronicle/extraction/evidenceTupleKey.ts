const NUL = "\u0000";

/**
 * Build a collision-free identity for two Chronicle evidence fields.
 *
 * Keep the historical key spelling for the ordinary domain so existing
 * application-provenance records continue to match. Embedded-NUL tuples use
 * an explicit JSON tuple representation; JSON escapes NUL and preserves the
 * field boundary without relying on a delimiter.
 */
export function chronicleEvidenceTupleKey(left: string, right: string): string {
  if (!left.includes(NUL) && !right.includes(NUL)) {
    return `${left}${NUL}${right}`;
  }
  return `chronicle-evidence-tuple-v2:${JSON.stringify([left, right])}`;
}
