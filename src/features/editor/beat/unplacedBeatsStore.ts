import { create } from "zustand";
import type { BeatType } from "@/features/editor/SceneBeatNode";

export interface UnplacedBeat {
  id: string;
  beatType: BeatType;
  pov: string | null;
  collapsed: boolean;
  /** ProseMirror inline content nodes (plain JSON, not PMNode instances). */
  content: { type?: string; text?: string; [key: string]: unknown }[];
}

export type UnplacedBeatSource = "load" | "user" | "sync";

interface UnplacedBeatsState {
  /** Per-scene unplaced beats, keyed by sceneId. */
  sceneBeats: Record<string, UnplacedBeat[]>;

  /**
   * Drop every Project/Workspace-scoped cache and listener without notifying
   * subscribers from the retired scope.
   */
  resetForProject(): void;

  getBeats(sceneId: string): UnplacedBeat[];

  /**
   * Replace the beats array for a scene.
   * source='load' skips subscriber notification (initial hydration).
   */
  setBeats(
    sceneId: string,
    beats: UnplacedBeat[],
    source?: UnplacedBeatSource,
  ): void;

  /** Append a new beat to the end of the list. Notifies subscribers. */
  addBeat(sceneId: string, beat: UnplacedBeat): void;

  /** Remove a beat by ID. Notifies subscribers. */
  removeBeat(sceneId: string, beatId: string): void;

  /** Partially update a beat by ID. Notifies subscribers. */
  updateBeat(
    sceneId: string,
    beatId: string,
    patch: Partial<UnplacedBeat>,
  ): void;

  /** Move beat from fromIdx to toIdx (array-move semantics). Notifies subscribers. */
  reorder(sceneId: string, fromIdx: number, toIdx: number): void;

  /** Remove all beats for a scene (used on scene unload). */
  clearScene(sceneId: string): void;

  /**
   * Subscribe to user-driven changes for a scene.
   * Returns an unsubscribe function.
   */
  subscribe(sceneId: string, cb: () => void): () => void;
}

// Subscribers stored outside Zustand state to avoid serialisation issues.
const subscribers = new Map<string, Set<() => void>>();

function notify(sceneId: string) {
  const cbs = subscribers.get(sceneId);
  if (cbs) {
    for (const cb of cbs) cb();
  }
}

function arrayMove<T>(arr: T[], fromIdx: number, toIdx: number): T[] {
  const result = [...arr];
  const clamped = Math.max(0, Math.min(toIdx, result.length - 1));
  const [item] = result.splice(fromIdx, 1);
  result.splice(clamped, 0, item);
  return result;
}

export const useUnplacedBeatsStore = create<UnplacedBeatsState>()(
  (set, get) => ({
    sceneBeats: {},

    resetForProject() {
      subscribers.clear();
      set({ sceneBeats: {} });
    },

    getBeats(sceneId) {
      return get().sceneBeats[sceneId] ?? [];
    },

    setBeats(sceneId, beats, source = "user") {
      set((state) => ({
        sceneBeats: { ...state.sceneBeats, [sceneId]: beats },
      }));
      if (source !== "load") {
        notify(sceneId);
      }
    },

    addBeat(sceneId, beat) {
      set((state) => ({
        sceneBeats: {
          ...state.sceneBeats,
          [sceneId]: [...(state.sceneBeats[sceneId] ?? []), beat],
        },
      }));
      notify(sceneId);
    },

    removeBeat(sceneId, beatId) {
      set((state) => ({
        sceneBeats: {
          ...state.sceneBeats,
          [sceneId]: (state.sceneBeats[sceneId] ?? []).filter(
            (b) => b.id !== beatId,
          ),
        },
      }));
      notify(sceneId);
    },

    updateBeat(sceneId, beatId, patch) {
      set((state) => ({
        sceneBeats: {
          ...state.sceneBeats,
          [sceneId]: (state.sceneBeats[sceneId] ?? []).map((b) =>
            b.id === beatId ? { ...b, ...patch } : b,
          ),
        },
      }));
      notify(sceneId);
    },

    reorder(sceneId, fromIdx, toIdx) {
      const current = get().sceneBeats[sceneId] ?? [];
      if (fromIdx < 0 || fromIdx >= current.length) return;
      set((state) => ({
        sceneBeats: {
          ...state.sceneBeats,
          [sceneId]: arrayMove(state.sceneBeats[sceneId] ?? [], fromIdx, toIdx),
        },
      }));
      notify(sceneId);
    },

    clearScene(sceneId) {
      set((state) => {
        const next = { ...state.sceneBeats };
        delete next[sceneId];
        return { sceneBeats: next };
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
  }),
);
