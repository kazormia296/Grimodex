import { cancelScheduledImeExports } from "@/features/ime/scheduler";
import { cancelAllScheduledSemanticIndexes } from "@/features/semantic-search/scheduler";

export function cancelWorkspaceScopedSchedules(): void {
  cancelScheduledImeExports();
  cancelAllScheduledSemanticIndexes();
}
