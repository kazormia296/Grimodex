import { create } from "zustand";
import { encodeDocumentKey, type DocumentKey } from "./document/documentKey";

type DocumentReference = string | DocumentKey;
type LiveContentSource = number | string;
type ContentCallback = (content: object, source: LiveContentSource) => void;

function contentKey(reference: DocumentReference): string {
  return typeof reference === "string"
    ? reference
    : encodeDocumentKey(reference);
}

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
    document: DocumentReference,
    content: object,
    source: LiveContentSource,
  ) => void;

  /** Remove cached content when a scene is no longer open in any pane */
  clearContent: (document: DocumentReference) => void;
  /** Clear all project-owned live content before a project reload. */
  resetForProject: () => void;

  /**
   * Subscribe to content updates for a scene.
   * The callback is called whenever another pane updates the scene's content.
   * @returns unsubscribe function
   */
  subscribe: (document: DocumentReference, cb: ContentCallback) => () => void;
}

// Subscribers are stored outside Zustand state to avoid serialisation issues
const subscribers = new Map<string, Set<ContentCallback>>();

/** True if more than one pane is subscribed to live updates for the given
 *  scene — i.e. some pane *other than the caller* would receive the broadcast.
 *  Each EditorPane self-subscribes for its own nodeId (to receive updates from
 *  other panes), so the caller's own subscription always counts as 1. Anyone
 *  else opening the same id (a second EditorPane group, a Codex/Snippet
 *  mini-editor showing the same content) bumps the count above 1.
 *
 *  Callers use this to skip an expensive `e.getJSON()` deep-clone when no
 *  external listener exists — the common case during normal scene editing. */
export function hasOtherLiveContentSubscriber(
  document: DocumentReference,
): boolean {
  const cbs = subscribers.get(contentKey(document));
  return !!cbs && cbs.size > 1;
}

/** True if ANY live editor is subscribed for the given scene — an EditorPane
 *  tab (which always self-subscribes), a mounted linear-mode block, or a
 *  Codex/Snippet mini-editor. Headless writers (agent auto-apply, rename
 *  propagation) use this to decide whether a post-write `setLiveContent`
 *  resync has an audience. A tab-list check is wrong for this: linear-mode
 *  editors have no tab, and an unsynced live editor's next autosave would
 *  clobber the headless write. */
export function hasLiveContentSubscriber(document: DocumentReference): boolean {
  const cbs = subscribers.get(contentKey(document));
  return !!cbs && cbs.size > 0;
}

export const useSceneContentStore = create<SceneContentState>()((set) => ({
  liveContent: {},

  resetForProject() {
    set({ liveContent: {} });
  },

  setLiveContent(document, content, source) {
    const key = contentKey(document);
    set((state) => ({
      liveContent: { ...state.liveContent, [key]: content },
    }));
    // Notify subscribers
    const cbs = subscribers.get(key);
    if (cbs) {
      for (const cb of cbs) {
        cb(content, source);
      }
    }
  },

  clearContent(document) {
    const key = contentKey(document);
    set((state) => {
      const next = { ...state.liveContent };
      delete next[key];
      return { liveContent: next };
    });
  },

  subscribe(document, cb) {
    const key = contentKey(document);
    if (!subscribers.has(key)) {
      subscribers.set(key, new Set());
    }
    subscribers.get(key)!.add(cb);
    return () => {
      const current = subscribers.get(key);
      current?.delete(cb);
      if (current?.size === 0) subscribers.delete(key);
    };
  },
}));

/**
 * Subscribe to live-content updates for a scene with rAF coalescing.
 *
 * A burst of upstream `setLiveContent` calls (e.g. one per keystroke on
 * another pane / mini-editor) collapses into at most one `apply(content)`
 * invocation per animation frame, using last-write-wins semantics.
 *
 * Updates whose `sourceGroupIndex` matches `ownGroupIndex` are skipped — this
 * is how each subscriber filters out its own broadcasts.
 *
 * @param sceneId - the scene/note/snippet/codex id to mirror
 * @param ownGroupIndex - the caller's source-group sentinel; matching events
 *                        are ignored (own broadcast)
 * @param apply - invoked at most once per frame with the latest content
 * @returns an unsubscribe function that also cancels any pending frame
 */
export function subscribeLiveContentRafCoalesced(
  document: DocumentReference,
  ownSource: LiveContentSource,
  apply: (content: object) => void,
): () => void {
  let pending: object | null = null;
  let frame: number | null = null;
  const flush = () => {
    frame = null;
    const next = pending;
    pending = null;
    if (next == null) return;
    apply(next);
  };
  const unsubscribe = useSceneContentStore
    .getState()
    .subscribe(document, (content, source) => {
      if (source === ownSource) return;
      pending = content;
      if (frame === null) frame = requestAnimationFrame(flush);
    });
  return () => {
    unsubscribe();
    if (frame !== null) cancelAnimationFrame(frame);
    pending = null;
  };
}
