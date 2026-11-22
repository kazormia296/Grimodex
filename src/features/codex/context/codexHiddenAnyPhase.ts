import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { codexEntries } from "@/db/schema";
import { listPhasesByEntryIds } from "../phaseApi";
import { isCodexContextModeHiddenFromAi } from "./codexVisibilityPolicy";
import { listCodexIdsHiddenFromAi } from "./codexHiddenFromAi";

/** 1 回の問い合わせに載せる id の数。 */
const HIDDEN_CHECK_CHUNK = 500;

/**
 * 場面を持たない AI 経路（候補画面の「AI で評価」など）用に、「base が hidden、またはどれかの
 * Phase の override が hidden」の Codex の id を返す。`listCodexIdsHiddenFromAi` を sceneId なしで
 * 呼ぶと base の判定だけになり、Phase でだけ hidden の項目が公開と判定されて漏れる。時点が
 * 決まらない経路では、広く隠す側に倒す。
 *
 * - base の mode が hidden・不明、または DB に無い id（project が合わない id を含む）は hidden。
 * - Phase の `contextModeOverride` が hidden・不明なものを 1 つでも持つ項目は hidden。
 * - `listCodexIdsHiddenFromAi` の結果も足す（正本の判定より狭くならない）。
 *
 * 判定に失敗したら reject する。呼び側は fail-closed で何も送らない。
 */
export async function listCodexIdsHiddenFromAiInAnyPhase(input: {
  entryIds: readonly string[];
  projectId?: string | null;
}): Promise<Set<string>> {
  const ids = [...new Set(input.entryIds)];
  const hidden = new Set<string>();
  // 1 回の問い合わせの bind 変数を抑えるため、id を分けて判定する（どれかが失敗したら reject）。
  for (let i = 0; i < ids.length; i += HIDDEN_CHECK_CHUNK) {
    const chunk = await listHiddenChunk(
      ids.slice(i, i + HIDDEN_CHECK_CHUNK),
      input.projectId,
    );
    for (const id of chunk) hidden.add(id);
  }
  return hidden;
}

async function listHiddenChunk(
  ids: readonly string[],
  projectId: string | null | undefined,
): Promise<Set<string>> {
  const input = { projectId };
  const hidden = new Set<string>();
  if (ids.length === 0) return hidden;

  for (const id of await listCodexIdsHiddenFromAi({
    entryIds: [...ids],
    projectId: input.projectId,
  })) {
    hidden.add(id);
  }

  const rows = await db
    .select({ id: codexEntries.id, contextMode: codexEntries.contextMode })
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
  for (const row of rows) {
    found.add(row.id);
    if (isCodexContextModeHiddenFromAi(row.contextMode)) hidden.add(row.id);
  }
  for (const id of ids) if (!found.has(id)) hidden.add(id);

  const foundIds = [...found];
  if (foundIds.length === 0) return hidden;
  for (const phase of await listPhasesByEntryIds(foundIds)) {
    const mode = phase.contextModeOverride;
    if (mode !== null && isCodexContextModeHiddenFromAi(mode)) {
      hidden.add(phase.entryId);
    }
  }
  return hidden;
}
