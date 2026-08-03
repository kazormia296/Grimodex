import { useEffect, useRef } from "react";
import {
  registerQuiescenceParticipant,
  type QuiescenceParticipantFlushOptions,
} from "./quiescenceParticipants";

export interface QuiescentDraftParticipantOptions {
  /** Stable persistence identity for one local draft. */
  id: string;
  /** Register only while this surface owns an uncommitted inline edit. */
  enabled: boolean;
  /** Must read refs so it remains valid after the component unmounts. */
  isDirty: () => boolean;
  /** Persist the latest ref-backed draft. Rejections veto strict lifecycle. */
  flush: (options?: QuiescenceParticipantFlushOptions) => Promise<void>;
  /** Explicit destructive lifecycle path. */
  discard: () => void;
  /** Serializable best-effort recovery snapshot. */
  recovery?: () => unknown | null;
}

interface DraftSession {
  id: string;
  current: QuiescentDraftParticipantOptions;
}

/**
 * Bridges component-local inline drafts into strict lifecycle quiescence.
 *
 * A detached dirty session stays registered until its background flush
 * succeeds. This is important for virtualization and panel switches: a failed
 * save must remain retryable even after React has retired the input surface.
 */
export function useQuiescentDraftParticipant(
  options: QuiescentDraftParticipantOptions,
): void {
  const activeSessionRef = useRef<DraftSession | null>(null);
  const latestOptionsRef = useRef(options);
  latestOptionsRef.current = options;
  const { enabled, id } = options;

  // Keep callbacks and ref-backed getters fresh without re-registering on each
  // keystroke. When identity changes, the old session intentionally retains
  // its last old-identity snapshot for cleanup/recovery.
  if (activeSessionRef.current?.id === options.id) {
    activeSessionRef.current.current = options;
  }

  useEffect(() => {
    if (!enabled) return;

    const session: DraftSession = {
      id,
      current: latestOptionsRef.current,
    };
    activeSessionRef.current = session;
    let mounted = true;
    let unregister = () => {};
    let inFlight: Promise<void> | null = null;

    const participant = {
      id,
      flush: (options?: QuiescenceParticipantFlushOptions): Promise<void> => {
        if (inFlight) return inFlight;
        let flushResult: Promise<void>;
        try {
          // Evaluate flush immediately so an identity-changing unmount
          // captures its old ref-backed draft before the replacement
          // component's effects can publish a new target.
          flushResult = session.current.flush(options);
        } catch (error) {
          flushResult = Promise.reject(error);
        }
        // Promise callbacks run after `run` and `inFlight` are assigned, so a
        // synchronously thrown participant cannot hit a temporal-dead-zone or
        // leave the rejected attempt stuck in the coalescing slot.
        const run = flushResult.finally(() => {
          if (inFlight === run) inFlight = null;
          if (!mounted && !session.current.isDirty()) unregister();
        });
        inFlight = run;
        return run;
      },
      discard: () => {
        session.current.discard();
        if (!mounted) unregister();
      },
      recovery: () => session.current.recovery?.() ?? null,
    };
    unregister = registerQuiescenceParticipant(participant);

    return () => {
      mounted = false;
      if (activeSessionRef.current === session) {
        activeSessionRef.current = null;
      }
      if (!session.current.isDirty()) {
        unregister();
        return;
      }
      // A panel/virtual row may disappear outside a destructive lifecycle.
      // Persist in the background, but retain the participant and recovery
      // snapshot after failure so the next strict lifecycle can retry.
      void participant.flush().catch(() => {});
    };
  }, [enabled, id]);
}
