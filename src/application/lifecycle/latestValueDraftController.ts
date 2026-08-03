import { useRef } from "react";
import type { QuiescenceParticipantFlushOptions } from "./quiescenceParticipants";

export interface LatestValueDraftPersistContext {
  /**
   * The draft existed before strict lifecycle quiescence started. Persistence
   * layers with a mutation admission gate must carry this permit through every
   * fixed-point write, including writes scheduled after an await.
   */
  preexistingDraft: boolean;
}

export type LatestValueDraftPersist<T> = (
  value: T,
  context: LatestValueDraftPersistContext,
) => Promise<void>;

export interface LatestValueDraftController<T> {
  readonly identity: string;
  readonly latestValue: T;
  readonly persistedValue: T;
  readonly dirty: boolean;
  readonly generation: number;
  setPersist: (persist: LatestValueDraftPersist<T>) => void;
  markDirty: (value: T) => void;
  reset: (value: T) => void;
  save: (options?: QuiescenceParticipantFlushOptions) => Promise<void>;
}

/**
 * Drains a local draft to a latest-value fixed point.
 *
 * A successful write only clears the generation it captured. If input changes
 * while that write is pending, the same drain immediately persists the newer
 * generation before resolving. Rejections retain the latest value as dirty so
 * lifecycle retry/recovery can continue after the React surface disappears.
 */
export function createLatestValueDraftController<T>(
  identity: string,
  initialValue: T,
  initialPersist: LatestValueDraftPersist<T>,
  isEqual: (left: T, right: T) => boolean = Object.is,
): LatestValueDraftController<T> {
  let persist = initialPersist;
  let latestValue = initialValue;
  let persistedValue = initialValue;
  let dirty = false;
  let generation = 0;
  let inFlight: Promise<void> | null = null;
  let preexistingDraftPermit = false;

  const controller: LatestValueDraftController<T> = {
    identity,
    get latestValue() {
      return latestValue;
    },
    get persistedValue() {
      return persistedValue;
    },
    get dirty() {
      return dirty;
    },
    get generation() {
      return generation;
    },
    setPersist(nextPersist) {
      persist = nextPersist;
    },
    markDirty(value) {
      latestValue = value;
      generation += 1;
      // Even a value equal to the last persisted value must remain dirty while
      // another value is in flight: once that write lands, this value is the
      // required rollback/fixed-point generation.
      dirty = inFlight !== null || !isEqual(value, persistedValue);
    },
    reset(value) {
      latestValue = value;
      generation += 1;
      if (inFlight) {
        // An explicit cancel/reset during a write becomes the next generation
        // so the completed older write cannot win.
        dirty = true;
      } else {
        persistedValue = value;
        dirty = false;
      }
    },
    save(options = {}) {
      if (options.preexistingDraft === true) {
        // A strict participant may join a drain that a UI event started before
        // the lease. Upgrade the whole drain so later generations remain
        // admitted after the first await.
        preexistingDraftPermit = true;
      }
      if (inFlight) return inFlight;
      if (!dirty) return Promise.resolve();

      const drain = async (): Promise<void> => {
        while (dirty) {
          const value = latestValue;
          const capturedGeneration = generation;
          if (!isEqual(value, persistedValue)) {
            await persist(value, {
              preexistingDraft: preexistingDraftPermit,
            });
            persistedValue = value;
          }
          if (generation === capturedGeneration) {
            dirty = false;
          } else {
            dirty = !isEqual(latestValue, persistedValue);
          }
        }
      };

      const pending = drain();
      inFlight = pending;
      void pending
        .finally(() => {
          if (inFlight === pending) {
            inFlight = null;
            preexistingDraftPermit = false;
          }
        })
        .catch(() => {});
      return pending;
    },
  };

  return controller;
}

/**
 * Keeps one controller per persistence identity. When identity changes, old
 * quiescence callbacks retain the old controller and its old persist closure;
 * the replacement document receives a fresh isolated controller immediately.
 */
export function useLatestValueDraftController<T>(
  identity: string,
  initialValue: T,
  persist: LatestValueDraftPersist<T>,
  isEqual?: (left: T, right: T) => boolean,
): LatestValueDraftController<T> {
  const controllerRef = useRef<LatestValueDraftController<T> | null>(null);
  if (
    controllerRef.current === null ||
    controllerRef.current.identity !== identity
  ) {
    controllerRef.current = createLatestValueDraftController(
      identity,
      initialValue,
      persist,
      isEqual,
    );
  } else {
    controllerRef.current.setPersist(persist);
  }
  return controllerRef.current;
}
