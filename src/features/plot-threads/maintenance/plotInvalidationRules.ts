import type { NarrativeInvalidationPolicy } from "@/features/narrative-extraction/maintenance/invalidationPolicy";

export type PlotChangeSignal =
  | "scene-content"
  | "reading-order"
  | "story-time"
  | "scene-add-or-delete";

export function advisePlotInvalidation(signal: PlotChangeSignal): {
  readonly signal: PlotChangeSignal;
  readonly policy: NarrativeInvalidationPolicy;
  readonly changesPhaseType: boolean;
  readonly notes: string;
} {
  switch (signal) {
    case "scene-content":
      return {
        signal,
        policy: "rerun-local",
        changesPhaseType: false,
        notes: "その Scene の Development だけ再評価する",
      };
    case "reading-order":
      return {
        signal,
        policy: "resolve-only",
        changesPhaseType: true,
        notes: "introduce/turn/climax/resolve 割当が order-stale になる",
      };
    case "story-time":
      return {
        signal,
        policy: "resolve-only",
        changesPhaseType: false,
        notes: "Plot phaseType は Reading 構造なので原則変わらない",
      };
    case "scene-add-or-delete":
      return {
        signal,
        policy: "rerun-corpus",
        changesPhaseType: false,
        notes: "resolve / merge / first-marker など Coverage 依存を再評価",
      };
  }
}
