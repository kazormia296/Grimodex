import {
  AiDataConsentMismatchError,
  AiDataDisclosureUnavailableError,
  assertCurrentAiDataConsentIdentity,
} from "./ai/aiDataDisclosure";
import type { ScanEnv } from "./env";
import type { ScanRepository } from "./repository";

export class WorkflowScanCancelledError extends Error {
  constructor() {
    super("scan was cancelled");
    this.name = "WorkflowScanCancelledError";
  }
}

/** Revalidated at the start of every durable Workflow step and retry. */
export async function ensureWorkflowScanActive(
  repository: ScanRepository,
  scanId: string,
  env: ScanEnv,
): Promise<void> {
  const scan = await repository.getScan(scanId);
  if (!scan) throw new Error("scan session was not found");
  if (scan.status === "cancel_requested") {
    await repository.transitionScan(scanId, "cancelled");
    throw new WorkflowScanCancelledError();
  }
  if (scan.status === "cancelled" || scan.status === "deleted") {
    throw new WorkflowScanCancelledError();
  }
  if (
    scan.status === "completed" ||
    scan.status === "failed" ||
    scan.status === "expired"
  ) {
    throw new Error(`scan is already terminal: ${scan.status}`);
  }
  try {
    await assertCurrentAiDataConsentIdentity(env, scan.aiConsent, "scan");
  } catch (cause) {
    // A retry must never continue with a now-invalid provider configuration.
    // Classify that state as a consent mismatch at the workflow boundary while
    // public disclosure endpoints continue to report configuration failures.
    if (cause instanceof AiDataDisclosureUnavailableError) {
      throw new AiDataConsentMismatchError();
    }
    throw cause;
  }
}
