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
  ) => Promise<EditorSticky>;
  remove: (
    stickyId: string,
    projectId: string,
    documentKey: DocumentKey,
    baseVersion: number,
  ) => Promise<void>;
}

const pendingLoads = new Map<string, Promise<void>>();
const pendingUpdates = new Map<string, Promise<EditorSticky>>();
const EMPTY_STICKIES: EditorSticky[] = [];

function bucketKey(projectId: string, documentKey: DocumentKey): string {
  return `${projectId}\u0000${encodeDocumentKey(documentKey)}`;
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
      const created = await createEditorSticky({
        ...input,
        projectId,
        documentKey,
      });
      const key = bucketKey(projectId, documentKey);
      set((state) => ({
        byDocument: {
          ...state.byDocument,
          [key]: [...(state.byDocument[key] ?? []), created],
        },
        loaded: { ...state.loaded, [key]: true },
      }));
      return created;
    },

    async update(stickyId, projectId, documentKey, patch) {
      const previous = pendingUpdates.get(stickyId);
      const run = (previous ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const key = bucketKey(projectId, documentKey);
          const current = get().byDocument[key]?.find(
            (sticky) => sticky.id === stickyId,
          );
          if (!current) {
            throw new Error(`Editor sticky ${stickyId} is not loaded`);
          }
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
          const saved = await updateEditorSticky(
            projectId,
            stickyId,
            patch,
            current.version,
          );
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
        });
      pendingUpdates.set(stickyId, run);
      try {
        return await run;
      } finally {
        if (pendingUpdates.get(stickyId) === run)
          pendingUpdates.delete(stickyId);
      }
    },

    async remove(stickyId, projectId, documentKey, baseVersion) {
      await deleteEditorSticky(projectId, stickyId, baseVersion);
      const key = bucketKey(projectId, documentKey);
      set((state) => ({
        byDocument: {
          ...state.byDocument,
          [key]: (state.byDocument[key] ?? []).filter(
            (sticky) => sticky.id !== stickyId,
          ),
        },
      }));
    },
  }),
);

export async function loadEditorStickies(
  projectId: string,
  documentKey: DocumentKey,
): Promise<void> {
  const key = bucketKey(projectId, documentKey);
  if (useEditorStickyStore.getState().loaded[key]) return;
  const pending = pendingLoads.get(key);
  if (pending) return pending;

  const load = listEditorStickies(projectId, documentKey)
    .then((stickies) => {
      useEditorStickyStore.setState((state) => ({
        byDocument: { ...state.byDocument, [key]: stickies },
        loaded: { ...state.loaded, [key]: true },
      }));
    })
    .finally(() => {
      pendingLoads.delete(key);
    });
  pendingLoads.set(key, load);
  return load;
}

export function resetEditorStickyStoreForTests(): void {
  pendingLoads.clear();
  pendingUpdates.clear();
  useEditorStickyStore.setState({ byDocument: {}, loaded: {} });
}
