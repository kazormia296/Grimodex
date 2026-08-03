import { collectEditorRecoveryDrafts } from "@/features/editor/editorSaveRegistry";
import { saveTextFile } from "@/lib/exportFile";
import type { QuiescenceFailure } from "./quiescenceCoordinator";
import { collectQuiescenceParticipantRecovery } from "./quiescenceParticipants";
import { collectQuiescenceProviderRecovery } from "@/lib/quiescenceProviders";

function safeFailure(failure: QuiescenceFailure): {
  stage: string;
  error: string;
} {
  // Recovery bundles intentionally contain document drafts, but backend error
  // messages can independently include SQL values or filesystem content.
  // Preserve only the stable error class; the raw message belongs in neither
  // the bundle nor a support log.
  const error = failure.error instanceof Error ? failure.error.name : "Error";
  return { stage: failure.stage, error };
}

export async function exportRecoveryDrafts(
  failures: readonly QuiescenceFailure[],
): Promise<string | null> {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return saveTextFile(
    `grimodex-recovery-${timestamp}.json`,
    { name: "Grimodex recovery", extensions: ["json"] },
    JSON.stringify(
      {
        format: "grimodex-recovery-v1",
        createdAt: new Date().toISOString(),
        failures: failures.map(safeFailure),
        documents: collectEditorRecoveryDrafts(),
        participants: collectQuiescenceParticipantRecovery(),
        providers: collectQuiescenceProviderRecovery(),
      },
      null,
      2,
    ),
    "application/json",
  );
}
