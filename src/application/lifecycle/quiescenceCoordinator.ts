import i18next from "@/lib/i18n";
import {
  awaitPendingEditorWrites,
  hasUnresolvedEditorChanges,
} from "@/lib/editorQuiescence";
import { flushQuiescenceParticipants } from "./quiescenceParticipants";
import { flushQuiescenceProviderStage } from "@/lib/quiescenceProviders";

export type QuiescenceStage =
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
}

export class StrictQuiescenceError extends Error {
  readonly failures: readonly QuiescenceFailure[];

  constructor(failures: readonly QuiescenceFailure[]) {
    super(
      failures.length === 1 && failures[0]?.error instanceof Error
        ? failures[0].error.message
        : "Document lifecycle did not reach quiescence",
    );
    this.name = "StrictQuiescenceError";
    this.failures = failures;
  }
}

export interface QuiescenceDependencies {
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
  flushAutoSaves: () => flushQuiescenceProviderStage("autosave"),
  flushParticipants: flushQuiescenceParticipants,
  flushExternalWriteBacks: () =>
    flushQuiescenceProviderStage("external-write-back"),
  awaitEditorWrites: awaitPendingEditorWrites,
  awaitScopedMutations: () => flushQuiescenceProviderStage("scoped-mutations"),
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
): Promise<void> {
  const failures: QuiescenceFailure[] = [];
  markQuiescence("start");
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
      failures.push({ stage, error });
    }
  };

  await run("autosave", dependencies.flushAutoSaves);
  await run("participants", dependencies.flushParticipants);
  await run("external-write-back", dependencies.flushExternalWriteBacks);
  await run("editor-writes", dependencies.awaitEditorWrites);
  await run("scoped-mutations", dependencies.awaitScopedMutations);
  await run("scene-writes", dependencies.awaitSceneWrites);
  if (dependencies.hasUnresolvedEditorChanges()) {
    markQuiescence("unresolved-editor.failed");
    failures.push({
      stage: "unresolved-editor",
      error: new Error(i18next.t("autoSave.unresolvedChanges")),
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
}
