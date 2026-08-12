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
export const GATE_B2_ATTEMPT_LEDGER_SCHEMA_VERSION = 1;
export const GATE_B2_ATTEMPT_LEDGER_ID = "grimodex-gate-b2-attempt-ledger-v1";
export const GATE_B2_ATTEMPT_LEDGER_ROOT =
  "/var/lib/grimodex/gate-b2/attempt-ledger";
export const GATE_B2_ATTEMPT_LEDGER_METADATA_FILE = "ledger-metadata.json";
export const GATE_B2_ATTEMPT_LEDGER_CONTROLLER_ID =
  "grimodex-gate-b2-controller-v1";
export const GATE_B2_ATTEMPT_LEDGER_ATTESTATION = "fixed-controller-config-v1";

export function canonicalizeGateB2LedgerValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeGateB2LedgerValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeGateB2LedgerValue(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalizeGateB2LedgerValue(value), "utf8")
    .digest("hex")}`;
}

export function getGateB2AttemptLedgerConfig() {
  const config = {
    configVersion: GATE_B2_CONTROLLER_CONFIG_VERSION,
    ledgerId: GATE_B2_ATTEMPT_LEDGER_ID,
    ledgerRoot: GATE_B2_ATTEMPT_LEDGER_ROOT,
    metadataFile: GATE_B2_ATTEMPT_LEDGER_METADATA_FILE,
    controllerId: GATE_B2_ATTEMPT_LEDGER_CONTROLLER_ID,
    attestation: GATE_B2_ATTEMPT_LEDGER_ATTESTATION,
  };
  return Object.freeze({
    ...config,
    attemptLedgerConfigDigest: sha256Canonical(config),
  });
}

/**
 * Static identity used by freeze/preflight documents. A real certification
 * run replaces the nullable state fields with the controller-provisioned
 * ledger snapshot returned by the binding helpers.
 */
export function getGateB2AttemptLedgerIdentity() {
  const config = getGateB2AttemptLedgerConfig();
  return Object.freeze({
    attemptLedgerId: config.ledgerId,
    attemptLedgerConfigDigest: config.attemptLedgerConfigDigest,
    attemptLedgerDigest: null,
    attemptLedgerInstanceId: null,
    attemptLedgerHeadDigest: null,
    attemptHistoryDigest: null,
    attemptLedgerRecordCount: 0,
    attemptLedgerMaxSequence: 0,
    controllerReceiptDigest: null,
    attemptLedgerAttestation: config.attestation,
  });
}

/**
 * Controller-side metadata builder. The certification runner never calls this
 * to create a root; the external controller writes the returned receipt before
 * execution. The receipt digest is intentionally separate from the config and
 * state digests so a path/config digest cannot masquerade as ledger history.
 */
export function buildGateB2AttemptLedgerMetadata({
  ledgerInstanceId,
  controllerId = GATE_B2_ATTEMPT_LEDGER_CONTROLLER_ID,
  createdAt = new Date().toISOString(),
  publicKeyId,
  controllerSignature,
}) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(ledgerInstanceId ?? ""))) {
    throw new Error("controller ledgerInstanceId is required");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(publicKeyId ?? ""))) {
    throw new Error("controller ledger publicKeyId is required");
  }
  if (typeof controllerSignature !== "string" || controllerSignature.length < 1) {
    throw new Error("controller ledger signature is required");
  }
  const body = {
    schemaVersion: GATE_B2_ATTEMPT_LEDGER_SCHEMA_VERSION,
    ledgerId: GATE_B2_ATTEMPT_LEDGER_ID,
    ledgerInstanceId: String(ledgerInstanceId),
    controllerId: String(controllerId),
    createdAt,
    publicKeyId: String(publicKeyId),
    controllerSignature,
  };
  return Object.freeze({
    ...body,
    controllerReceiptDigest: sha256Canonical(body),
  });
}
