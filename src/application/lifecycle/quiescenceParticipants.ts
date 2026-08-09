import { schedulePreexistingParticipantMutation } from "./quiescenceLease";

export interface QuiescenceParticipant {
  id: string;
  scope?: QuiescenceParticipantScope;
  isDirty?: () => boolean;
  flush: (options?: QuiescenceParticipantFlushOptions) => Promise<void>;
  discard?: () => void;
  recovery?: () => unknown | null;
}

/** Stable entity identity used to flush only drafts that belong to a corpus. */
export interface QuiescenceParticipantScope {
  kind: string;
  entityId: string;
}

export interface QuiescenceParticipantFlushOptions {
  /** Permit carried by a draft registered before the active lifecycle lease. */
  preexistingDraft?: boolean;
}

const participants = new Map<symbol, QuiescenceParticipant>();
let participantRegistryRevision = 0;
const MAX_SCOPED_DRAIN_ROUNDS = 50;

export function registerQuiescenceParticipant(
  participant: QuiescenceParticipant,
): () => void {
  const token = Symbol(participant.id);
  participants.set(token, participant);
  participantRegistryRevision += 1;
  return () => {
    if (participants.get(token) === participant) {
      participants.delete(token);
      participantRegistryRevision += 1;
    }
  };
}

async function flushParticipants(
  selected: readonly QuiescenceParticipant[],
): Promise<void> {
  const results = await Promise.allSettled(
    selected.map((participant) => {
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

export async function flushQuiescenceParticipants(): Promise<void> {
  await flushParticipants([...participants.values()]);
}

function scopeKey(scope: QuiescenceParticipantScope): string {
  return `${scope.kind}\u0000${scope.entityId}`;
}

function participantsForScopes(
  scopes: readonly QuiescenceParticipantScope[],
): QuiescenceParticipant[] {
  const requested = new Set(scopes.map(scopeKey));
  return [...participants.values()].filter(
    (participant) =>
      participant.scope !== undefined &&
      requested.has(scopeKey(participant.scope)) &&
      participantIsDirty(participant),
  );
}

function participantIsDirty(participant: QuiescenceParticipant): boolean {
  try {
    return participant.isDirty?.() ?? true;
  } catch {
    // A destroyed getter cannot prove the draft is clean. Include it so the
    // strict flush either recovers the draft or reports a blocking failure.
    return true;
  }
}

/** Flush dirty inline drafts owned by the requested entities only. */
export async function flushQuiescenceParticipantsForScopes(
  scopes: readonly QuiescenceParticipantScope[],
): Promise<void> {
  for (let round = 0; round < MAX_SCOPED_DRAIN_ROUNDS; round += 1) {
    const revisionAtStart = participantRegistryRevision;
    await flushParticipants(participantsForScopes(scopes));
    const stillDirty = participantsForScopes(scopes);
    if (
      participantRegistryRevision === revisionAtStart &&
      stillDirty.length === 0
    ) {
      return;
    }
  }
  throw new Error("Scoped draft participants did not reach quiescence");
}

/** Read-only probe used before a scoped snapshot flush. */
export function hasPendingQuiescenceParticipantsForScopes(
  scopes: readonly QuiescenceParticipantScope[],
): boolean {
  return participantsForScopes(scopes).length > 0;
}

export function getQuiescenceParticipantRegistryRevision(): number {
  return participantRegistryRevision;
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
  participantRegistryRevision = 0;
}
