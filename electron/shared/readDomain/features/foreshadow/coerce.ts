/**
 * The value coercions the foreshadow row normalizers share (Mastra migration
 * MP-4b PR-5b). They were private copies in `normalizeForeshadowRow.ts` and in
 * the renderer's `foreshadow/api.ts`; the bodies are unchanged.
 *
 * A time arrives as a `Date` (Drizzle), an epoch-millisecond number (Native) or
 * an ISO string; a boolean as a boolean (Drizzle) or the integer 0/1 (Native).
 */

export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") return new Date(value);
  return new Date(0);
}

export function toNullableDate(value: unknown): Date | null {
  if (value == null) return null;
  return toDate(value);
}

export function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return false;
}
