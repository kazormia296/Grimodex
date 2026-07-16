import {
  BrowserWorkspaceError,
  createFailoverWorkspaceStore,
  createIndexedDbWorkspaceStore,
  createMemoryWorkspaceStore,
  type BrowserWorkspaceStore,
} from "../../../../src/lib/browser-db/indexedDbStore";

const fallbackStore = createMemoryWorkspaceStore();
let sharedBrowserWorkspaceStore: BrowserWorkspaceStore | undefined;

/** Shared so browser-editor saves remain visible to the launcher after failover. */
export function createBrowserWorkspaceStore(
  options: {
    primaryStore?: BrowserWorkspaceStore;
    fallbackStore?: BrowserWorkspaceStore;
  } = {},
): BrowserWorkspaceStore {
  if (!options.primaryStore && !options.fallbackStore) {
    if (sharedBrowserWorkspaceStore) return sharedBrowserWorkspaceStore;
    try {
      sharedBrowserWorkspaceStore = createFailoverWorkspaceStore(
        createIndexedDbWorkspaceStore(),
        fallbackStore,
      );
    } catch {
      sharedBrowserWorkspaceStore = fallbackStore;
    }
    return sharedBrowserWorkspaceStore;
  }
  const fallback = options.fallbackStore ?? fallbackStore;
  try {
    return createFailoverWorkspaceStore(
      options.primaryStore ?? createIndexedDbWorkspaceStore(),
      fallback,
    );
  } catch {
    return fallback;
  }
}

export async function saveWorkspaceCopy(
  store: BrowserWorkspaceStore,
  input: {
    workspaceId: string;
    schemaVersion: number;
    updatedAt: string;
    bytes: Uint8Array;
  },
): Promise<void> {
  const state = await store.getState(input.workspaceId);
  if (state && !("deleted" in state)) {
    throw new BrowserWorkspaceError(
      "stale-write",
      "A workspace with that name already exists",
    );
  }
  await store.put({ ...input, revision: (state?.revision ?? 0) + 1 });
}
