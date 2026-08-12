/**
 * Trusted controller configuration for Gate B2 certification attempts.
 *
 * This module is intentionally not configurable through the certification CLI
 * or the process environment. The controller provisions this append-only path
 * before invoking the runner; a candidate checkout can only consume the
 * identity below, never select another ledger.
 */
import { createHash } from "node:crypto";

export const GATE_B2_CONTROLLER_CONFIG_VERSION = 1;
export const GATE_B2_ATTEMPT_LEDGER_ID = "grimodex-gate-b2-attempt-ledger-v1";
export const GATE_B2_ATTEMPT_LEDGER_ROOT =
  "/var/lib/grimodex/gate-b2/attempt-ledger";
export const GATE_B2_ATTEMPT_LEDGER_ATTESTATION = "fixed-controller-config-v1";

export function getGateB2AttemptLedgerIdentity() {
  const canonical = JSON.stringify({
    configVersion: GATE_B2_CONTROLLER_CONFIG_VERSION,
    ledgerId: GATE_B2_ATTEMPT_LEDGER_ID,
    ledgerRoot: GATE_B2_ATTEMPT_LEDGER_ROOT,
    attestation: GATE_B2_ATTEMPT_LEDGER_ATTESTATION,
  });
  const attemptLedgerDigest = `sha256:${createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")}`;
  return Object.freeze({
    attemptLedgerId: GATE_B2_ATTEMPT_LEDGER_ID,
    attemptLedgerDigest,
    attemptLedgerAttestation: GATE_B2_ATTEMPT_LEDGER_ATTESTATION,
  });
}
