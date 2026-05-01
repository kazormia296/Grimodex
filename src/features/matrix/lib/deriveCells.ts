export type CellSource = "body" | "beat" | "relation";

const SOURCE_PRIORITY: Record<CellSource, number> = {
  body: 2,
  beat: 1,
  relation: 0,
};

interface MentionRow {
  sceneId: string;
  codexEntryId: string;
  source: CellSource;
}

/**
 * Build a map of "sceneId::codexEntryId" → strongest CellSource.
 * Multiple rows for the same pair (different source values) are collapsed to
 * the highest-priority source: body > beat > relation.
 */
export function deriveCellMap(mentions: MentionRow[]): Map<string, CellSource> {
  const map = new Map<string, CellSource>();

  for (const row of mentions) {
    const key = `${row.sceneId}::${row.codexEntryId}`;
    const existing = map.get(key);
    if (
      existing === undefined ||
      SOURCE_PRIORITY[row.source] > SOURCE_PRIORITY[existing]
    ) {
      map.set(key, row.source);
    }
  }

  return map;
}
