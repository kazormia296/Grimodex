export type ContextAuthority =
  | "author_instruction"
  | "canonical"
  | "derived"
  | "retrieved"
  | "episodic";

export type ContextStability = "session-stable" | "turn-volatile";

export type ContextTrimMode = "atomic" | "head" | "tail" | "blocks" | "list";

export interface ContextItem<
  TPayload = unknown,
  TKind extends string = string,
> {
  key: string;
  kind: TKind;
  authority: ContextAuthority;
  /** Higher values survive budget pressure longer. */
  priority: number;
  stability: ContextStability;
  temporal?: {
    asOfSceneId?: string;
    axis?: "reading" | "story";
    phaseId?: string;
    fallbackReason?: string;
  };
  trim: {
    mode: ContextTrimMode;
    minTokens: number;
    maxTokens: number;
  };
  provenance: {
    sourceType: string;
    sourceId: string;
    sourceVersion?: string | number;
  };
  payload: TPayload;
}

export type ContextDecisionStatus =
  | "selected"
  | "trimmed"
  | "excluded"
  | "unavailable";

export interface ContextDecision {
  key: string;
  status: ContextDecisionStatus;
  /** Stable machine-readable reason suitable for diagnostics and fixtures. */
  reason: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface PlannedContextUsage {
  candidateTokens: number;
  selectedTokens: number;
  trimmedTokens: number;
  /** Null means the caller did not apply a context budget. */
  budgetTokens: number | null;
}

export interface ContextPlan<
  TPayload = unknown,
  TKind extends string = string,
> {
  readonly requestId: string;
  /** Only items selected for rendering. All candidates remain explainable via decisions. */
  readonly items: readonly ContextItem<TPayload, TKind>[];
  readonly decisions: readonly ContextDecision[];
  readonly usage: Readonly<PlannedContextUsage>;
  readonly digest: string;
}

export interface ContextPlanDraft<
  TPayload = unknown,
  TKind extends string = string,
> {
  requestId: string;
  items: readonly ContextItem<TPayload, TKind>[];
  decisions: readonly ContextDecision[];
  usage: Readonly<PlannedContextUsage>;
}

function stableSerialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "bigint":
      return JSON.stringify(`${value.toString()}n`);
    case "undefined":
      return "null";
    case "function":
    case "symbol":
      throw new TypeError(
        "ContextPlan digest only supports serializable values",
      );
    case "object":
      break;
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new TypeError("ContextPlan digest does not support cyclic values");
  }
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableSerialize(entry, seen)).join(",")}]`;
    }
    if (value instanceof Date || value instanceof Map || value instanceof Set) {
      throw new TypeError(
        "ContextPlan only supports immutable JSON-like payload values",
      );
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`,
      );
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/**
 * Fast deterministic diagnostic digest. This is an identity/checksum aid, not a
 * cryptographic integrity boundary; callers must not use it for authorization.
 */
export function computeContextPlanDigest<
  TPayload,
  TKind extends string = string,
>(plan: ContextPlanDraft<TPayload, TKind>): string {
  const serialized = stableSerialize(plan, new WeakSet<object>());
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ctx-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function cloneAndFreeze<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;

  const object = value as object;
  const existing = seen.get(object);
  if (existing !== undefined) return existing as T;

  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new TypeError(
      "ContextPlan only supports immutable JSON-like payload values",
    );
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(object, copy);
    for (const entry of value) copy.push(cloneAndFreeze(entry, seen));
    return Object.freeze(copy) as T;
  }
  const copy: Record<string, unknown> = {};
  seen.set(object, copy);
  for (const key of Object.keys(value)) {
    copy[key] = cloneAndFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(copy) as T;
}

export function createContextPlan<TPayload, TKind extends string = string>(
  draft: ContextPlanDraft<TPayload, TKind>,
): ContextPlan<TPayload, TKind> {
  const normalized = cloneAndFreeze<ContextPlanDraft<TPayload, TKind>>({
    requestId: draft.requestId,
    items: [...draft.items],
    decisions: [...draft.decisions],
    usage: { ...draft.usage },
  });
  return Object.freeze({
    ...normalized,
    digest: computeContextPlanDigest(normalized),
  });
}
