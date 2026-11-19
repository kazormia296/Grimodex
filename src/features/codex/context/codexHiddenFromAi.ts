import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { codexEntries } from "@/db/schema";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { listPhasesByEntryIds } from "../phaseApi";
import { usePhaseStore } from "../phaseStore";
import { isCodexContextModeHiddenFromAi } from "./codexVisibilityPolicy";
import { resolveCodexContexts } from "./resolvedCodexContext";
import type { TemporalAnchor } from "./sceneTimeIndex";

/**
 * 作者が hidden（AI に秘匿）と印した Codex の id を返す。
 *
 * 契機を持たない AI 経路（chat の agent tool、beat、インライン AI）が、chat の通常の
 * 文脈と同じ判定で hidden を落とすための共通の入口。判定は chat と同じく、候補を
 * Phase 解決してから `codexVisibilityPolicy` の正本で行う。anchor は
 * `nonSceneContextSource` と同じ規則で、現在の場面があればその場面、なければ base。
 *
 * fail-closed：DB に無い id・不明な mode も hidden に数える。suppress・mentioned・
 * Phase による絞り込みは足さない（全部開示、hidden だけを守る）。
 */
export async function listCodexIdsHiddenFromAi(input: {
  entryIds: readonly string[];
  projectId?: string | null;
  /** 現在の場面。空・未指定なら base で解決する。 */
  sceneId?: string | null;
}): Promise<Set<string>> {
  const ids = [...new Set(input.entryIds)];
  const hidden = new Set<string>();
  if (ids.length === 0) return hidden;

  const rows = await db
    .select({
      id: codexEntries.id,
      summary: codexEntries.summary,
      contextMode: codexEntries.contextMode,
    })
    .from(codexEntries)
    .where(
      input.projectId
        ? and(
            eq(codexEntries.projectId, input.projectId),
            inArray(codexEntries.id, ids),
          )
        : inArray(codexEntries.id, ids),
    );
  const found = new Set<string>();
  const entries = [];
  for (const row of rows) {
    found.add(row.id);
    entries.push({ ...row, content: "" });
  }
  for (const id of ids) if (!found.has(id)) hidden.add(id);
  if (entries.length === 0) return hidden;

  const phases = await listPhasesByEntryIds(entries.map((entry) => entry.id));
  const { sceneTimeIndex, resolutionMode } = usePhaseStore.getState();
  const sceneId = input.sceneId?.trim();
  const anchor: TemporalAnchor = sceneId
    ? { kind: "scene", sceneId }
    : { kind: "base" };
  const { resolvedById } = resolveCodexContexts({
    entries,
    phases,
    anchor,
    sceneTimeIndex,
    resolutionMode,
  });
  for (const entry of entries) {
    const mode = resolvedById.get(entry.id)?.contextMode ?? entry.contextMode;
    if (isCodexContextModeHiddenFromAi(mode)) hidden.add(entry.id);
  }
  return hidden;
}

/** `listCodexIdsHiddenFromAi` で hidden の行を除く。順序は保つ。 */
export async function dropCodexHiddenFromAi<T extends { id: string }>(
  rows: readonly T[],
  options: { projectId?: string | null; sceneId?: string | null } = {},
): Promise<T[]> {
  if (rows.length === 0) return [];
  const hidden = await listCodexIdsHiddenFromAi({
    entryIds: rows.map((row) => row.id),
    ...options,
  });
  return rows.filter((row) => !hidden.has(row.id));
}

/**
 * `ids` から hidden を除いた id を、順序を保って返す。beat・インライン AI のように
 * 検出済みの id の列を持つ経路用。判定に失敗したときは fail-closed で何も渡さない
 * （生成は続けられるが、Codex の要約は付かない）。
 */
export async function visibleCodexIdsForAi(
  ids: readonly string[],
  options: { projectId?: string | null; sceneId?: string | null } = {},
): Promise<string[]> {
  if (ids.length === 0) return [];
  try {
    const hidden = await listCodexIdsHiddenFromAi({
      entryIds: ids,
      ...options,
    });
    return ids.filter((id) => !hidden.has(id));
  } catch (error) {
    debugLog.warn(
      "codex-hidden",
      "hidden 判定に失敗したので Codex の要約を渡さない",
      errorDetail(error),
    );
    return [];
  }
}
