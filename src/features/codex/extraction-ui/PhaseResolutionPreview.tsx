import type { CodexEntryPhase, CodexPhaseDetailOverride } from "@/db/schema";
import {
  resolveApplicablePhases,
  type ApplicablePhaseResolution,
} from "@/features/codex/context/resolveApplicablePhases";
import {
  resolveCodexState,
  type ResolvedCodexState,
} from "@/features/codex/phaseResolver";
import type { SceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";

export interface PhaseResolutionPreviewProps {
  readonly entry: {
    readonly summary: string | null;
    readonly content: string;
    readonly contextMode: string;
  };
  readonly phases: CodexEntryPhase[];
  readonly phaseDetails?: Map<string, CodexPhaseDetailOverride[]>;
  readonly baseDetails?: Map<string, string | null>;
  readonly sceneIndex?: SceneTimeIndex | null;
  readonly currentSceneId?: string | null;
}

function formatResolved(state: ResolvedCodexState): string {
  const details = [...state.detailValues.entries()]
    .map(([id, value]) => `${id}=${value ?? "(null)"}`)
    .join(", ");
  return [
    `summary: ${state.summary ?? "(null)"}`,
    `active: ${state.activePhaseLabel ?? "(base)"}`,
    details ? `details: ${details}` : "details: (none)",
  ].join(" · ");
}

/**
 * Lightweight preview using resolveCodexState / resolveApplicablePhases.
 */
export function PhaseResolutionPreview({
  entry,
  phases,
  phaseDetails = new Map(),
  baseDetails = new Map(),
  sceneIndex = null,
  currentSceneId = null,
}: PhaseResolutionPreviewProps) {
  let applicable: ApplicablePhaseResolution | null = null;
  let resolved: ResolvedCodexState;

  if (sceneIndex && currentSceneId) {
    applicable = resolveApplicablePhases({
      phases,
      index: sceneIndex,
      mode: "reading",
      anchor: { kind: "scene", sceneId: currentSceneId },
    });
    resolved = resolveCodexState(
      entry,
      phases,
      phaseDetails,
      baseDetails,
      { kind: "scene", sceneId: currentSceneId },
      sceneIndex,
      "reading",
    );
  } else {
    resolved = resolveCodexState(
      entry,
      phases,
      phaseDetails,
      baseDetails,
      null,
      new Map(),
      { applyAllPhases: true },
    );
  }

  return (
    <section
      className="flex flex-col gap-1.5"
      data-testid="phase-resolution-preview"
    >
      <h4 className="text-xs font-medium text-muted-foreground">
        Phase 解決プレビュー
      </h4>
      <p className="text-xs text-foreground">{formatResolved(resolved)}</p>
      {applicable && (
        <p className="text-[10px] text-muted-foreground">
          適用 Phase:{" "}
          {applicable.applicablePhases.map((phase) => phase.label).join(" → ") ||
            "(なし)"}
        </p>
      )}
    </section>
  );
}
