export function parseChangePayload(
  payload: string,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function payloadString(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function payloadStringArray(
  payload: Record<string, unknown> | null,
  key: string,
): string[] {
  const value = payload?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}
