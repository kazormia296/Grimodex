/** 保存済みの metadata（JSON のオブジェクト）を読む。読めなければ空。 */
export function parseMetadataRecord(
  raw: string | null | undefined,
): Record<string, unknown> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
