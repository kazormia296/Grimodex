import { create } from "zustand";
import {
  createEditorSticky,
  deleteEditorSticky,
  listEditorStickies,
  updateEditorSticky,
  type CreateEditorStickyInput,
} from "./editorStickyApi";
import type { DocumentKey } from "@/features/editor/document/documentKey";
import { encodeDocumentKey } from "@/features/editor/document/documentKey";
import type { EditorSticky, EditorStickyPatch } from "./editorStickyTypes";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

interface EditorStickyStoreState {
  byDocument: Record<string, EditorSticky[]>;
  loaded: Record<string, boolean>;
  getForDocument: (
    projectId: string,
    documentKey: DocumentKey,
  ) => EditorSticky[];
  create: (
    projectId: string,
    documentKey: DocumentKey,
    input: Omit<CreateEditorStickyInput, "projectId" | "documentKey">,
  ) => Promise<EditorSticky>;
  update: (
    stickyId: string,
    projectId: string,
    documentKey: DocumentKey,
    patch: EditorStickyPatch,
    baseVersion?: number,
  ) => Promise<EditorSticky>;
  remove: (
    stickyId: string,
    projectId: string,
    documentKey: DocumentKey,
    baseVersion: number,
  ) => Promise<EditorSticky>;
}

const pendingLoads = new Map<string, Promise<void>>();
const pendingMutations = new Map<string, Promise<unknown>>();
const EMPTY_STICKIES: EditorSticky[] = [];
let storeGeneration = 0;

interface EditorStickyScope {
  generation: number;
  workspacePath: string | null;
  workspaceOpenRevision: number | null;
}

class EditorStickyAuthorityChangedError extends Error {
  constructor() {
    super("Editor sticky workspace authority changed");
    this.name = "EditorStickyAuthorityChangedError";
  }
}

function captureScope(): EditorStickyScope {
  const workspace = getCurrentWorkspaceIdentity();
  return {
    generation: storeGeneration,
    workspacePath: workspace?.path ?? null,
    workspaceOpenRevision: workspace?.openRevision ?? null,
  };
}

function isCurrentScope(scope: EditorStickyScope): boolean {
  if (scope.generation !== storeGeneration) return false;
  const workspace = getCurrentWorkspaceIdentity();
  return (
    (workspace?.path ?? null) === scope.workspacePath &&
    (workspace?.openRevision ?? null) === scope.workspaceOpenRevision
  );
}

function assertCurrentScope(scope: EditorStickyScope): void {
  if (!isCurrentScope(scope)) throw new EditorStickyAuthorityChangedError();
}

function bucketKey(
  projectId: string,
  documentKey: DocumentKey,
  scope = captureScope(),
): string {
  return [
    projectId,
    encodeDocumentKey(documentKey),
    scope.workspacePath ?? "",
    scope.workspaceOpenRevision ?? "",
  ].join("\u0000");
}

function mutationKey(
  projectId: string,
  documentKey: DocumentKey,
  stickyId: string,
  scope: EditorStickyScope,
): string {
  return `${bucketKey(projectId, documentKey, scope)}\u0000${stickyId}`;
}

function enqueueMutation<T>(
  key: string,
  operation: () => Promise<T>,
  continueAfterFailure: boolean,
): Promise<T> {
  const previous = pendingMutations.get(key);
  const predecessor = previous
    ? continueAfterFailure
      ? previous.catch(() => undefined)
      : previous
    : Promise.resolve();
  const run = predecessor.then(operation);
  pendingMutations.set(key, run);
  return run.finally(() => {
    if (pendingMutations.get(key) === run) pendingMutations.delete(key);
  });
}

function replaceSticky(
  stickies: EditorSticky[],
  stickyId: string,
  replacement: EditorSticky,
): EditorSticky[] {
  return stickies.map((sticky) =>
    sticky.id === stickyId ? replacement : sticky,
  );
}

export const useEditorStickyStore = create<EditorStickyStoreState>()(
  (set, get) => ({
    byDocument: {},
    loaded: {},

    getForDocument(projectId, documentKey) {
      return (
        get().byDocument[bucketKey(projectId, documentKey)] ?? EMPTY_STICKIES
      );
    },

    async create(projectId, documentKey, input) {
      const scope = captureScope();
      const created = await createEditorSticky({
        ...input,
        projectId,
        documentKey,
      });
      assertCurrentScope(scope);
      const key = bucketKey(projectId, documentKey, scope);
      set((state) => ({
        byDocument: {
          ...state.byDocument,
          [key]: [...(state.byDocument[key] ?? []), created],
        },
        loaded: { ...state.loaded, [key]: true },
      }));
      return created;
    },

    async update(stickyId, projectId, documentKey, patch, baseVersion) {
      const scope = captureScope();
      const key = bucketKey(projectId, documentKey, scope);
      return enqueueMutation(
        mutationKey(projectId, documentKey, stickyId, scope),
        async () => {
          assertCurrentScope(scope);
          const current = get().byDocument[key]?.find(
            (sticky) => sticky.id === stickyId,
          );
          if (!current) {
            throw new Error(`Editor sticky ${stickyId} is not loaded`);
          }
          const expectedVersion = baseVersion ?? current.version;
          const optimistic = { ...current, ...patch };
          set((state) => ({
            byDocument: {
              ...state.byDocument,
              [key]: replaceSticky(
                state.byDocument[key] ?? [],
                stickyId,
                optimistic,
              ),
            },
          }));
          try {
            const saved = await updateEditorSticky(
              projectId,
              stickyId,
              patch,
              expectedVersion,
            );
            assertCurrentScope(scope);
            set((state) => ({
              byDocument: {
                ...state.byDocument,
                [key]: replaceSticky(
                  state.byDocument[key] ?? [],
                  stickyId,
                  saved,
                ),
              },
            }));
            return saved;
          } catch (error) {
            if (!isCurrentScope(scope)) throw error;
            // The native update may fail after another writer has advanced
            // the row. Re-read the bucket so OCC conflicts do not leave the
            // optimistic value and stale version in the editor.
            try {
              await reloadEditorStickies(projectId, documentKey);
            } catch {
              useEditorStickyStore.setState((state) => ({
                loaded: { ...state.loaded, [key]: false },
              }));
              // A failed refresh must still leave the UI usable. Roll back
              // only if this request still owns the optimistic row; a newer
              // local update must not be overwritten by an older failure.
              set((state) => {
                const currentState = state.byDocument[key] ?? [];
                const visible = currentState.find(
                  (sticky) => sticky.id === stickyId,
                );
                if (visible !== optimistic) return state;
                return {
                  byDocument: {
                    ...state.byDocument,
                    [key]: replaceSticky(currentState, stickyId, current),
                  },
                };
              });
            }
            throw error;
          }
        },
        true,
      );
    },

    async remove(stickyId, projectId, documentKey, baseVersion) {
      const scope = captureScope();
      const key = bucketKey(projectId, documentKey, scope);
      return enqueueMutation(
        mutationKey(projectId, documentKey, stickyId, scope),
        async () => {
          assertCurrentScope(scope);
          const current = get().byDocument[key]?.find(
            (sticky) => sticky.id === stickyId,
          );
          if (!current) {
            throw new Error(`Editor sticky ${stickyId} is not loaded`);
          }
          // The queued update, if any, has already committed its newer row.
          // Delete that row rather than the stale render-time version.
          const expectedVersion = current.version ?? baseVersion;
          await deleteEditorSticky(projectId, stickyId, expectedVersion);
          assertCurrentScope(scope);
          set((state) => ({
            byDocument: {
              ...state.byDocument,
              [key]: (state.byDocument[key] ?? []).filter(
                (sticky) => sticky.id !== stickyId,
              ),
            },
          }));
          return current;
        },
        false,
      );
    },
  }),
);

export async function loadEditorStickies(
  projectId: string,
  documentKey: DocumentKey,
): Promise<void> {
  return loadEditorStickiesInternal(projectId, documentKey, false);
}

export async function reloadEditorStickies(
  projectId: string,
  documentKey: DocumentKey,
): Promise<void> {
  return loadEditorStickiesInternal(projectId, documentKey, true);
}

async function loadEditorStickiesInternal(
  projectId: string,
  documentKey: DocumentKey,
  force: boolean,
): Promise<void> {
  const scope = captureScope();
  const scopedKey = bucketKey(projectId, documentKey, scope);
  if (!force && useEditorStickyStore.getState().loaded[scopedKey]) return;
  const pending = pendingLoads.get(scopedKey);
  if (pending) return pending;

  const load = listEditorStickies(projectId, documentKey)
    .then((stickies) => {
      if (!isCurrentScope(scope)) return;
      useEditorStickyStore.setState((state) => ({
        byDocument: { ...state.byDocument, [scopedKey]: stickies },
        loaded: { ...state.loaded, [scopedKey]: true },
      }));
    })
    .finally(() => {
      if (pendingLoads.get(scopedKey) === load) pendingLoads.delete(scopedKey);
    });
  pendingLoads.set(scopedKey, load);
  return load;
}

export function resetEditorStickyStoreForProject(): void {
  storeGeneration += 1;
  pendingLoads.clear();
  pendingMutations.clear();
  useEditorStickyStore.setState({ byDocument: {}, loaded: {} });
}

export function resetEditorStickyStoreForTests(): void {
  resetEditorStickyStoreForProject();
}
