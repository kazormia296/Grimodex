import type { NarrativeChangeSet } from "@/features/narrative-extraction/maintenance/changeSet";
import {
  dependencyConsumerId,
  type NarrativeDependencyEdge,
} from "@/features/narrative-extraction/maintenance/dependency";
import { domainObjectKeyToString } from "@/features/narrative-extraction/maintenance/domainObjectKey";
import {
  mostSevereInvalidationPolicy,
  type NarrativeInvalidationPolicy,
} from "@/features/narrative-extraction/maintenance/invalidationPolicy";
import {
  evaluateMaintenanceBudget,
  type MaintenanceBudgetDecision,
  type MaintenanceExecutionBudget,
} from "@/features/narrative-extraction/maintenance/maintenanceMode";

export interface PlanMaintenanceImpactInput {
  readonly changeSet: NarrativeChangeSet;
  readonly dependencyEdges: readonly NarrativeDependencyEdge[];
  readonly budget: MaintenanceExecutionBudget;
}

export interface MaintenanceScaleDecision {
  readonly strategy: "incremental" | "full-rebuild";
  readonly reasons: readonly string[];
  readonly estimatedTasks: number;
  readonly estimatedDocuments: number;
}

export const MAINTENANCE_FULL_REBUILD_THRESHOLD = 50;

export interface PlanMaintenanceImpactResult {
  readonly affectedConsumerIds: readonly string[];
  readonly policies: readonly NarrativeInvalidationPolicy[];
  readonly mostSeverePolicy: NarrativeInvalidationPolicy | null;
  readonly scaleDecision: MaintenanceScaleDecision;
  readonly budgetDecision: MaintenanceBudgetDecision;
}

/**
 * ChangeSet x dependency read model -> deterministic preview plan. C0 does
 * not execute the plan, start a scheduler, or apply any fix.
 */
export function planMaintenanceImpact(
  input: PlanMaintenanceImpactInput,
): PlanMaintenanceImpactResult {
  for (const edge of input.dependencyEdges) {
    if (edge.projectId !== input.changeSet.projectId) {
      throw new TypeError(`dependency '${edge.id}' belongs to another project`);
    }
  }

  const changedKeys = new Set(
    input.changeSet.objectChanges.map((change) =>
      domainObjectKeyToString(change.objectKey),
    ),
  );
  const affectedEdges = input.dependencyEdges.filter(
    (edge) =>
      edge.source.kind === "domain-object" &&
      changedKeys.has(domainObjectKeyToString(edge.source.objectKey)),
  );
  const affectedConsumerIds = Array.from(
    new Set(affectedEdges.map((edge) => dependencyConsumerId(edge.consumer))),
  ).sort();
  const policies = Array.from(
    new Set(affectedEdges.map((edge) => edge.invalidationPolicy)),
  ).sort();

  const estimatedDocuments = input.changeSet.objectChanges.length;
  const estimatedTasks = Math.max(
    affectedConsumerIds.length,
    estimatedDocuments,
  );
  const fullRebuild =
    estimatedDocuments >= MAINTENANCE_FULL_REBUILD_THRESHOLD ||
    affectedConsumerIds.length >= MAINTENANCE_FULL_REBUILD_THRESHOLD;
  const scaleDecision: MaintenanceScaleDecision = {
    strategy: fullRebuild ? "full-rebuild" : "incremental",
    reasons: [
      fullRebuild
        ? "affected set exceeds incremental threshold"
        : "localized object changes",
    ],
    estimatedTasks,
    estimatedDocuments,
  };

  return {
    affectedConsumerIds,
    policies,
    mostSeverePolicy: mostSevereInvalidationPolicy(policies),
    scaleDecision,
    budgetDecision: evaluateMaintenanceBudget(scaleDecision, input.budget),
  };
}
