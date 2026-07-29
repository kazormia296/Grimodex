export type QuiescenceProviderStage =
  | "autosave"
  | "external-write-back"
  | "scoped-mutations"
  | "scene-writes"
  | "timelapse"
  | "ipc-actual-tasks";

export interface QuiescenceProvider {
  id: string;
  stage: QuiescenceProviderStage;
  flush: () => Promise<void>;
  discard?: () => void;
  recovery?: () => unknown | readonly unknown[];
}

const providers = new Map<string, QuiescenceProvider>();

/**
 * Feature-owned persistence surfaces register themselves with the
 * lifecycle registry. The coordinator never imports the feature stores it is
 * protecting, which keeps this neutral module out of feature cycles.
 */
export function registerQuiescenceProvider(
  provider: QuiescenceProvider,
): () => void {
  const key = `${provider.stage}:${provider.id}`;
  providers.set(key, provider);
  return () => {
    if (providers.get(key) === provider) providers.delete(key);
  };
}

export async function flushQuiescenceProviderStage(
  stage: QuiescenceProviderStage,
): Promise<void> {
  const selected = [...providers.values()].filter(
    (provider) => provider.stage === stage,
  );
  const results = await Promise.allSettled(
    selected.map((provider) => provider.flush()),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    const message =
      failures.length === 1 && failures[0] instanceof Error
        ? failures[0].message
        : `One or more ${stage} providers failed to flush`;
    throw new AggregateError(failures, message);
  }
}

/** Explicitly destructive path; call only after direct user confirmation. */
export function discardQuiescenceProviders(): void {
  for (const provider of providers.values()) provider.discard?.();
}

export function collectQuiescenceProviderRecovery(): unknown[] {
  const recovery: unknown[] = [];
  for (const provider of providers.values()) {
    try {
      const item = provider.recovery?.();
      if (item === undefined || item === null) continue;
      if (Array.isArray(item)) recovery.push(...item);
      else recovery.push(item);
    } catch {
      // Recovery is best-effort per provider; other drafts remain exportable.
    }
  }
  return recovery;
}
