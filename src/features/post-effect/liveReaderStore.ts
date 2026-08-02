import { create } from "zustand";

export interface LiveReaderComment {
  id: string;
  runId: string;
  sceneId: string;
  content: string;
  persona: string | null;
  foundText: string;
  foundContext: string;
  createdAt: number;
}

interface LiveReaderState {
  commentsByScene: Map<string, LiveReaderComment[]>;
  addComment: (comment: LiveReaderComment) => void;
  clearScene: (sceneId: string) => void;
  clearComment: (sceneId: string, commentId: string) => void;
}

const MAX_VISIBLE_COMMENTS = 6;

export const useLiveReaderStore = create<LiveReaderState>()((set) => ({
  commentsByScene: new Map(),

  addComment: (comment) =>
    set((state) => {
      const next = new Map(state.commentsByScene);
      const previous = next.get(comment.sceneId) ?? [];
      next.set(
        comment.sceneId,
        [...previous, comment].slice(-MAX_VISIBLE_COMMENTS),
      );
      return { commentsByScene: next };
    }),

  clearScene: (sceneId) =>
    set((state) => {
      if (!state.commentsByScene.has(sceneId)) return state;
      const next = new Map(state.commentsByScene);
      next.delete(sceneId);
      return { commentsByScene: next };
    }),

  clearComment: (sceneId, commentId) =>
    set((state) => {
      const previous = state.commentsByScene.get(sceneId);
      if (!previous) return state;
      const remaining = previous.filter((comment) => comment.id !== commentId);
      const next = new Map(state.commentsByScene);
      if (remaining.length === 0) next.delete(sceneId);
      else next.set(sceneId, remaining);
      return { commentsByScene: next };
    }),
}));
