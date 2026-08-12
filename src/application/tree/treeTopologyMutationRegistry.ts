import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";

export interface TreeTopologyMutationLease {
  release(): void;
}

export class TreeTopologyMutationBlockedError extends Error {
  constructor() {
    super("Tree topology mutation is blocked by lifecycle quiescence");
    this.name = "TreeTopologyMutationBlockedError";
  }
}

interface ActiveTopologyMutation {
  readonly settled: Promise<void>;
  readonly resolve: () => void;
}

const activeTopologyMutations = new Map<symbol, ActiveTopologyMutation>();

/** Reserve topology mutation admission before the operation's first await. */
export function tryAcquireTreeTopologyMutationLease(): TreeTopologyMutationLease | null {
  if (!canScheduleQuiescenceMutation()) return null;
  const token = Symbol("tree-topology-mutation");
  let resolve!: () => void;
  const settled = new Promise<void>((done) => {
    resolve = done;
  });
  activeTopologyMutations.set(token, { settled, resolve });
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const active = activeTopologyMutations.get(token);
      activeTopologyMutations.delete(token);
      active?.resolve();
    },
  };
}

export async function runTreeTopologyMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const lease = tryAcquireTreeTopologyMutationLease();
  if (!lease) throw new TreeTopologyMutationBlockedError();
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

/** Drain every topology writer admitted before the narrative lease. */
export async function waitForTreeTopologyMutationsIdle(): Promise<void> {
  while (activeTopologyMutations.size > 0) {
    await Promise.all(
      [...activeTopologyMutations.values()].map(({ settled }) => settled),
    );
  }
}

/** @internal test helper */
export function _resetTreeTopologyMutationRegistryForTests(): void {
  const active = [...activeTopologyMutations.values()];
  activeTopologyMutations.clear();
  for (const mutation of active) mutation.resolve();
}
