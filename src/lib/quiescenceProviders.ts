export type QuiescenceProviderStage =
  | "ai-executions"
  | "autosave"
  | "external-write-back"
  | "scoped-mutations"
  | "scene-writes"
  | "timelapse"
  | "ipc-actual-tasks";

declare const quiescenceProviderIdBrand: unique symbol;

/**
 * Stable renderer-owned provider identity.  Providers must be declared with a
 * literal through `createQuiescenceProviderId`; the runtime check keeps lazy
 * or test-only registrations from smuggling arbitrary strings into failure
 * diagnostics.
 */
export type QuiescenceProviderId = string & {
  readonly [quiescenceProviderIdBrand]: true;
};

const QUIESCENCE_PROVIDER_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function isQuiescenceProviderId(
  value: unknown,
): value is QuiescenceProviderId {
  try {
    return (
      typeof value === "string" && QUIESCENCE_PROVIDER_ID_PATTERN.test(value)
    );
  } catch {
    return false;
  }
}

export function createQuiescenceProviderId<const Id extends string>(
  id: Id,
): QuiescenceProviderId & Id {
  if (!isQuiescenceProviderId(id)) {
    throw new TypeError(
      `Invalid quiescence provider id: expected [a-z0-9-]{1,64}`,
    );
  }
  return id as QuiescenceProviderId & Id;
}

export interface QuiescenceProvider {
  id: QuiescenceProviderId;
  stage: QuiescenceProviderStage;
  flush: () => Promise<void>;
  discard?: () => void;
  recovery?: () => unknown | readonly unknown[];
}

export interface QuiescenceProviderFailure {
  readonly stage: QuiescenceProviderStage;
  readonly providerId: QuiescenceProviderId;
  readonly originalError: unknown;
}

/**
 * Aggregates provider failures without replacing their identity.  In
 * particular, `errors` contains the exact values thrown by providers,
 * including primitives and nested AggregateErrors.
 */
export class QuiescenceProviderStageError extends AggregateError {
  readonly providerFailures: readonly QuiescenceProviderFailure[];

  constructor(failures: readonly QuiescenceProviderFailure[]) {
    const originalErrors: unknown[] = [];
    try {
      for (let index = 0; index < failures.length; index += 1) {
        const failure = failures[index];
        originalErrors.push(failure?.originalError);
      }
    } catch {
      // A hostile failure container must not replace the original rejection.
    }
    super(originalErrors, "One or more quiescence providers failed to flush");
    this.name = "QuiescenceProviderStageError";
    this.providerFailures = failures;
  }
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
  const providerId = provider.id;
  if (!isQuiescenceProviderId(providerId)) {
    throw new TypeError(
      "Invalid quiescence provider id: expected [a-z0-9-]{1,64}",
    );
  }
  const key = `${provider.stage}:${providerId}`;
  if (providers.has(key)) {
    throw new Error(`Duplicate quiescence provider registration: ${key}`);
  }
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
  const failures = results.flatMap((result, index) =>
    result.status === "rejected" && selected[index]
      ? [
          {
            stage,
            providerId: selected[index].id,
            originalError: result.reason,
          },
        ]
      : [],
  );
  if (failures.length > 0) {
    throw new QuiescenceProviderStageError(failures);
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
