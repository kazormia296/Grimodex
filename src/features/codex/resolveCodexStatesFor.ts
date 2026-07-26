import type { CodexEntry } from "./api";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "./phaseApi";
import { resolveCodexState } from "./phaseResolver";
import type {
  PhaseResolutionMode,
  SceneTimeIndex,
  TemporalAnchor,
} from "./context/sceneTimeIndex";

export interface ResolvedCodexBadge {
  phaseLabel?: string;
  resolvedSummary: string | null;
  appliedPhaseIds: string[];
}

type EntryLike = Pick<CodexEntry, "id" | "summary" | "content" | "contextMode">;

export function resolveCodexStatesFor(
  entries: EntryLike[],
  phasesByEntry: Record<string, CodexEntryPhase[]>,
  detailOverrides: Record<string, CodexPhaseDetailOverride[]>,
  sceneTimeIndex: SceneTimeIndex,
  resolutionMode: PhaseResolutionMode,
  anchor: TemporalAnchor,
): Map<string, ResolvedCodexBadge> {
  const out = new Map<string, ResolvedCodexBadge>();
  for (const entry of entries) {
    const phases = phasesByEntry[entry.id] ?? [];
    if (phases.length === 0) {
      out.set(entry.id, {
        resolvedSummary: entry.summary ?? null,
        appliedPhaseIds: [],
      });
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
      anchor,
      sceneTimeIndex,
      resolutionMode,
    );
    out.set(entry.id, {
      phaseLabel: resolved.activePhaseLabel ?? undefined,
      resolvedSummary: resolved.summary,
      appliedPhaseIds: resolved.appliedPhaseIds,
    });
  }
  return out;
}
