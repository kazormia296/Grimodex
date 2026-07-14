export type CellSource = "semantic" | "body" | "beat" | "relation";
export type MentionRole = "mentioned" | "actor" | "target";

export const SOURCE_PRIORITY: Record<CellSource, number> = {
  semantic: 3,
  body: 2,
  beat: 1,
  relation: 0,
};

export const ROLE_PRIORITY: Record<MentionRole, number> = {
  actor: 2,
  target: 1,
  mentioned: 0,
};

export interface CellInfo {
  /** All sources present for this (scene, codex) pair */
  sources: Set<CellSource>;
  /** Strongest source: semantic > body > beat > relation */
  topSource: CellSource;
  /** Best role from source='beat' row: actor > target > mentioned */
  role: MentionRole;
}

interface MentionRow {
  sceneId: string;
  codexEntryId: string;
  source: CellSource;
  role?: string | null;
}

/**
 * Build a map of "sceneId::codexEntryId" → CellInfo.
 * Multiple rows for the same pair are collapsed:
 *   - topSource: semantic > body > beat > relation
 *   - sources: union of all present source values
 *   - role: strongest role from source='beat' rows (actor > target > mentioned)
 */
export function deriveCellMap(mentions: MentionRow[]): Map<string, CellInfo> {
  const map = new Map<string, CellInfo>();

  for (const row of mentions) {
    const key = `${row.sceneId}::${row.codexEntryId}`;
    const existing = map.get(key);

    const rowRole = (row.role as MentionRole | null | undefined) ?? "mentioned";

    if (!existing) {
      map.set(key, {
        sources: new Set([row.source]),
        topSource: row.source,
        role: row.source === "beat" ? rowRole : "mentioned",
      });
    } else {
      existing.sources.add(row.source);
      if (SOURCE_PRIORITY[row.source] > SOURCE_PRIORITY[existing.topSource]) {
        existing.topSource = row.source;
      }
      if (
        row.source === "beat" &&
        ROLE_PRIORITY[rowRole] > ROLE_PRIORITY[existing.role]
      ) {
        existing.role = rowRole;
      }
    }
  }

  return map;
}
