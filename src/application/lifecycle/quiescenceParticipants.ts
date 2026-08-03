import { schedulePreexistingParticipantMutation } from "./quiescenceLease";

export interface QuiescenceParticipant {
  id: string;
  flush: (options?: QuiescenceParticipantFlushOptions) => Promise<void>;
  discard?: () => void;
  recovery?: () => unknown | null;
}

export interface QuiescenceParticipantFlushOptions {
  /** Permit carried by a draft registered before the active lifecycle lease. */
  preexistingDraft?: boolean;
}

const participants = new Map<symbol, QuiescenceParticipant>();

export function registerQuiescenceParticipant(
  participant: QuiescenceParticipant,
): () => void {
  const token = Symbol(participant.id);
  participants.set(token, participant);
  return () => {
    if (participants.get(token) === participant) participants.delete(token);
  };
}

export async function flushQuiescenceParticipants(): Promise<void> {
  const results = await Promise.allSettled(
    [...participants.values()].map((participant) => {
      try {
        return Promise.resolve(
          schedulePreexistingParticipantMutation(() =>
            participant.flush({ preexistingDraft: true }),
          ),
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "One or more lifecycle participants failed to flush",
    );
  }
}

/** Explicitly destructive path. Call only after a user chooses discard. */
export function discardQuiescenceParticipants(): void {
  for (const participant of participants.values()) participant.discard?.();
}

export function collectQuiescenceParticipantRecovery(): unknown[] {
  const recovery: unknown[] = [];
  for (const participant of participants.values()) {
    try {
      const item = participant.recovery?.();
      if (item !== undefined && item !== null) recovery.push(item);
    } catch {
      // A destroyed surface must not block recovery of the remaining drafts.
    }
  }
  return recovery;
}

export function _resetQuiescenceParticipantsForTests(): void {
  participants.clear();
}
