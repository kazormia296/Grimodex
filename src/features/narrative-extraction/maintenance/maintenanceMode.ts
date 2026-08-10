/**
 * How Narrative Maintenance is allowed to run for a project.
 * - `manual` — only ever runs when a human explicitly asks.
 * - `deterministic` — automatic, but only non-AI deterministic operations
 *   (reanchoring, digest recomputation) — never a background AI call.
 * - `idle-suggestions` — may additionally queue background AI re-evaluation
 *   during idle time, subject to `MaintenanceExecutionPolicy`.
 */
export type NarrativeMaintenanceMode =
  | "manual"
  | "deterministic"
  | "idle-suggestions";

export interface MaintenanceExecutionPolicy {
  readonly allowBackgroundAi: boolean;
}

/**
 * How big the current maintenance batch is, for cost/latency gating.
 * `impactPlanner.ts`'s `MaintenanceScaleDecision` maps onto this coarser
 * split when deciding whether background AI should even be considered.
 */
export type NarrativeMaintenanceScale = "small" | "large";

/**
 * Whether a background AI re-evaluation may run right now.
 * `manual` and `deterministic` modes never run AI, regardless of policy.
 * `idle-suggestions` requires `allowBackgroundAi` and a small-enough scale —
 * large batches must go through an explicit, reviewable flow instead.
 */
export function shouldRunBackgroundAi(
  mode: NarrativeMaintenanceMode,
  policy: MaintenanceExecutionPolicy,
  scale: NarrativeMaintenanceScale,
): boolean {
  if (mode !== "idle-suggestions") return false;
  if (!policy.allowBackgroundAi) return false;
  if (scale === "large") return false;
  return true;
}
