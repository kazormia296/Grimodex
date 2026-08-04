import { trackPendingEditorWrite } from "@/lib/editorQuiescence";

export type StickyDraftPersist = (body: string) => Promise<void>;

export interface StickyDraftController {
  readonly id: string;
  latestBody: string;
  dirty: boolean;
  generation: number;
  setPersist: (persist: StickyDraftPersist | undefined) => void;
  markDirty: (body: string) => void;
  save: () => Promise<void>;
  discard: () => void;
}

/**
 * Keep one retryable draft state outside the rendered sticky surface. Both Map
 * and Editor notes can therefore survive virtualization/unmount while a
 * quiescence boundary is waiting for the final persistence attempt.
 */
export function createStickyDraftController(
  id: string,
  initialBody: string,
): StickyDraftController {
  let persist: StickyDraftPersist | undefined;
  let inFlight: Promise<void> | null = null;

  const controller: StickyDraftController = {
    id,
    latestBody: initialBody,
    dirty: false,
    generation: 0,
    setPersist(nextPersist) {
      persist = nextPersist;
    },
    markDirty(body) {
      controller.latestBody = body;
      controller.dirty = true;
      controller.generation += 1;
    },
    async save() {
      if (inFlight) return inFlight;

      const drain = async (): Promise<void> => {
        while (controller.dirty) {
          const body = controller.latestBody;
          const generation = controller.generation;
          if (!persist) {
            throw new Error(`Sticky draft ${id} has no persistence handler`);
          }
          await trackPendingEditorWrite(persist(body));
          if (controller.generation === generation) {
            controller.dirty = false;
          }
        }
      };

      const pending = drain();
      inFlight = pending;
      void pending.then(
        () => {
          if (inFlight === pending) inFlight = null;
        },
        () => {
          if (inFlight === pending) inFlight = null;
        },
      );
      return pending;
    },
    discard() {
      controller.dirty = false;
    },
  };

  return controller;
}
