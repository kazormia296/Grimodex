import i18next from "@/lib/i18n";
import {
  awaitPendingEditorWrites,
  hasUnresolvedEditorChanges,
} from "@/lib/editorQuiescence";
import { flushQuiescenceParticipants } from "./quiescenceParticipants";
import {
  flushQuiescenceProviderStage,
  QuiescenceProviderStageError,
  type QuiescenceProviderFailure,
  type QuiescenceProviderId,
} from "@/lib/quiescenceProviders";
import {
  activateLifecycleTransition,
  type LifecycleTransitionTrace,
} from "./lifecycleTrace";

export type QuiescenceStage =
  | "ai-executions"
  | "autosave"
  | "participants"
  | "external-write-back"
  | "editor-writes"
  | "scoped-mutations"
  | "scene-writes"
  | "unresolved-editor"
  | "timelapse"
  | "ipc-actual-tasks";

export interface QuiescenceFailure {
  stage: QuiescenceStage;
  error: unknown;
  /** Compatibility alias retained for recovery/export consumers. */
  originalError: unknown;
  providerId?: QuiescenceProviderId;
  providerStage?: import("@/lib/quiescenceProviders").QuiescenceProviderStage;
}

const GENERIC_QUIESCENCE_ERROR_MESSAGE =
  "Document lifecycle did not reach quiescence";

function hasErrorPrototype(value: unknown): value is Error {
  try {
    if (value instanceof Error) return true;
  } catch {
    // A revoked Proxy can throw while checking its prototype chain.
  }
  if (value === null || typeof value !== "object") return false;
  let current: object | null = value;
  for (let depth = 0; depth < 8 && current !== null; depth += 1) {
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return false;
    }
    if (current === Error.prototype) return true;
  }
  return false;
}

function singleQuiescenceFailureMessage(
  failures: readonly QuiescenceFailure[],
): string | null {
  try {
    if (failures.length !== 1) return null;
    const originalError = failures[0]?.originalError;
    if (!hasErrorPrototype(originalError)) return null;
    const message = originalError.message;
    return typeof message === "string" && message.length > 0 ? message : null;
  } catch {
    // Error/prototype/message getters are untrusted at this boundary.
    return null;
  }
}

export class StrictQuiescenceError extends Error {
  readonly failures: readonly QuiescenceFailure[];
  readonly providerFailures: readonly QuiescenceProviderFailure[];

  constructor(failures: readonly QuiescenceFailure[]) {
    super(
      singleQuiescenceFailureMessage(failures) ??
        GENERIC_QUIESCENCE_ERROR_MESSAGE,
    );
    this.name = "StrictQuiescenceError";
    this.failures = failures;
    const providerFailures: QuiescenceProviderFailure[] = [];
    try {
      for (let index = 0; index < failures.length; index += 1) {
        const failure = failures[index];
        if (
          !failure ||
          failure.providerId === undefined ||
          failure.providerStage === undefined
        ) {
          continue;
        }
        providerFailures.push({
          stage: failure.providerStage,
          providerId: failure.providerId,
          originalError: failure.originalError,
        });
      }
    } catch {
      // A hostile failure record is not allowed to veto the lifecycle error.
    }
    this.providerFailures = providerFailures;
  }
}

export interface QuiescenceDependencies {
  awaitAiExecutions: () => Promise<void>;
  flushAutoSaves: () => Promise<void>;
  flushParticipants: () => Promise<void>;
  flushExternalWriteBacks: () => Promise<void>;
  awaitEditorWrites: () => Promise<void>;
  awaitScopedMutations: () => Promise<void>;
  awaitSceneWrites: () => Promise<void>;
  hasUnresolvedEditorChanges: () => boolean;
  flushTimelapse: () => Promise<void>;
  awaitIpcActualTasks: () => Promise<void>;
}

const defaultDependencies: QuiescenceDependencies = {
  awaitAiExecutions: () => flushQuiescenceProviderStage("ai-executions"),
  flushAutoSaves: () =>
    flushQuiescenceProviderStage("autosave", { preexistingDraft: true }),
  flushParticipants: flushQuiescenceParticipants,
  flushExternalWriteBacks: () =>
    flushQuiescenceProviderStage("external-write-back"),
  awaitEditorWrites: awaitPendingEditorWrites,
  awaitScopedMutations: () =>
    flushQuiescenceProviderStage("scoped-mutations", {
      preexistingDraft: true,
    }),
  awaitSceneWrites: () => flushQuiescenceProviderStage("scene-writes"),
  hasUnresolvedEditorChanges,
  flushTimelapse: () => flushQuiescenceProviderStage("timelapse"),
  awaitIpcActualTasks: () => flushQuiescenceProviderStage("ipc-actual-tasks"),
};

function markQuiescence(name: string): void {
  if (typeof performance === "undefined") return;
  performance.mark(`grimodex.quiescence.${name}`);
}

/**
 * Attempts every persistence surface even when an earlier one fails, then
 * rejects with stage-attributed failures. Destructive callers must not change
 * Project/Workspace/window authority unless this resolves.
 */
export async function flushStrictQuiescence(
  dependencies: QuiescenceDependencies = defaultDependencies,
  options?: {
    transition?: LifecycleTransitionTrace | null;
  },
): Promise<void> {
  const transition = options?.transition ?? null;
  const deactivateTransition = transition
    ? activateLifecycleTransition(transition)
    : null;
  const failures: QuiescenceFailure[] = [];
  markQuiescence("start");
  transition?.advance("quiescence-started");
  const run = async (
    stage: QuiescenceStage,
    operation: () => Promise<void>,
  ): Promise<void> => {
    markQuiescence(`${stage}.start`);
    try {
      await operation();
      markQuiescence(`${stage}.complete`);
    } catch (error) {
      markQuiescence(`${stage}.failed`);
      let providerFailures: readonly QuiescenceProviderFailure[] | undefined;
      try {
        if (error instanceof QuiescenceProviderStageError) {
          providerFailures = error.providerFailures;
        }
      } catch {
        providerFailures = undefined;
      }
      if (providerFailures !== undefined) {
        try {
          failures.push(
            ...providerFailures.map((failure) => ({
              stage,
              error: failure.originalError,
              originalError: failure.originalError,
              providerId: failure.providerId,
              providerStage: failure.stage,
            })),
          );
        } catch {
          failures.push({ stage, error, originalError: error });
        }
      } else {
        failures.push({ stage, error, originalError: error });
      }
    }
  };

  try {
    // AI streams can keep recording observations after their UI cleanup has
    // returned. Drain their durable terminal before persistence producers so
    // any resulting editor/chat writes are included by the stages below.
    await run("ai-executions", dependencies.awaitAiExecutions);
    await run("autosave", dependencies.flushAutoSaves);
    await run("participants", dependencies.flushParticipants);
    await run("external-write-back", dependencies.flushExternalWriteBacks);
    await run("editor-writes", dependencies.awaitEditorWrites);
    await run("scoped-mutations", dependencies.awaitScopedMutations);
    await run("scene-writes", dependencies.awaitSceneWrites);
    if (dependencies.hasUnresolvedEditorChanges()) {
      markQuiescence("unresolved-editor.failed");
      const unresolvedEditorError = new Error(
        i18next.t("autoSave.unresolvedChanges"),
      );
      failures.push({
        stage: "unresolved-editor",
        error: unresolvedEditorError,
        originalError: unresolvedEditorError,
      });
    } else {
      markQuiescence("unresolved-editor.complete");
    }

    // Persistence producers may finish their native mutation while strict
    // quiescence is waiting. Their renderer-facing continuation can enqueue a
    // Timelapse event only after that mutation resolves, so drain actual IPC
    // work before flushing the recorder. The final IPC drain closes over the
    // recorder's own append command (and any other mutation it synchronously
    // produces), giving the destructive lifecycle a producer -> IPC ->
    // Timelapse -> IPC fixed point.
    await run("ipc-actual-tasks", dependencies.awaitIpcActualTasks);
    await run("timelapse", dependencies.flushTimelapse);
    await run("ipc-actual-tasks", dependencies.awaitIpcActualTasks);

    if (failures.length > 0) {
      markQuiescence("failed");
      throw new StrictQuiescenceError(failures);
    }
    markQuiescence("complete");
  } finally {
    deactivateTransition?.();
  }
}
