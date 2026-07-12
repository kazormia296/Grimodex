import type { CodexEntryPhase, CodexPhaseDetailOverride } from "@/db/schema";
import {
  resolveCodexState,
  type PhaseResolutionMode,
  type ResolvedCodexState,
  type SceneTimeIndex,
  type TemporalAnchor,
} from "../phaseResolver";

export type ResolvableCodexContextEntry = {
  id: string;
  summary: string | null;
  content: string;
  contextMode: string;
};

export interface ResolveCodexContextsInput<
  TEntry extends ResolvableCodexContextEntry,
> {
  entries: readonly TEntry[];
  phases: readonly CodexEntryPhase[];
  phaseDetailOverrides?: readonly CodexPhaseDetailOverride[];
  baseDetailsByEntry?: ReadonlyMap<string, ReadonlyMap<string, string | null>>;
  anchor: TemporalAnchor;
  sceneTimeIndex: SceneTimeIndex;
  resolutionMode: PhaseResolutionMode;
}

export interface ResolvedCodexContexts<TEntry> {
  resolvedById: Map<string, ResolvedCodexState>;
  phasesByEntry: Map<string, CodexEntryPhase[]>;
  entriesById: Map<string, TEntry>;
}

/**
 * Resolve every candidate at one temporal anchor before any visibility or
 * trigger policy is applied. Keeping the batch boundary here prevents callers
 * from accidentally selecting against Base rows and resolving only afterward.
 */
export function resolveCodexContexts<
  TEntry extends ResolvableCodexContextEntry,
>(input: ResolveCodexContextsInput<TEntry>): ResolvedCodexContexts<TEntry> {
  const phasesByEntry = new Map<string, CodexEntryPhase[]>();
  for (const phase of input.phases) {
    const phases = phasesByEntry.get(phase.entryId) ?? [];
    phases.push(phase);
    phasesByEntry.set(phase.entryId, phases);
  }

  const overridesByPhase = new Map<string, CodexPhaseDetailOverride[]>();
  for (const override of input.phaseDetailOverrides ?? []) {
    const overrides = overridesByPhase.get(override.phaseId) ?? [];
    overrides.push(override);
    overridesByPhase.set(override.phaseId, overrides);
  }

  const entriesById = new Map(input.entries.map((entry) => [entry.id, entry]));
  const resolvedById = new Map<string, ResolvedCodexState>();
  for (const entry of input.entries) {
    const phases = phasesByEntry.get(entry.id) ?? [];
    const phaseDetails = new Map<string, CodexPhaseDetailOverride[]>();
    for (const phase of phases) {
      phaseDetails.set(phase.id, overridesByPhase.get(phase.id) ?? []);
    }
    resolvedById.set(
      entry.id,
      resolveCodexState(
        entry,
        phases,
        phaseDetails,
        new Map(input.baseDetailsByEntry?.get(entry.id) ?? []),
        input.anchor,
        input.sceneTimeIndex,
        input.resolutionMode,
      ),
    );
  }

  return { resolvedById, phasesByEntry, entriesById };
}

export type CodexContextInclusionReason =
  | "always"
  | "mention"
  | "explicit-pin"
  | "derived"
  | "active-tab";

/**
 * Shared fail-closed AI exposure policy for a Phase-resolved context mode.
 * `suppress` is the manual-only state and is admitted solely by an explicit
 * pin. `hidden` is never admitted, including through pins or derived paths.
 */
export function canIncludeResolvedCodexContext(
  contextMode: string,
  reason: CodexContextInclusionReason,
): boolean {
  if (contextMode === "hidden") return false;
  if (contextMode === "suppress") return reason === "explicit-pin";
  return contextMode === "always" || contextMode === "mentioned";
}

export function materializeResolvedCodexContext<
  TEntry extends ResolvableCodexContextEntry,
>(entry: TEntry, resolved: ResolvedCodexState): TEntry {
  return {
    ...entry,
    summary: resolved.summary,
    content: resolved.content,
    contextMode: resolved.contextMode,
  };
}
