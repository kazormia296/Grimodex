import {
  dependencyConsumerId,
  type NarrativeDependencyEdge,
} from "@/features/narrative-extraction/maintenance/dependency";
import type { NarrativeChangeSet } from "@/features/narrative-extraction/maintenance/changeSet";
import {
  mostSevereInvalidationPolicy,
  type NarrativeInvalidationPolicy,
} from "@/features/narrative-extraction/maintenance/invalidationPolicy";
import { domainObjectKeyToString } from "@/features/narrative-extraction/maintenance/domainObjectKey";

export interface PlanMaintenanceImpactInput {
  readonly changeSet: NarrativeChangeSet;
  readonly dependencyEdges: readonly NarrativeDependencyEdge[];
}

export interface MaintenanceScaleDecision {
  readonly strategy:
    | "incremental"
    | "cluster-rebuild"
    | "product-rebuild"
    | "full-rebuild";
  readonly reasons: readonly string[];
  readonly estimatedTasks: number;
  readonly estimatedDocuments: number;
}

/** Consumer count at/above which planning switches toward full-rebuild. */
export const MAINTENANCE_FULL_REBUILD_THRESHOLD = 50;

export interface PlanMaintenanceImpactResult {
  readonly affectedConsumerIds: readonly string[];
  readonly policies: readonly NarrativeInvalidationPolicy[];
  readonly scaleDecision: MaintenanceScaleDecision;
}

/**
 * ChangeSet × Dependency Index から影響消費者を求め、増分／大規模戦略を決める。
 * 適用そのものは行わない。
 */
export function planMaintenanceImpact(
  input: PlanMaintenanceImpactInput,
): PlanMaintenanceImpactResult {
  const changedKeys = new Set(
    input.changeSet.objectChanges.map((change) =>
      domainObjectKeyToString(change.objectKey),
    ),
  );

  const affectedEdges = input.dependencyEdges.filter((edge) => {
    if (edge.source.kind !== "domain-object") return false;
    return changedKeys.has(edge.source.objectKey);
  });

  const affectedConsumerIds = Array.from(
    new Set(affectedEdges.map((edge) => dependencyConsumerId(edge.consumer))),
  );

  const policies = Array.from(
    new Set(affectedEdges.map((edge) => edge.invalidationPolicy)),
  );

  const estimatedDocuments = input.changeSet.objectChanges.length;
  const estimatedTasks = Math.max(affectedConsumerIds.length, estimatedDocuments);
  const scaleDecision: MaintenanceScaleDecision =
    estimatedDocuments >= MAINTENANCE_FULL_REBUILD_THRESHOLD ||
    affectedConsumerIds.length >= MAINTENANCE_FULL_REBUILD_THRESHOLD
      ? {
          strategy: "full-rebuild",
          reasons: ["affected set exceeds incremental threshold"],
          estimatedTasks,
          estimatedDocuments,
        }
      : {
          strategy: "incremental",
          reasons: ["localized object changes"],
          estimatedTasks,
          estimatedDocuments,
        };

  void mostSevereInvalidationPolicy(policies);

  return { affectedConsumerIds, policies, scaleDecision };
}
