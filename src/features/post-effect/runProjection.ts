import { usePostEffectRunStore } from "./runStore";

export interface RunningPostEffectRunTarget {
  runId: string;
  projectId: string;
}

/** Resolve only still-running post-effect runs from a caller-owned id set. */
export function listRunningPostEffectRunTargets(
  runIds: Iterable<string>,
): RunningPostEffectRunTarget[] {
  const runs = usePostEffectRunStore.getState().runs;
  const targets: RunningPostEffectRunTarget[] = [];
  for (const runId of runIds) {
    const run = runs[runId];
    if (run && run.outcome === undefined) {
      targets.push({ runId: run.runId, projectId: run.projectId });
    }
  }
  return targets;
}
