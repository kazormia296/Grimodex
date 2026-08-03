export interface TreeNodeMutation {
  workspacePath: string | null;
  workspaceOpenRevision: number | null;
  projectId: string;
  nodeId: string;
  updatedAt: string;
}

type TreeNodeMutationListener = (mutation: TreeNodeMutation) => void;

const listeners = new Set<TreeNodeMutationListener>();
const currentByScope = new Map<string, TreeNodeMutation>();
let lastMutationEpochMs = 0;
const SQLITE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function mutationKey(mutation: TreeNodeMutation): string {
  return JSON.stringify([
    mutation.workspacePath,
    mutation.workspaceOpenRevision,
    mutation.projectId,
    mutation.nodeId,
  ]);
}

/**
 * Publish the authoritative token returned by a successful tree_nodes UPDATE.
 * The registry owns no feature state; consumers decide whether the exact
 * workspace/project identity still belongs to them.
 */
export function publishTreeNodeMutation(mutation: TreeNodeMutation): void {
  const published = { ...mutation };
  observeTreeNodeMutationTimestamp(published.updatedAt);
  // A renderer is bound to one workspace generation at a time. Retain replay
  // inventory only for the generation that produced this mutation so repeated
  // workspace opens cannot accumulate stale tokens. Consumers still compare
  // the complete scope before accepting either a live or replayed mutation.
  for (const [key, current] of currentByScope) {
    if (
      current.workspacePath !== published.workspacePath ||
      current.workspaceOpenRevision !== published.workspaceOpenRevision
    ) {
      currentByScope.delete(key);
    }
  }
  currentByScope.set(mutationKey(published), published);
  for (const listener of [...listeners]) listener({ ...published });
}

/** One renderer-wide clock shared by every JavaScript tree_nodes writer. */
export function nextTreeNodeMutationTimestamp(): string {
  const epochMs = Math.max(Date.now(), lastMutationEpochMs + 1);
  lastMutationEpochMs = epochMs;
  return new Date(epochMs).toISOString();
}

/** Seed the renderer clock from an authoritative DB/native OCC token. */
export function observeTreeNodeMutationTimestamp(updatedAt: string): void {
  // SQLite's datetime('now') legacy default is UTC but omits both `T` and a
  // zone suffix. Date.parse treats that shape as local time, which can push
  // the renderer clock hours into the future west of UTC. Only normalize this
  // exact legacy shape; RFC 3339 offsets and higher-precision fractions stay
  // intact for the platform parser.
  const parseable = SQLITE_UTC_TIMESTAMP.test(updatedAt)
    ? `${updatedAt.replace(" ", "T")}Z`
    : updatedAt;
  const epochMs = Date.parse(parseable);
  if (Number.isFinite(epochMs)) {
    lastMutationEpochMs = Math.max(lastMutationEpochMs, epochMs);
  }
}

export function subscribeTreeNodeMutations(
  listener: TreeNodeMutationListener,
  options: { replayCurrent?: boolean } = {},
): () => void {
  listeners.add(listener);
  if (options.replayCurrent) {
    for (const mutation of currentByScope.values()) listener({ ...mutation });
  }
  return () => listeners.delete(listener);
}

export function resetTreeNodeMutationRegistryForTests(): void {
  currentByScope.clear();
  lastMutationEpochMs = 0;
}
