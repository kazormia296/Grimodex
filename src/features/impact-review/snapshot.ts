/**
 * impact-review: Codex エントリの現在状態を CodexSnapshot へ取り出す。
 * MVP では base 状態（phase 未解決）で比較する。phase 別 impact は将来拡張。
 */

import { db } from "@/db/client";
import {
  codexEntries,
  codexDetailValues,
  codexDetailDefinitions,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { detailValueToPlainText } from "@/features/codex/detailCleanup";
import { parseAliases } from "@/features/codex/codexMatcher";
import type { CodexSnapshot } from "./diff";

export interface CodexSnapshotResult {
  snapshot: CodexSnapshot;
  projectId: string;
  entryType: string;
  entryName: string;
}

/** エントリ 1 件の base 状態スナップショットを構築。存在しなければ null。 */
export async function buildCodexSnapshot(
  entryId: string,
): Promise<CodexSnapshotResult | null> {
  const rows = await db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.id, entryId));
  const entry = rows[0];
  if (!entry) return null;

  // includeInContext=1 の detail のみ（chat/consistency と同じ選定）
  const rawDetails = await db
    .select({
      value: codexDetailValues.value,
      name: codexDetailDefinitions.name,
    })
    .from(codexDetailValues)
    .innerJoin(
      codexDetailDefinitions,
      and(
        eq(codexDetailValues.definitionId, codexDetailDefinitions.id),
        eq(codexDetailDefinitions.includeInContext, 1),
      ),
    )
    .where(inArray(codexDetailValues.entryId, [entryId]));

  const details = rawDetails
    .map((d) => ({ name: d.name, value: detailValueToPlainText(d.value) }))
    .filter((d) => d.value.trim() !== "");

  const snapshot: CodexSnapshot = {
    name: entry.name,
    aliases: parseAliases(entry.aliases),
    summary: entry.summary ?? "",
    contentPlain: extractPlainText(entry.content ?? ""),
    details,
  };

  return {
    snapshot,
    projectId: entry.projectId,
    entryType: entry.type,
    entryName: entry.name,
  };
}
