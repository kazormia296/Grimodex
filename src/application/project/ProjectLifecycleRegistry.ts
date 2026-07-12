export interface ProjectLifecycleContext {
  projectId: string;
}

export interface ProjectLifecycleParticipant {
  id: string;
  reset?: (context: ProjectLifecycleContext) => void | Promise<void>;
  hydrateCritical?: (context: ProjectLifecycleContext) => void | Promise<void>;
  hydrateOptional?: (context: ProjectLifecycleContext) => void | Promise<void>;
  activate?: (context: ProjectLifecycleContext) => void | Promise<void>;
}

export interface ProjectLifecycleRegistry {
  reload(context: ProjectLifecycleContext): Promise<void>;
}

export interface ProjectLifecycleRegistryOptions {
  optionalConcurrency?: number;
  onOptionalFailure?: (
    participant: ProjectLifecycleParticipant,
    error: unknown,
  ) => void;
}

function assertUniqueParticipantIds(
  participants: readonly ProjectLifecycleParticipant[],
): void {
  const seen = new Set<string>();
  for (const participant of participants) {
    if (seen.has(participant.id)) {
      throw new Error(
        `Duplicate project lifecycle participant: ${participant.id}`,
      );
    }
    seen.add(participant.id);
  }
}

async function runInBatches(
  participants: readonly ProjectLifecycleParticipant[],
  context: ProjectLifecycleContext,
  concurrency: number,
  onFailure: ProjectLifecycleRegistryOptions["onOptionalFailure"],
): Promise<void> {
  const batchSize = Math.max(1, Math.floor(concurrency));
  for (let i = 0; i < participants.length; i += batchSize) {
    const batch = participants.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((participant) => participant.hydrateOptional?.(context)),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        onFailure?.(batch[index]!, result.reason);
      }
    });
  }
}

/**
 * Coordinates project-scoped state without exposing feature store shapes to
 * the project feature. Each participant is reset exactly once, critical
 * hydration completes before optional hydration starts, and optional loads
 * retain the previous best-effort failure semantics.
 */
export function createProjectLifecycleRegistry(
  participants: readonly ProjectLifecycleParticipant[],
  options: ProjectLifecycleRegistryOptions = {},
): ProjectLifecycleRegistry {
  assertUniqueParticipantIds(participants);
  const resetParticipants = participants.filter(
    (participant) => participant.reset,
  );
  const criticalParticipants = participants.filter(
    (participant) => participant.hydrateCritical,
  );
  const optionalParticipants = participants.filter(
    (participant) => participant.hydrateOptional,
  );
  const activationParticipants = participants.filter(
    (participant) => participant.activate,
  );

  return {
    async reload(context) {
      for (const participant of resetParticipants) {
        await participant.reset!(context);
      }

      for (const participant of criticalParticipants) {
        await participant.hydrateCritical!(context);
      }

      await runInBatches(
        optionalParticipants,
        context,
        options.optionalConcurrency ?? 3,
        options.onOptionalFailure,
      );

      for (const participant of activationParticipants) {
        await participant.activate!(context);
      }
    },
  };
}
