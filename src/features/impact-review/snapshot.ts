/**
 * impact-review: Codex エントリの現在状態を CodexSnapshot へ取り出す。
 * MVP では base 状態（phase 未解決）で比較する。phase 別 impact は将来拡張。
 */

import { db } from "@/db/client";
import {
  codexEntries,
  codexDetailValues,
  codexDetailDefinitions,
  codexEntryPhases,
  codexPhaseDetailOverrides,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { detailValueToPlainText } from "@/features/codex/detailCleanup";
import { parseAliases } from "@/features/codex/codexMatcher";
import type { CodexSnapshot, PhaseSnapshot } from "./diff";

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

  const phases = await buildPhaseSnapshots(entryId);

  const snapshot: CodexSnapshot = {
    name: entry.name,
    aliases: parseAliases(entry.aliases),
    summary: entry.summary ?? "",
    contentPlain: extractPlainText(entry.content ?? ""),
    details,
    phases,
  };

  return {
    snapshot,
    projectId: entry.projectId,
    entryType: entry.type,
    entryName: entry.name,
  };
}

/**
 * エントリのフェーズ別オーバーライドを PhaseSnapshot[] へ取り出す。
 * 各フェーズの summary/content/detail 上書き値（null=ベース継承）を、base と
 * 同じ規則（content は plain text 化、detail は includeInContext のみ）で収める。
 * 上書きが 1 つも無いフェーズは差分に寄与しないため除外する。
 */
async function buildPhaseSnapshots(entryId: string): Promise<PhaseSnapshot[]> {
  const phaseRows = await db
    .select({
      id: codexEntryPhases.id,
      label: codexEntryPhases.label,
      summaryOverride: codexEntryPhases.summaryOverride,
      contentOverride: codexEntryPhases.contentOverride,
    })
    .from(codexEntryPhases)
    .where(eq(codexEntryPhases.entryId, entryId));
  if (phaseRows.length === 0) return [];

  const phaseIds = phaseRows.map((p) => p.id);
  // フェーズ別 detail 上書き（base と同様 includeInContext=1 のみ）。
  const overrideRows = await db
    .select({
      phaseId: codexPhaseDetailOverrides.phaseId,
      name: codexDetailDefinitions.name,
      value: codexPhaseDetailOverrides.value,
    })
    .from(codexPhaseDetailOverrides)
    .innerJoin(
      codexDetailDefinitions,
      and(
        eq(codexPhaseDetailOverrides.definitionId, codexDetailDefinitions.id),
        eq(codexDetailDefinitions.includeInContext, 1),
      ),
    )
    .where(inArray(codexPhaseDetailOverrides.phaseId, phaseIds));

  const detailsByPhase = new Map<
    string,
    Array<{ name: string; value: string }>
  >();
  for (const r of overrideRows) {
    if (r.value === null) continue; // null=継承（上書きなし）
    const value = detailValueToPlainText(r.value);
    if (value.trim() === "") continue;
    const list = detailsByPhase.get(r.phaseId) ?? [];
    list.push({ name: r.name, value });
    detailsByPhase.set(r.phaseId, list);
  }

  const phases: PhaseSnapshot[] = [];
  for (const p of phaseRows) {
    const summary = p.summaryOverride ?? null;
    const contentPlain =
      p.contentOverride !== null ? extractPlainText(p.contentOverride) : null;
    const phaseDetails = detailsByPhase.get(p.id) ?? [];
    // 実効的な上書きが無いフェーズは差分対象外（baseline を肥大させない）。
    const hasOverride =
      (summary !== null && summary.trim() !== "") ||
      (contentPlain !== null && contentPlain.trim() !== "") ||
      phaseDetails.length > 0;
    if (!hasOverride) continue;
    phases.push({
      phaseId: p.id,
      label: p.label,
      summary,
      contentPlain,
      details: phaseDetails,
    });
  }
  return phases;
}
