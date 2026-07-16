import {
  BrowserWorkspaceError,
  type BrowserWorkspaceStore,
  type WorkspaceSnapshotMetadata,
} from "./indexedDbStore";

export type WorkspaceOpenResult<T> =
  | { status: "missing"; workspaceId: string }
  | {
      status: "opened";
      workspaceId: string;
      metadata: WorkspaceSnapshotMetadata;
      value: T;
    }
  | {
      status: "corrupt";
      workspaceId: string;
      metadata: WorkspaceSnapshotMetadata;
      error: Error;
    };

export interface BrowserWorkspaceLifecycle {
  list(): Promise<WorkspaceSnapshotMetadata[]>;
  open<T>(
    workspaceId: string,
    decode: (bytes: Uint8Array) => T,
  ): Promise<WorkspaceOpenResult<T>>;
  remove(workspaceId: string): Promise<void>;
  rename(workspaceId: string, nextWorkspaceId: string): Promise<void>;
}

export function createBrowserWorkspaceLifecycle(
  store: BrowserWorkspaceStore,
): BrowserWorkspaceLifecycle {
  return {
    list: () => store.list(),
    async open<T>(
      workspaceId: string,
      decode: (bytes: Uint8Array) => T,
    ): Promise<WorkspaceOpenResult<T>> {
      const snapshot = await store.get(workspaceId);
      if (!snapshot) return { status: "missing", workspaceId };
      try {
        return {
          status: "opened",
          workspaceId,
          metadata: snapshot,
          value: decode(snapshot.bytes),
        };
      } catch (cause) {
        return {
          status: "corrupt",
          workspaceId,
          metadata: snapshot,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        };
      }
    },
    remove: (workspaceId) => store.delete(workspaceId),
    async rename(workspaceId, nextWorkspaceId) {
      if (!nextWorkspaceId.trim()) {
        throw new BrowserWorkspaceError(
          "storage-failed",
          "Workspace name cannot be empty",
        );
      }
      if (workspaceId === nextWorkspaceId) return;
      await store.rename(workspaceId, nextWorkspaceId);
    },
  };
}
