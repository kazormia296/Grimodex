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
}

export interface MutationAuthorityContext {
  readonly origin: MutationOrigin;
  readonly authorityRoute: MutationAuthorityRoute;
  readonly caller: string;
  readonly controls: readonly string[];
  readonly provenance?: MutationProvenance;
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

  if (FORBIDDEN_CALLERS[context.authorityRoute].includes(context.caller)) {
    throw new Error(
      `Forbidden caller '${context.caller}' for authority route '${context.authorityRoute}'`,
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
}
