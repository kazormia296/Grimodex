/**
 * Trusted controller configuration for Gate B2 certification attempts.
 *
 * This module is intentionally not configurable through the certification CLI
 * or the process environment. The controller provisions this append-only path
 * before invoking the runner; a candidate checkout can only consume the
 * identity below, never select another ledger.
 */
import { createHash, createPublicKey, verify } from "node:crypto";

export const GATE_B2_CONTROLLER_CONFIG_VERSION = 1;
export const GATE_B2_ATTEMPT_LEDGER_SCHEMA_VERSION = 1;
export const GATE_B2_ATTEMPT_LEDGER_ID = "grimodex-gate-b2-attempt-ledger-v1";
export const GATE_B2_ATTEMPT_LEDGER_ROOT =
  "/var/lib/grimodex/gate-b2/attempt-ledger";
export const GATE_B2_ATTEMPT_LEDGER_METADATA_FILE = "ledger-metadata.json";
export const GATE_B2_ATTEMPT_LEDGER_CONTROLLER_ID =
  "grimodex-gate-b2-controller-v1";
export const GATE_B2_CONTROLLER_PUBLIC_KEY_ID =
  "grimodex-gate-b2-controller-ed25519-v1";
export const GATE_B2_CONTROLLER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvfHRmKEP7VKntbPck6E3xx+3tfZNxQLVdg51sDF5mGQ=
-----END PUBLIC KEY-----
`;
export const GATE_B2_CONTROLLER_PUBLIC_KEY_FINGERPRINT =
  "sha256:13ac3183cc67fd5cbd4435c61572cc55c72e0cad8acc11adb410e846fffc3170";
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

function publicKeyFingerprint(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({
    type: "spki",
    format: "der",
  });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

function decodeControllerSignature(signature) {
  if (
    typeof signature !== "string" ||
    signature.length < 1 ||
    !/^[A-Za-z0-9_-]+$/.test(signature)
  ) {
    throw new Error("controller ledger signature must be base64url text");
  }
  return Buffer.from(signature, "base64url");
}

export function gateB2AttemptLedgerReceiptPayload(metadata) {
  const { controllerSignature: _signature, controllerReceiptDigest: _digest, ...payload } =
    metadata ?? {};
  return payload;
}

export function verifyGateB2AttemptLedgerMetadata(metadata) {
  const config = getGateB2AttemptLedgerConfig();
  const payload = gateB2AttemptLedgerReceiptPayload(metadata);
  if (
    metadata?.schemaVersion !== GATE_B2_ATTEMPT_LEDGER_SCHEMA_VERSION ||
    metadata?.ledgerId !== config.ledgerId ||
    metadata?.controllerId !== config.controllerId ||
    metadata?.publicKeyId !== config.controllerPublicKeyId
  ) {
    throw new Error("controller ledger receipt identity does not match config");
  }
  if (
    publicKeyFingerprint(GATE_B2_CONTROLLER_PUBLIC_KEY_PEM) !==
    config.controllerPublicKeyFingerprint
  ) {
    throw new Error("fixed Gate B2 controller public key fingerprint is invalid");
  }
  const signature = decodeControllerSignature(metadata.controllerSignature);
  const valid = verify(
    null,
    Buffer.from(canonicalizeGateB2LedgerValue(payload), "utf8"),
    createPublicKey(GATE_B2_CONTROLLER_PUBLIC_KEY_PEM),
    signature,
  );
  if (!valid) {
    throw new Error("Gate B2 controller receipt signature verification failed");
  }
  const receiptDigest = sha256Canonical({
    ...payload,
    controllerSignature: metadata.controllerSignature,
  });
  if (receiptDigest !== metadata.controllerReceiptDigest) {
    throw new Error("Gate B2 attempt ledger controller receipt digest mismatch");
  }
  return Object.freeze({
    ...metadata,
    controllerReceiptDigest: receiptDigest,
  });
}

export function getGateB2AttemptLedgerConfig() {
  const config = {
    configVersion: GATE_B2_CONTROLLER_CONFIG_VERSION,
    ledgerId: GATE_B2_ATTEMPT_LEDGER_ID,
    ledgerRoot: GATE_B2_ATTEMPT_LEDGER_ROOT,
    metadataFile: GATE_B2_ATTEMPT_LEDGER_METADATA_FILE,
    controllerId: GATE_B2_ATTEMPT_LEDGER_CONTROLLER_ID,
    controllerPublicKeyId: GATE_B2_CONTROLLER_PUBLIC_KEY_ID,
    controllerPublicKeyFingerprint: GATE_B2_CONTROLLER_PUBLIC_KEY_FINGERPRINT,
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
    controllerPublicKeyId: config.controllerPublicKeyId,
    controllerPublicKeyFingerprint: config.controllerPublicKeyFingerprint,
    controllerSignature: null,
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
  if (publicKeyId !== GATE_B2_CONTROLLER_PUBLIC_KEY_ID) {
    throw new Error("controller ledger publicKeyId does not match trust anchor");
  }
  if (controllerId !== GATE_B2_ATTEMPT_LEDGER_CONTROLLER_ID) {
    throw new Error("controller ledger controllerId does not match config");
  }
  const body = {
    schemaVersion: GATE_B2_ATTEMPT_LEDGER_SCHEMA_VERSION,
    ledgerId: GATE_B2_ATTEMPT_LEDGER_ID,
    ledgerInstanceId: String(ledgerInstanceId),
    controllerId: String(controllerId),
    createdAt,
    publicKeyId,
    controllerSignature,
  };
  return verifyGateB2AttemptLedgerMetadata({
    ...body,
    controllerReceiptDigest: sha256Canonical(body),
  });
}
