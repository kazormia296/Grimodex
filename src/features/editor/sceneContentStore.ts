import { create } from "zustand";

type ContentCallback = (content: object, sourceGroupIndex: number) => void;

interface SceneContentState {
  /** In-memory TipTap JSON content for scenes currently open in multiple panes */
  liveContent: Record<string, object>;

  /**
   * Write the latest TipTap JSON for a scene.
   * @param sceneId - the scene/note node ID
   * @param content - TipTap getJSON() result
   * @param sourceGroupIndex - which editor group emitted this update (0 or 1)
   */
  setLiveContent: (
    sceneId: string,
    content: object,
    sourceGroupIndex: number,
  ) => void;

  /** Remove cached content when a scene is no longer open in any pane */
  clearContent: (sceneId: string) => void;

  /**
   * Subscribe to content updates for a scene.
   * The callback is called whenever another pane updates the scene's content.
   * @returns unsubscribe function
   */
  subscribe: (sceneId: string, cb: ContentCallback) => () => void;
}

// Subscribers are stored outside Zustand state to avoid serialisation issues
const subscribers = new Map<string, Set<ContentCallback>>();

export const useSceneContentStore = create<SceneContentState>()((set) => ({
  liveContent: {},

  setLiveContent(sceneId, content, sourceGroupIndex) {
    set((state) => ({
      liveContent: { ...state.liveContent, [sceneId]: content },
    }));
    // Notify subscribers
    const cbs = subscribers.get(sceneId);
    if (cbs) {
      for (const cb of cbs) {
        cb(content, sourceGroupIndex);
      }
    }
  },

  clearContent(sceneId) {
    set((state) => {
      const next = { ...state.liveContent };
      delete next[sceneId];
      return { liveContent: next };
    });
  },

  subscribe(sceneId, cb) {
    if (!subscribers.has(sceneId)) {
      subscribers.set(sceneId, new Set());
    }
    subscribers.get(sceneId)!.add(cb);
    return () => {
      subscribers.get(sceneId)?.delete(cb);
    };
  },
}));
