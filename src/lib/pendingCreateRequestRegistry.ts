export interface PendingCreateRequest<TPayload> {
  readonly key: string;
  readonly signature: string;
  readonly requestId: string;
  readonly payload: TPayload;
}

export interface PendingCreateRequestRegistry<TPayload> {
  /**
   * Reuse the exact materialized payload after an unknown outcome. A changed
   * logical signature starts a deliberate new create with a fresh request ID.
   */
  acquire(
    key: string,
    signature: string,
    materialize: (requestId: string) => TPayload,
  ): PendingCreateRequest<TPayload>;
  /** Release only the still-current lease; stale concurrent completions are harmless. */
  release(request: PendingCreateRequest<TPayload>): void;
  clear(): void;
}

/**
 * Stores only unresolved create requests. Callers retain a lease exclusively
 * for an `outcome: unknown`; success and definite failure release it.
 */
export function createPendingCreateRequestRegistry<
  TPayload,
>(): PendingCreateRequestRegistry<TPayload> {
  const pending = new Map<string, PendingCreateRequest<TPayload>>();

  return {
    acquire(key, signature, materialize) {
      const current = pending.get(key);
      if (current?.signature === signature) return current;

      const requestId = crypto.randomUUID();
      const request = {
        key,
        signature,
        requestId,
        payload: materialize(requestId),
      } satisfies PendingCreateRequest<TPayload>;
      pending.set(key, request);
      return request;
    },

    release(request) {
      if (pending.get(request.key) === request) {
        pending.delete(request.key);
      }
    },

    clear() {
      pending.clear();
    },
  };
}
