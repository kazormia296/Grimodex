export type NarrativeMaintenanceMode =
  | "disabled"
  | "manual"
  | "deterministic"
  | "idle-suggestions";

export interface MaintenanceExecutionPolicy {
  readonly allowBackgroundAi: boolean;
  readonly allowAutomaticFixes?: boolean;
}

export type NarrativeMaintenanceScale = "small" | "large";

export interface MaintenanceExecutionBudget {
  readonly maxTasks: number;
  readonly maxDocuments: number;
}

export interface MaintenanceExecutionEstimate {
  readonly estimatedTasks: number;
  readonly estimatedDocuments: number;
}

export type MaintenanceBudgetDecision =
  | { readonly allowed: true; readonly reasons: readonly [] }
  | { readonly allowed: false; readonly reasons: readonly string[] };

function requireBudgetValue(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

export function evaluateMaintenanceBudget(
  estimate: MaintenanceExecutionEstimate,
  budget: MaintenanceExecutionBudget,
): MaintenanceBudgetDecision {
  requireBudgetValue(estimate.estimatedTasks, "estimatedTasks");
  requireBudgetValue(estimate.estimatedDocuments, "estimatedDocuments");
  requireBudgetValue(budget.maxTasks, "maxTasks");
  requireBudgetValue(budget.maxDocuments, "maxDocuments");

  const reasons: string[] = [];
  if (estimate.estimatedTasks > budget.maxTasks) {
    reasons.push("estimated tasks exceed the maintenance budget");
  }
  if (estimate.estimatedDocuments > budget.maxDocuments) {
    reasons.push("estimated documents exceed the maintenance budget");
  }
  return reasons.length === 0
    ? { allowed: true, reasons: [] }
    : { allowed: false, reasons };
}

/** Gate C0 allows an explicitly requested, in-budget preview only. */
export function shouldBuildMaintenancePreview(
  mode: NarrativeMaintenanceMode,
  explicitlyRequested: boolean,
  budgetDecision: MaintenanceBudgetDecision,
): boolean {
  return mode !== "disabled" && explicitlyRequested && budgetDecision.allowed;
}

/** Gate C0 has no background AI execution path. */
export function shouldRunBackgroundAi(
  _mode: NarrativeMaintenanceMode,
  _policy: MaintenanceExecutionPolicy,
  _scale: NarrativeMaintenanceScale,
): boolean {
  return false;
}

/** Gate C0 has no idle scheduler, even for future-facing modes. */
export function shouldStartMaintenanceScheduler(
  _mode: NarrativeMaintenanceMode,
): boolean {
  return false;
}

/** Exact reanchor results are previews; Gate C0 never auto-applies fixes. */
export function shouldAutoApplyMaintenanceFix(
  _mode: NarrativeMaintenanceMode,
  _policy: MaintenanceExecutionPolicy,
): boolean {
  return false;
}
