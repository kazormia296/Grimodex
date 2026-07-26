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
import { and, eq, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { detailValueToPlainText } from "@/features/codex/detailCleanup";
import { parseAliases } from "@/features/codex/codexMatcher";
import type { CodexSnapshot, PhaseSnapshot } from "./diff";
import { canIncludeResolvedCodexContext } from "@/features/codex/context/codexVisibilityPolicy";
import type { SqliteSourceRevisionGuard } from "@/features/post-effect/types";

export interface CodexSnapshotResult {
  snapshot: CodexSnapshot;
  projectId: string;
  entryType: string;
  entryName: string;
  sourceRevision: SqliteSourceRevisionGuard;
  contextMode?: string;
  /** Any explicit phase visibility restriction makes phase diff AI payloads unsafe. */
  hasRestrictedPhases?: boolean;
}

type SnapshotRowKind = "entry" | "detail" | "phase" | "phase-detail";
const nullText = sql<string | null>`NULL`;

function rowKind(kind: SnapshotRowKind) {
  return sql<SnapshotRowKind>`${kind}`;
}

/** エントリ 1 件の base 状態スナップショットを構築。存在しなければ null。 */
export async function buildCodexSnapshot(
  entryId: string,
): Promise<CodexSnapshotResult | null> {
  // sqlite-proxy executes each awaited Drizzle query as a separate IPC call.
  // UNION ALL keeps entry/details/phases in one SQLite statement (one coherent
  // visibility view) without a details x phase-overrides Cartesian product.
  const entryQuery = db
    .select({
      kind: rowKind("entry"),
      projectId: sql<string | null>`${codexEntries.projectId}`,
      entryType: sql<string | null>`${codexEntries.type}`,
      entryName: sql<string | null>`${codexEntries.name}`,
      aliases: sql<string | null>`${codexEntries.aliases}`,
      summary: sql<string | null>`${codexEntries.summary}`,
      content: sql<string | null>`${codexEntries.content}`,
      contextMode: sql<string | null>`${codexEntries.contextMode}`,
      sourceConnectionEpoch: sql<
        string | null
      >`(SELECT epoch FROM temp.grimodex_connection_meta LIMIT 1)`,
      sourceTotalChanges: sql<string | null>`CAST(total_changes() AS TEXT)`,
      sourceDataVersion: sql<
        string | null
      >`CAST((SELECT data_version FROM pragma_data_version) AS TEXT)`,
      detailId: nullText,
      detailName: nullText,
      detailValue: nullText,
      phaseId: nullText,
      phaseLabel: nullText,
      phaseSummary: nullText,
      phaseContent: nullText,
      phaseContextMode: nullText,
      phaseDetailId: nullText,
      phaseDetailName: nullText,
      phaseDetailValue: nullText,
    })
    .from(codexEntries)
    .where(eq(codexEntries.id, entryId));

  const detailQuery = db
    .select({
      kind: rowKind("detail"),
      projectId: nullText,
      entryType: nullText,
      entryName: nullText,
      aliases: nullText,
      summary: nullText,
      content: nullText,
      contextMode: nullText,
      sourceConnectionEpoch: nullText,
      sourceTotalChanges: nullText,
      sourceDataVersion: nullText,
      detailId: sql<string | null>`${codexDetailDefinitions.id}`,
      detailName: sql<string | null>`${codexDetailDefinitions.name}`,
      detailValue: sql<string | null>`${codexDetailValues.value}`,
      phaseId: nullText,
      phaseLabel: nullText,
      phaseSummary: nullText,
      phaseContent: nullText,
      phaseContextMode: nullText,
      phaseDetailId: nullText,
      phaseDetailName: nullText,
      phaseDetailValue: nullText,
    })
    .from(codexDetailValues)
    .innerJoin(
      codexDetailDefinitions,
      and(
        eq(codexDetailValues.definitionId, codexDetailDefinitions.id),
        eq(codexDetailDefinitions.includeInContext, 1),
      ),
    )
    .where(eq(codexDetailValues.entryId, entryId));

  const phaseQuery = db
    .select({
      kind: rowKind("phase"),
      projectId: nullText,
      entryType: nullText,
      entryName: nullText,
      aliases: nullText,
      summary: nullText,
      content: nullText,
      contextMode: nullText,
      sourceConnectionEpoch: nullText,
      sourceTotalChanges: nullText,
      sourceDataVersion: nullText,
      detailId: nullText,
      detailName: nullText,
      detailValue: nullText,
      phaseId: sql<string | null>`${codexEntryPhases.id}`,
      phaseLabel: sql<string | null>`${codexEntryPhases.label}`,
      phaseSummary: sql<string | null>`${codexEntryPhases.summaryOverride}`,
      phaseContent: sql<string | null>`${codexEntryPhases.contentOverride}`,
      phaseContextMode: sql<
        string | null
      >`${codexEntryPhases.contextModeOverride}`,
      phaseDetailId: nullText,
      phaseDetailName: nullText,
      phaseDetailValue: nullText,
    })
    .from(codexEntryPhases)
    .where(eq(codexEntryPhases.entryId, entryId));

  const phaseDetailQuery = db
    .select({
      kind: rowKind("phase-detail"),
      projectId: nullText,
      entryType: nullText,
      entryName: nullText,
      aliases: nullText,
      summary: nullText,
      content: nullText,
      contextMode: nullText,
      sourceConnectionEpoch: nullText,
      sourceTotalChanges: nullText,
      sourceDataVersion: nullText,
      detailId: nullText,
      detailName: nullText,
      detailValue: nullText,
      phaseId: sql<string | null>`${codexEntryPhases.id}`,
      phaseLabel: nullText,
      phaseSummary: nullText,
      phaseContent: nullText,
      phaseContextMode: nullText,
      phaseDetailId: sql<string | null>`${codexDetailDefinitions.id}`,
      phaseDetailName: sql<string | null>`${codexDetailDefinitions.name}`,
      phaseDetailValue: sql<string | null>`${codexPhaseDetailOverrides.value}`,
    })
    .from(codexPhaseDetailOverrides)
    .innerJoin(
      codexEntryPhases,
      eq(codexPhaseDetailOverrides.phaseId, codexEntryPhases.id),
    )
    .innerJoin(
      codexDetailDefinitions,
      and(
        eq(codexPhaseDetailOverrides.definitionId, codexDetailDefinitions.id),
        eq(codexDetailDefinitions.includeInContext, 1),
      ),
    )
    .where(eq(codexEntryPhases.entryId, entryId));

  const rows = await unionAll(
    entryQuery,
    detailQuery,
    phaseQuery,
    phaseDetailQuery,
  );
  const entry = rows.find((row) => row.kind === "entry");
  if (
    !entry ||
    entry.projectId === null ||
    entry.entryType === null ||
    entry.entryName === null ||
    entry.content === null ||
    entry.contextMode === null ||
    entry.sourceConnectionEpoch === null ||
    entry.sourceTotalChanges === null ||
    entry.sourceDataVersion === null
  ) {
    return null;
  }

  const details = rows.flatMap((row) => {
    if (
      row.kind !== "detail" ||
      row.detailId === null ||
      row.detailName === null
    ) {
      return [];
    }
    const value = detailValueToPlainText(row.detailValue);
    return value.trim() === "" ? [] : [{ name: row.detailName, value }];
  });

  const phaseRows = new Map<
    string,
    {
      label: string;
      summary: string | null;
      content: string | null;
      contextMode: string | null;
      details: Array<{ name: string; value: string }>;
    }
  >();
  for (const row of rows) {
    if (row.kind === "phase" && row.phaseId !== null) {
      phaseRows.set(row.phaseId, {
        label: row.phaseLabel ?? "",
        summary: row.phaseSummary,
        content: row.phaseContent,
        contextMode: row.phaseContextMode,
        details: [],
      });
    }
  }
  for (const row of rows) {
    if (
      row.kind !== "phase-detail" ||
      row.phaseId === null ||
      row.phaseDetailId === null ||
      row.phaseDetailName === null
    ) {
      continue;
    }
    const phase = phaseRows.get(row.phaseId);
    if (!phase) continue;
    const value = detailValueToPlainText(row.phaseDetailValue);
    if (value.trim() !== "") {
      phase.details.push({ name: row.phaseDetailName, value });
    }
  }

  const allPhaseIds = [...phaseRows.keys()];
  const restrictedPhaseIds = [...phaseRows]
    .filter(
      ([, phase]) =>
        phase.contextMode !== null &&
        !canIncludeResolvedCodexContext(phase.contextMode, "current-mention"),
    )
    .map(([phaseId]) => phaseId);
  const phases: PhaseSnapshot[] = [...phaseRows].flatMap(([phaseId, phase]) => {
    const summary = phase.summary ?? null;
    const contentPlain =
      phase.content !== null ? extractPlainText(phase.content) : null;
    const hasOverride =
      (summary !== null && summary.trim() !== "") ||
      (contentPlain !== null && contentPlain.trim() !== "") ||
      phase.details.length > 0;
    return hasOverride
      ? [
          {
            phaseId,
            label: phase.label,
            summary,
            contentPlain,
            details: phase.details,
          },
        ]
      : [];
  });

  const snapshot: CodexSnapshot = {
    name: entry.entryName,
    aliases: parseAliases(entry.aliases),
    summary: entry.summary ?? "",
    contentPlain: extractPlainText(entry.content),
    details,
    phases,
    visibilityProvenanceVersion: 1,
    allPhaseIds,
    restrictedPhaseIds,
  };

  return {
    snapshot,
    projectId: entry.projectId,
    entryType: entry.entryType,
    entryName: entry.entryName,
    sourceRevision: {
      kind: "sqlite_revision_v1",
      expected_connection_epoch: entry.sourceConnectionEpoch,
      expected_total_changes: entry.sourceTotalChanges,
      expected_data_version: entry.sourceDataVersion,
    },
    contextMode: entry.contextMode,
    hasRestrictedPhases: restrictedPhaseIds.length > 0,
  };
}
