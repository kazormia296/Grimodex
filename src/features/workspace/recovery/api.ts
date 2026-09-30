import { invoke } from "@/lib/tauri";
import type { RecoveryCandidate } from "./types";

export function listRecoveryCandidates(): Promise<RecoveryCandidate[]> {
  return invoke<RecoveryCandidate[]>("list_recovery_candidates");
}

export function verifyRecoveryCandidate(
  candidateId: string,
): Promise<RecoveryCandidate> {
  return invoke<RecoveryCandidate>("verify_recovery_candidate", {
    candidateId,
  });
}

export function restoreRecoveryCandidate(candidateId: string): Promise<void> {
  return invoke<void>("restore_recovery_candidate", { candidateId });
}

export function quarantineLiveDatabase(): Promise<string> {
  return invoke<string>("quarantine_live_database");
}

export function exportSafeModeDiagnostics(): Promise<string> {
  return invoke<string>("export_safe_mode_diagnostics");
}
