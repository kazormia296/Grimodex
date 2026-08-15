export const MUTATION_AUTHORITY_ROUTES = [
  "human-direct",
  "interactive-agent-command",
  "interpreter-projection",
  "import-apply",
  "history-replay",
  "restore-or-migration",
] as const;

export type MutationAuthorityRoute = (typeof MUTATION_AUTHORITY_ROUTES)[number];

export const MUTATION_ORIGINS = [
  "human",
  "ai-apply",
  "import",
  "undo",
  "redo",
  "restore",
  "migration",
] as const;

export type MutationOrigin = (typeof MUTATION_ORIGINS)[number];

export const MUTATION_CONTROLS = [
  "runtime-policy",
  "actor-context",
  "knowledge-write-policy",
  "stable-request-id",
  "agent-provenance",
  "typed-writer",
  "occ",
  "source-basis-occ",
  "field-authority",
  "proposal-revision",
  "decision",
  "prepared-commit",
  "application-id",
  "undo-journal",
  "journal-lineage",
  "original-transaction",
  "change-event",
  "change-feed",
  "import-policy",
  "source-package-evidence",
  "exclusive-system-operation",
  "semantic-epoch-event",
  "full-rebuild-marker",
] as const;

export type MutationControl = (typeof MUTATION_CONTROLS)[number];

const ALLOWED_CALLERS = {
  "human-direct": ["human-ui", "manual-wrapper", "typed-domain-api"],
  "interactive-agent-command": [
    "chat-tool-executor",
    "manual-wrapper",
    "registered-agent-surface",
  ],
  "interpreter-projection": [
    "interpreter",
    "reconciler",
    "proposal-review",
    "prepared-commit-runner",
  ],
  "import-apply": ["import-session", "import-review"],
  "history-replay": ["history-controller", "undo-redo-command"],
  "restore-or-migration": [
    "restore-controller",
    "migration-runner",
    "integrity-repair",
  ],
} as const satisfies Record<MutationAuthorityRoute, readonly string[]>;

const ROUTE_ORIGINS = {
  "human-direct": ["human"],
  "interactive-agent-command": ["ai-apply"],
  "interpreter-projection": ["ai-apply"],
  "import-apply": ["import"],
  "history-replay": ["undo", "redo"],
  "restore-or-migration": ["restore", "migration"],
} as const satisfies Record<MutationAuthorityRoute, readonly MutationOrigin[]>;

const CONDITIONAL_CONTROLS = {
  "human-direct": ["field-authority"],
  // Interactive Agent writes always pass Field Authority. Keeping it in the
  // required set (below) makes this route's admission rule unambiguous.
  "interactive-agent-command": [],
  "interpreter-projection": [],
  "import-apply": [],
  "history-replay": [],
  "restore-or-migration": [],
} as const satisfies Record<MutationAuthorityRoute, readonly MutationControl[]>;

const REQUIRED_CONTROLS = {
  "human-direct": [
    "runtime-policy",
    "actor-context",
    "typed-writer",
    "occ",
    "change-event",
    "change-feed",
  ],
  "interactive-agent-command": [
    "knowledge-write-policy",
    "stable-request-id",
    "agent-provenance",
    "field-authority",
    "typed-writer",
    "occ",
    "undo-journal",
    "change-event",
    "change-feed",
  ],
  "interpreter-projection": [
    "proposal-revision",
    "decision",
    "prepared-commit",
    "application-id",
    "source-basis-occ",
    "field-authority",
    "typed-writer",
  ],
  "import-apply": [
    "import-policy",
    "source-package-evidence",
    "typed-writer",
    "occ",
    "change-event",
    "change-feed",
  ],
  "history-replay": [
    "original-transaction",
    "journal-lineage",
    "typed-writer",
    "occ",
    "change-event",
    "change-feed",
  ],
  "restore-or-migration": [
    "exclusive-system-operation",
    "semantic-epoch-event",
    "full-rebuild-marker",
  ],
} as const satisfies Record<MutationAuthorityRoute, readonly MutationControl[]>;

const FORBIDDEN_CALLERS: Readonly<
  Record<MutationAuthorityRoute, readonly string[]>
> = {
  "human-direct": ["background-maintenance", "reconciler", "idle-scheduler"],
  "interactive-agent-command": [
    "background-maintenance",
    "reconciler",
    "idle-scheduler",
  ],
  "interpreter-projection": ["background-maintenance", "idle-scheduler"],
  "import-apply": ["background-maintenance", "idle-scheduler"],
  "history-replay": ["background-maintenance", "reconciler", "idle-scheduler"],
  "restore-or-migration": [
    "background-maintenance",
    "reconciler",
    "idle-scheduler",
  ],
};

export interface MutationProvenance {
  readonly requestId: string;
  readonly traceId: string;
  readonly chatMessageId?: string;
  readonly toolCallId?: string;
  /** Electron main-owned execution identity for capability-bound writes. */
  readonly executionId?: string;
  /** Electron main-owned provenance identity; renderer values are ignored. */
  readonly mainOwnedProvenanceId?: string;
}

export interface MutationAuthorityContext {
  readonly origin: MutationOrigin;
  readonly authorityRoute: MutationAuthorityRoute;
  readonly caller: string;
  readonly controls: readonly MutationControl[];
  readonly provenance?: MutationProvenance;
  readonly originalTransactionId?: string | null;
  readonly undoJournalId?: string | null;
  readonly writesAuthorityProtectedField?: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isMutationAuthorityRoute(
  value: string,
): value is MutationAuthorityRoute {
  return (MUTATION_AUTHORITY_ROUTES as readonly string[]).includes(value);
}

export function assertMutationAuthorityRoute(
  value: string,
): asserts value is MutationAuthorityRoute {
  if (!isMutationAuthorityRoute(value)) {
    throw new Error(`Unknown mutation authority route: ${value}`);
  }
}

export function requiredControlsForRoute(
  route: MutationAuthorityRoute,
): readonly MutationControl[] {
  return REQUIRED_CONTROLS[route];
}

export function allowedCallersForRoute(
  route: MutationAuthorityRoute,
): readonly string[] {
  return ALLOWED_CALLERS[route];
}

export function conditionalControlsForRoute(
  route: MutationAuthorityRoute,
): readonly MutationControl[] {
  return CONDITIONAL_CONTROLS[route];
}

export type UnambiguousMutationOrigin = Exclude<MutationOrigin, "ai-apply">;

/**
 * Return a route only when the low-level origin carries enough information to
 * identify one. `ai-apply` intentionally has two valid routes and must be
 * supplied explicitly by the caller.
 */
export function authorityRouteForUnambiguousOrigin(
  origin: UnambiguousMutationOrigin,
): MutationAuthorityRoute {
  if ((origin as MutationOrigin) === "ai-apply") {
    throw new Error(
      "ai-apply is ambiguous; an explicit authorityRoute is required",
    );
  }
  switch (origin) {
    case "human":
      return "human-direct";
    case "import":
      return "import-apply";
    case "undo":
    case "redo":
      return "history-replay";
    case "restore":
    case "migration":
      return "restore-or-migration";
  }
}

export function forbiddenCallersForRoute(
  route: MutationAuthorityRoute,
): readonly string[] {
  return FORBIDDEN_CALLERS[route];
}

export function assertMutationAuthorityContext(
  context: MutationAuthorityContext,
): void {
  assertMutationAuthorityRoute(context.authorityRoute);
  if (!isNonEmptyString(context.caller)) {
    throw new Error("Mutation authority caller is required");
  }

  const allowedCallers: readonly string[] =
    ALLOWED_CALLERS[context.authorityRoute];
  if (!allowedCallers.includes(context.caller)) {
    throw new Error(
      `Forbidden caller '${context.caller}' for authority route '${context.authorityRoute}'`,
    );
  }

  const allowedOrigins: readonly MutationOrigin[] =
    ROUTE_ORIGINS[context.authorityRoute];
  if (!allowedOrigins.includes(context.origin)) {
    throw new Error(
      `Origin '${context.origin}' is not valid for authority route '${context.authorityRoute}'`,
    );
  }

  const controls = new Set(context.controls);
  const missing = REQUIRED_CONTROLS[context.authorityRoute].filter(
    (control) => !controls.has(control),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required control(s) for '${context.authorityRoute}': ${missing.join(", ")}`,
    );
  }

  if (context.writesAuthorityProtectedField) {
    const missingConditional = CONDITIONAL_CONTROLS[
      context.authorityRoute
    ].filter((control) => !controls.has(control));
    if (missingConditional.length > 0) {
      throw new Error(
        `Missing conditional control(s) for protected fields on '${context.authorityRoute}': ${missingConditional.join(", ")}`,
      );
    }
  }

  if (context.authorityRoute === "interactive-agent-command") {
    if (
      !context.provenance ||
      !isNonEmptyString(context.provenance.requestId) ||
      !isNonEmptyString(context.provenance.traceId)
    ) {
      throw new Error(
        "Interactive agent command requires request and trace provenance",
      );
    }
  }

  const replayOrigin = context.origin === "undo" || context.origin === "redo";
  const hasReplayLineage =
    isNonEmptyString(context.originalTransactionId) &&
    isNonEmptyString(context.undoJournalId);
  if (context.authorityRoute === "history-replay") {
    if (!replayOrigin || !hasReplayLineage) {
      throw new Error(
        "History replay requires undo/redo origin and transaction/journal lineage",
      );
    }
  } else if (replayOrigin || hasReplayLineage) {
    throw new Error(
      "Undo/redo lineage is only valid on the history-replay authority route",
    );
  }
}
