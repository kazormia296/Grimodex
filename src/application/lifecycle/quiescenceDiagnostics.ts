import type {
  QuiescenceFailure,
  QuiescenceStage,
} from "./quiescenceCoordinator";
import type {
  QuiescenceProviderFailure,
  QuiescenceProviderId,
  QuiescenceProviderStage,
} from "@/lib/quiescenceProviders";

export const CLOSE_PHASES = [
  "genesis-prelude",
  "strict-quiescence",
  "authority-quiescence",
  "native-close",
] as const;

export type ClosePhase = (typeof CLOSE_PHASES)[number];

/**
 * This is deliberately a closed, non-sensitive projection. It is the only
 * shape exposed to the browser page and to the Electron smoke harness.
 */
export interface SafeQuiescenceDiagnostic {
  readonly closePhase: ClosePhase;
  readonly stage?: QuiescenceStage;
  readonly providerId?: QuiescenceProviderId;
  readonly errorName: SafeErrorName;
  readonly ipcCode?: SafeIpcCode;
  readonly outcome?: SafeOutcome;
}

type SafeErrorName =
  | "AggregateError"
  | "Error"
  | "EvalError"
  | "IpcInvokeError"
  | "QuiescenceProviderStageError"
  | "RangeError"
  | "ReferenceError"
  | "StrictQuiescenceError"
  | "SyntaxError"
  | "TimelapseGenesisBarrierError"
  | "TypeError"
  | "URIError"
  | "UnknownError";

type SafeIpcCode =
  | "IPC_BACKEND_UNAVAILABLE"
  | "IPC_DERIVED_CANCELLED"
  | "IPC_MUTATION_CANCELLED"
  | "IPC_READ_CANCELLED"
  | "IPC_SECRETS_UNAVAILABLE"
  | "IPC_TIMEOUT"
  | "IPC_UNIMPLEMENTED"
  | "NO_WORKSPACE_OPEN"
  | "RERANKER_BUSY"
  | "UNKNOWN"
  | "WORKSPACE_SWITCHING";

type SafeOutcome = "failed" | "unknown";

const SAFE_ERROR_NAMES = new Set<SafeErrorName>([
  "AggregateError",
  "Error",
  "EvalError",
  "IpcInvokeError",
  "QuiescenceProviderStageError",
  "RangeError",
  "ReferenceError",
  "StrictQuiescenceError",
  "SyntaxError",
  "TimelapseGenesisBarrierError",
  "TypeError",
  "URIError",
]);

const SAFE_IPC_CODES = new Set<SafeIpcCode>([
  "IPC_BACKEND_UNAVAILABLE",
  "IPC_DERIVED_CANCELLED",
  "IPC_MUTATION_CANCELLED",
  "IPC_READ_CANCELLED",
  "IPC_SECRETS_UNAVAILABLE",
  "IPC_TIMEOUT",
  "IPC_UNIMPLEMENTED",
  "NO_WORKSPACE_OPEN",
  "RERANKER_BUSY",
  "UNKNOWN",
  "WORKSPACE_SWITCHING",
]);

const SAFE_OUTCOMES = new Set<SafeOutcome>(["failed", "unknown"]);
const QUIESCENCE_PROVIDER_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const MAX_DIAGNOSTIC_NODES = 32;
const MAX_DIAGNOSTIC_ARRAY_LENGTH = 32;
const MAX_DIAGNOSTIC_RECORDS = 32;
const QUIESCENCE_STAGES = new Set<QuiescenceStage>([
  "ai-executions",
  "autosave",
  "participants",
  "external-write-back",
  "editor-writes",
  "scoped-mutations",
  "scene-writes",
  "unresolved-editor",
  "timelapse",
  "ipc-actual-tasks",
]);

const GLOBAL_DIAGNOSTICS_KEY = "__grimodexQuiescenceDiagnostics";
const EMPTY_DIAGNOSTICS: readonly SafeQuiescenceDiagnostic[] = Object.freeze(
  [],
);
let currentDiagnostics: readonly SafeQuiescenceDiagnostic[] = EMPTY_DIAGNOSTICS;

type DiagnosticsGlobal = typeof globalThis & {
  __grimodexQuiescenceDiagnostics?: readonly SafeQuiescenceDiagnostic[];
};

function publishToPage(diagnostics: readonly SafeQuiescenceDiagnostic[]): void {
  // The page global is intentionally a frozen array of frozen allowlisted
  // records. No error object or caller-supplied string crosses this boundary.
  try {
    (globalThis as DiagnosticsGlobal)[GLOBAL_DIAGNOSTICS_KEY] = diagnostics;
  } catch {
    // Diagnostics must never affect close behavior in restricted webviews.
  }
}

function readOwnProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorName(error: unknown): SafeErrorName {
  try {
    if (!(error instanceof Error)) return "UnknownError";
    const name = error.name;
    return SAFE_ERROR_NAMES.has(name as SafeErrorName)
      ? (name as SafeErrorName)
      : "Error";
  } catch {
    return "UnknownError";
  }
}

function safeIpcInfo(error: unknown): {
  code?: SafeIpcCode;
  outcome?: SafeOutcome;
} {
  try {
    const seen = new Set<object>();
    const pending: unknown[] = [error];
    let code: SafeIpcCode | undefined;
    let outcome: SafeOutcome | undefined;
    let visited = 0;

    // Only inspect own, allowlisted fields. In particular, never read
    // message, stack, details, SQL, document payloads, or arbitrary toString
    // methods. Both object traversal and AggregateError arrays are bounded.
    while (pending.length > 0 && visited < MAX_DIAGNOSTIC_NODES) {
      const current = pending.shift();
      visited += 1;
      if (current === null || typeof current !== "object") continue;
      if (seen.has(current)) continue;
      seen.add(current);

      const candidateCode = readOwnProperty(current, "code");
      if (!code && SAFE_IPC_CODES.has(candidateCode as SafeIpcCode)) {
        code = candidateCode as SafeIpcCode;
      }
      const candidateOutcome = readOwnProperty(current, "outcome");
      if (!outcome && SAFE_OUTCOMES.has(candidateOutcome as SafeOutcome)) {
        outcome = candidateOutcome as SafeOutcome;
      }

      const cause = readOwnProperty(current, "cause");
      if (cause !== undefined && pending.length < MAX_DIAGNOSTIC_NODES) {
        pending.push(cause);
      }
      const nested = readOwnProperty(current, "errors");
      try {
        if (!Array.isArray(nested)) continue;
        const length = Math.min(nested.length, MAX_DIAGNOSTIC_ARRAY_LENGTH);
        for (
          let index = 0;
          index < length && pending.length < MAX_DIAGNOSTIC_NODES;
          index += 1
        ) {
          try {
            pending.push(nested[index]);
          } catch {
            // A revoked/hostile nested array is simply not diagnostic data.
          }
        }
      } catch {
        // Array.isArray/length/index access can cross a Proxy boundary.
      }
    }
    return { code, outcome };
  } catch {
    return {};
  }
}

function safeProviderId(
  providerId: QuiescenceProviderId | undefined,
): QuiescenceProviderId | undefined {
  try {
    if (
      typeof providerId === "string" &&
      QUIESCENCE_PROVIDER_ID_PATTERN.test(providerId)
    ) {
      return providerId;
    }
  } catch {
    // A hostile value must never veto the close path.
  }
  return undefined;
}

function safeStage(
  stage: QuiescenceStage | QuiescenceProviderStage | undefined,
): QuiescenceStage | undefined {
  return stage !== undefined && QUIESCENCE_STAGES.has(stage as QuiescenceStage)
    ? (stage as QuiescenceStage)
    : undefined;
}

function safeClosePhase(value: ClosePhase): ClosePhase {
  try {
    return CLOSE_PHASES.includes(value) ? value : "strict-quiescence";
  } catch {
    return "strict-quiescence";
  }
}

function fallbackDiagnostic(
  closePhase: ClosePhase,
  error: unknown,
): SafeQuiescenceDiagnostic {
  let safePhase: ClosePhase = "strict-quiescence";
  try {
    safePhase = safeClosePhase(closePhase);
  } catch {
    // Keep the fixed safe default.
  }
  let errorName: SafeErrorName = "UnknownError";
  try {
    errorName = safeErrorName(error);
  } catch {
    // Keep the fixed safe default.
  }
  return Object.freeze({ closePhase: safePhase, errorName });
}

export function projectQuiescenceDiagnostic(input: {
  closePhase: ClosePhase;
  stage?: QuiescenceStage | QuiescenceProviderStage;
  providerId?: QuiescenceProviderId;
  originalError: unknown;
}): SafeQuiescenceDiagnostic {
  try {
    const originalError = input.originalError;
    const ipc = safeIpcInfo(originalError);
    const diagnostic: {
      closePhase: ClosePhase;
      stage?: QuiescenceStage;
      providerId?: QuiescenceProviderId;
      errorName: SafeErrorName;
      ipcCode?: SafeIpcCode;
      outcome?: SafeOutcome;
    } = {
      closePhase: safeClosePhase(input.closePhase),
      errorName: safeErrorName(originalError),
    };
    const stage = safeStage(input.stage);
    const providerId = safeProviderId(input.providerId);
    if (stage !== undefined) diagnostic.stage = stage;
    if (providerId !== undefined) diagnostic.providerId = providerId;
    if (ipc.code !== undefined) diagnostic.ipcCode = ipc.code;
    if (ipc.outcome !== undefined) diagnostic.outcome = ipc.outcome;
    return Object.freeze(diagnostic);
  } catch {
    try {
      return fallbackDiagnostic(input.closePhase, input.originalError);
    } catch {
      return Object.freeze({
        closePhase: "strict-quiescence",
        errorName: "UnknownError",
      });
    }
  }
}

export function clearQuiescenceDiagnostics(): void {
  currentDiagnostics = EMPTY_DIAGNOSTICS;
  publishToPage(currentDiagnostics);
}

export function getQuiescenceDiagnostics(): readonly SafeQuiescenceDiagnostic[] {
  return currentDiagnostics;
}

export function publishCloseQuiescenceDiagnostics(
  closePhase: ClosePhase,
  error: unknown,
  failures: readonly QuiescenceFailure[] = [],
): readonly SafeQuiescenceDiagnostic[] {
  let diagnostics: readonly SafeQuiescenceDiagnostic[];
  try {
    const inputs: Array<{
      closePhase: ClosePhase;
      stage?: QuiescenceStage;
      providerId?: QuiescenceProviderId;
      originalError: unknown;
    }> = [];
    try {
      const count = Math.min(failures.length, MAX_DIAGNOSTIC_RECORDS);
      for (let index = 0; index < count; index += 1) {
        try {
          const failure = failures[index];
          if (!failure) continue;
          inputs.push({
            closePhase,
            stage: failure.stage,
            providerId: failure.providerId,
            originalError: failure.originalError,
          });
        } catch {
          // A malformed/revoked failure record is omitted from diagnostics.
        }
      }
    } catch {
      // `failures` may be a hostile Proxy; fall back to the top-level error.
    }
    if (inputs.length === 0) {
      inputs.push({ closePhase, originalError: error });
    }
    diagnostics = Object.freeze(
      inputs.map((input) => projectQuiescenceDiagnostic(input)),
    );
  } catch {
    diagnostics = Object.freeze([fallbackDiagnostic(closePhase, error)]);
  }
  currentDiagnostics = diagnostics;
  try {
    publishToPage(currentDiagnostics);
  } catch {
    // The page global is observability only.
  }
  try {
    globalThis.console?.warn?.(
      "[grimodex] close durability diagnostics",
      currentDiagnostics,
    );
  } catch {
    // Console implementations are host-provided and must not veto close.
  }
  return currentDiagnostics;
}

export type { QuiescenceProviderFailure };
