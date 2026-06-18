import type { CodexEntry } from "./api";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "./phaseApi";
import { resolveCodexState } from "./phaseResolver";

export interface ResolvedCodexBadge {
  phaseLabel?: string;
  resolvedSummary: string | null;
}

type EntryLike = Pick<CodexEntry, "id" | "summary" | "content" | "contextMode">;

export function resolveCodexStatesFor(
  entries: EntryLike[],
  phasesByEntry: Record<string, CodexEntryPhase[]>,
  detailOverrides: Record<string, CodexPhaseDetailOverride[]>,
  globalSceneOrder: Map<string, number>,
  currentSceneId: string | null,
): Map<string, ResolvedCodexBadge> {
  const out = new Map<string, ResolvedCodexBadge>();
  for (const entry of entries) {
    const phases = phasesByEntry[entry.id] ?? [];
    if (phases.length === 0) {
      out.set(entry.id, { resolvedSummary: entry.summary ?? null });
      continue;
    }
    const phaseDetailsMap = new Map<string, CodexPhaseDetailOverride[]>();
    for (const phase of phases)
      phaseDetailsMap.set(phase.id, detailOverrides[phase.id] ?? []);
    const resolved = resolveCodexState(
      {
        summary: entry.summary ?? null,
        content: entry.content,
        contextMode: entry.contextMode ?? "mentioned",
      },
      phases,
      phaseDetailsMap,
      // baseDetails: バッジ表示は summary/phaseLabel のみ使うため detail 値は不要
      new Map(),
      currentSceneId,
      globalSceneOrder,
    );
    const lastPhaseId =
      resolved.appliedPhaseIds[resolved.appliedPhaseIds.length - 1];
    const phaseLabel = lastPhaseId
      ? phases.find((p) => p.id === lastPhaseId)?.label
      : undefined;
    out.set(entry.id, { phaseLabel, resolvedSummary: resolved.summary });
  }
  return out;
}
