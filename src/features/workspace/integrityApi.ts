import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { isUnknownIpcOutcomeError } from "@/lib/ipcOutcome";
import { invoke } from "@/lib/tauri";

export interface IntegrityReport {
  orphanedCodexSources: number;
  orphanedSnippetSources: number;
  orphanedSnippetScenes: number;
}

export interface RepairReport {
  codexSourcesFixed: number;
  snippetSourcesFixed: number;
  snippetScenesFixed: number;
  changeEventUid?: string;
  maintenanceTransactionId?: string;
}

interface RepairIntegrityPayload {
  projectId: string;
  requestId: string;
  sessionId: string;
  eventUid: string;
  occurredAt: string;
}

interface PendingRepair {
  readonly projectId: string;
  readonly payload: RepairIntegrityPayload;
}

const pendingRepairs = new Map<string, PendingRepair>();

function acquireRepair(projectId: string): PendingRepair {
  const current = pendingRepairs.get(projectId);
  if (current) return current;
  const requestId = crypto.randomUUID();
  const pending: PendingRepair = {
    projectId,
    payload: {
      projectId,
      requestId,
      sessionId: getRecorderSessionId(),
      eventUid: requestId,
      occurredAt: new Date().toISOString(),
    },
  };
  pendingRepairs.set(projectId, pending);
  return pending;
}

function releaseRepair(pending: PendingRepair): void {
  if (pendingRepairs.get(pending.projectId) === pending) {
    pendingRepairs.delete(pending.projectId);
  }
}

export function checkProjectIntegrity(
  projectId: string,
): Promise<IntegrityReport> {
  return invoke<IntegrityReport>("integrity_check", { projectId });
}

/**
 * Retry an unknown native outcome with the exact same domain identity. Native
 * idempotency then returns the committed receipt without generating a second
 * canonical event or Maintenance Feed transaction.
 */
export async function repairProjectIntegrity(
  projectId: string,
): Promise<RepairReport> {
  const pending = acquireRepair(projectId);
  try {
    const report = await invoke<RepairReport>("repair_integrity", {
      payload: pending.payload,
    });
    releaseRepair(pending);
    return report;
  } catch (error) {
    if (!isUnknownIpcOutcomeError(error)) releaseRepair(pending);
    throw error;
  }
}
