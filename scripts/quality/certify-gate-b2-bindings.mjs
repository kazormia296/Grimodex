/**
 * Gate B2 certification binding helpers — candidate freeze, secrets, evidence.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  GATE_B2_ATTEMPT_LEDGER_METADATA_FILE,
  GATE_B2_ATTEMPT_LEDGER_SCHEMA_VERSION,
  canonicalizeGateB2LedgerValue,
  getGateB2AttemptLedgerConfig,
  getGateB2AttemptLedgerIdentity,
} from "./gate-b2-controller-config.mjs";

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const PLACEHOLDER_ENV_ASSIGN = /\b([A-Z][A-Z0-9_]*)=\.\.\.(\s+)/g;

export const GATE_B2_CONTRACT_VERSION = 6;

export const FREEZE_RELATIVE =
  "evals/certifications/gate-b2-candidate.freeze.json";

export const HARNESS_DIGEST_PATHS = {
  certificationManifestDigest: "evals/certifications/gate-b2.yaml",
  certifyBootstrapDigest: "scripts/quality/certify-gate-b2-bootstrap.mjs",
  certifyRunnerDigest: "scripts/quality/certify-gate-b2.mjs",
  certifyBindingsDigest: "scripts/quality/certify-gate-b2-bindings.mjs",
  adrValidatorDigest: "scripts/quality/validate-gate-b2-adr.mjs",
  reportSchemaDigest:
    "evals/certifications/schemas/gate-b2-report-v1.schema.json",
  decisionSchemaDigest:
    "evals/certifications/schemas/gate-b2-decision-v1.schema.json",
  journeySchemaDigest:
    "evals/certifications/schemas/gate-b2-journey-evidence-v2.schema.json",
  journeyRunnerDigest: "scripts/quality/run-gate-b2-journey.mjs",
  chronicleAdapterDigest:
    "src/features/narrative-extraction/eval/productionChronicleAdapter.ts",
  chronicleScorerDigest:
    "src/features/narrative-extraction/eval/productionChronicleScoring.ts",
  webConsentJourneyDigest: "src/features/ai-policy/webAiConsent.live.test.tsx",
  webConsentBrowserJourneyDigest:
    "src/features/ai-policy/webAiConsent.gate-b2.browser.test.tsx",
  webConsentBrowserRunnerDigest:
    "scripts/quality/run-web-ai-consent-browser.mjs",
  webConsentBrowserConfigDigest:
    "vitest.gate-b2-web-ai-consent.config.ts",
  attemptLedgerSourceDigest: "scripts/quality/gate-b2-controller-config.mjs",
};

const INPUT_DIGEST_KEYS = [
  "writerRegistryDigest",
  "aiPathRegistryDigest",
  "qualityManifestDigest",
  "narrativeEvalManifestDigest",
  "adrChecklistDigest",
  "classificationDigest",
];

export function sha256Text(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Remove `VAR=...` placeholder assignments so parent env credentials are used. */
export function stripCredentialPlaceholders(commandString) {
  return String(commandString).replace(PLACEHOLDER_ENV_ASSIGN, "");
}

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function loadFreezeDocument(
  repoRoot,
  freezeRelativePath = FREEZE_RELATIVE,
) {
  const freezePath = path.isAbsolute(freezeRelativePath)
    ? freezeRelativePath
    : path.join(repoRoot, freezeRelativePath);
  if (!(await pathExists(freezePath))) return null;
  return JSON.parse(await readFile(freezePath, "utf8"));
}

export function assertFreezeActive(freeze) {
  if (!freeze) {
    throw new Error(
      `Freeze file missing at ${FREEZE_RELATIVE}; run pnpm certify:gate-b2:freeze first`,
    );
  }
  if (freeze.status === "superseded") {
    throw new Error(
      "Gate B2 candidate freeze is superseded; create a new freeze before certification",
    );
  }
  const identity = freeze.candidate ?? {};
  if (
    typeof freeze.freezeId !== "string" ||
    freeze.freezeId.length === 0 ||
    freeze.candidateCommitSha !== identity.commitSha ||
    freeze.candidateTreeSha !== identity.treeSha ||
    freeze.productSchemaVersion !== identity.schemaVersion
  ) {
    throw new Error(
      "Gate B2 freeze is missing the immutable certification epoch identity; create a new freeze",
    );
  }
  const expectedLedger = getGateB2AttemptLedgerIdentity();
  if (
    freeze.attemptLedgerId !== expectedLedger.attemptLedgerId ||
    (freeze.attemptLedgerConfigDigest ?? freeze.attemptLedgerDigest) !==
      expectedLedger.attemptLedgerConfigDigest ||
    freeze.attemptLedgerAttestation !==
      expectedLedger.attemptLedgerAttestation ||
    identity.attemptLedgerId !== expectedLedger.attemptLedgerId ||
    (identity.attemptLedgerConfigDigest ?? identity.attemptLedgerDigest) !==
      expectedLedger.attemptLedgerConfigDigest ||
    identity.attemptLedgerAttestation !==
      expectedLedger.attemptLedgerAttestation
  ) {
    throw new Error(
      "Gate B2 freeze is not bound to the fixed controller attempt ledger; create a new freeze",
    );
  }
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed: ${err || out}`));
        return;
      }
      resolve(out);
    });
  });
}

function runCommand(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${err || out}`));
        return;
      }
      resolve(out);
    });
  });
}

export async function assertWorkingTreeClean(repoRoot) {
  const status = await runGit(["status", "--porcelain"], repoRoot);
  if (status.length > 0) {
    throw new Error(
      "working tree is dirty; commit or stash before certification",
    );
  }
}

/**
 * Ensure execution tree matches freeze. Prefer detached worktree at frozen SHA.
 * Returns { executionRoot, cleanup, identity }.
 */
export async function bindExecutionRoot({
  repoRoot,
  candidateSha,
  freeze,
  requireTreeShaMatch = true,
  createWorktree = true,
}) {
  if (!candidateSha || !COMMIT_RE.test(candidateSha)) {
    throw new Error("candidate SHA required for certification binding");
  }
  if (!freeze?.candidate?.commitSha) {
    throw new Error(
      `Freeze file missing at ${FREEZE_RELATIVE}; run pnpm certify:gate-b2:freeze first`,
    );
  }
  if (freeze.candidate.commitSha !== candidateSha) {
    throw new Error(
      `Freeze commit ${freeze.candidate.commitSha} does not match --candidate ${candidateSha}`,
    );
  }

  const headSha = (await runGit(["rev-parse", "HEAD"], repoRoot)).toLowerCase();
  const headTree = (
    await runGit(["rev-parse", "HEAD^{tree}"], repoRoot)
  ).toLowerCase();
  const candidateTree = (
    await runGit(["rev-parse", `${candidateSha}^{tree}`], repoRoot)
  ).toLowerCase();

  if (requireTreeShaMatch && freeze.candidate.treeSha !== candidateTree) {
    throw new Error(
      `Freeze treeSha ${freeze.candidate.treeSha} does not match ${candidateSha}^{tree}=${candidateTree}`,
    );
  }

  // Fast path: already on frozen commit with clean tree — still verify digests later.
  const dirty = Boolean(
    await runGit(["status", "--porcelain"], repoRoot).then((out) => out.length),
  );

  if (
    createWorktree === false &&
    headSha === candidateSha &&
    headTree === freeze.candidate.treeSha &&
    !dirty
  ) {
    return {
      executionRoot: repoRoot,
      cleanup: async () => {},
      identity: {
        commitSha: candidateSha,
        treeSha: freeze.candidate.treeSha,
        dirty: false,
        boundVia: "head-match",
      },
    };
  }

  if (!createWorktree) {
    const mismatches = [];
    if (headSha !== candidateSha) {
      mismatches.push(`HEAD ${headSha} != candidate ${candidateSha}`);
    }
    if (headTree !== freeze.candidate.treeSha) {
      mismatches.push(
        `HEAD tree ${headTree} != freeze tree ${freeze.candidate.treeSha}`,
      );
    }
    if (dirty) mismatches.push("working tree dirty");
    throw new Error(
      `Execution tree is not bound to freeze (${mismatches.join("; ")}). Use detached worktree mode.`,
    );
  }

  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-wt-"));
  const worktreePath = path.join(temp, "tree");
  await runGit(
    ["worktree", "add", "--detach", worktreePath, candidateSha],
    repoRoot,
  );
  return {
    executionRoot: worktreePath,
    cleanup: async () => {
      try {
        await runGit(["worktree", "remove", "--force", worktreePath], repoRoot);
      } catch {
        // best-effort
      }
      await rm(temp, { recursive: true, force: true });
    },
    identity: {
      commitSha: candidateSha,
      treeSha: freeze.candidate.treeSha,
      dirty: false,
      boundVia: "detached-worktree",
    },
  };
}

/**
 * Bind freeze input reads to the candidate tree itself. Freeze metadata lives
 * outside the candidate, but its digests must never come from the current
 * checkout when --candidate points at another commit.
 */
export async function bindCandidateDigestRoot({ repoRoot, candidateSha }) {
  if (!candidateSha || !COMMIT_RE.test(candidateSha)) {
    throw new Error("candidate SHA required for candidate digest binding");
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-freeze-wt-"));
  const worktreePath = path.join(temp, "tree");
  try {
    await runGit(
      ["worktree", "add", "--detach", worktreePath, candidateSha],
      repoRoot,
    );
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  return {
    executionRoot: worktreePath,
    cleanup: async () => {
      try {
        await runGit(["worktree", "remove", "--force", worktreePath], repoRoot);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    },
  };
}

function safeAttemptPathSegment(value) {
  const segment = String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!segment || segment === "." || segment === "..") {
    throw new Error(`invalid Gate B2 suite id for attempt ledger: ${value}`);
  }
  return segment;
}

function requireCandidateIdentity(value, field) {
  if (!new RegExp(`^[0-9a-f]{40}$`).test(String(value ?? ""))) {
    throw new Error(`invalid Gate B2 ${field} for attempt ledger`);
  }
  return String(value);
}

const ATTEMPT_RESULT_VALUES = new Set([
  "passed",
  "failed",
  "blocked",
  "hold",
  "not-run",
  "deferred",
  "informational",
]);

function canonicalLedgerDigest(value) {
  return sha256Text(canonicalizeGateB2LedgerValue(value));
}

function gateB2LedgerGenesisDigest({ configDigest, instanceId, receiptDigest }) {
  return canonicalLedgerDigest({
    type: "gate-b2-ledger-genesis",
    configDigest,
    instanceId,
    receiptDigest,
  });
}

function attemptRecordDigest(record) {
  const { recordDigest: _recordDigest, ...recordBody } = record;
  return canonicalLedgerDigest({
    previousRecordDigest: record.previousRecordDigest,
    record: recordBody,
  });
}

function reservationDigest(reservation) {
  const { reservationDigest: _reservationDigest, ...reservationBody } =
    reservation;
  return canonicalLedgerDigest({
    type: "gate-b2-attempt-reservation",
    reservation: reservationBody,
  });
}

function sortLedgerRecords(left, right) {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  if (left.suiteId !== right.suiteId) {
    return left.suiteId.localeCompare(right.suiteId);
  }
  return left.attempt - right.attempt;
}

async function assertRealDirectory(target, label) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Gate B2 attempt ledger ${label} is not provisioned`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Gate B2 attempt ledger ${label} must be a real directory`);
  }
  const resolved = await realpath(target);
  if (resolved !== path.resolve(target)) {
    throw new Error(`Gate B2 attempt ledger ${label} realpath mismatch`);
  }
}

async function readProvisionedLedgerRoot(ledgerRoot) {
  if (!ledgerRoot) {
    throw new Error("Gate B2 attempt ledger root is required");
  }
  const root = path.resolve(String(ledgerRoot));
  await assertRealDirectory(root, "root");
  const metadataPath = path.join(root, GATE_B2_ATTEMPT_LEDGER_METADATA_FILE);
  let metadataStat;
  try {
    metadataStat = await lstat(metadataPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "Gate B2 attempt ledger metadata is missing; controller provisioning is required",
      );
    }
    throw error;
  }
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
    throw new Error("Gate B2 attempt ledger metadata must be a real file");
  }
  if ((await realpath(metadataPath)) !== metadataPath) {
    throw new Error("Gate B2 attempt ledger metadata realpath mismatch");
  }

  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`invalid Gate B2 attempt ledger metadata: ${error.message}`);
  }
  const config = getGateB2AttemptLedgerConfig();
  const requiredStrings = [
    "ledgerInstanceId",
    "controllerId",
    "createdAt",
    "publicKeyId",
    "controllerSignature",
    "controllerReceiptDigest",
  ];
  if (
    metadata?.schemaVersion !== GATE_B2_ATTEMPT_LEDGER_SCHEMA_VERSION ||
    metadata?.ledgerId !== config.ledgerId ||
    metadata?.controllerId !== config.controllerId ||
    requiredStrings.some(
      (field) => typeof metadata?.[field] !== "string" || !metadata[field],
    ) ||
    Number.isNaN(Date.parse(metadata.createdAt))
  ) {
    throw new Error("Gate B2 attempt ledger metadata does not match controller config");
  }
  const { controllerReceiptDigest, ...metadataBody } = metadata;
  if (canonicalLedgerDigest(metadataBody) !== controllerReceiptDigest) {
    throw new Error("Gate B2 attempt ledger controller receipt digest mismatch");
  }
  return {
    root,
    metadataPath,
    config,
    metadata,
    identity: {
      attemptLedgerId: config.ledgerId,
      attemptLedgerConfigDigest: config.attemptLedgerConfigDigest,
      attemptLedgerInstanceId: metadata.ledgerInstanceId,
      controllerReceiptDigest,
      attemptLedgerAttestation: config.attestation,
    },
  };
}

/**
 * Validate the controller-provisioned root without creating or repairing it.
 * The runner may create candidate/suite/attempt children only after this
 * function has established the root and metadata identity.
 */
export async function assertGateB2AttemptLedgerProvisioned({ ledgerRoot }) {
  return readProvisionedLedgerRoot(ledgerRoot);
}

export function gateB2AttemptLedgerKey({
  candidateCommitSha,
  candidateTreeSha,
  contractVersion,
}) {
  const commitSha = requireCandidateIdentity(
    candidateCommitSha,
    "candidate commit SHA",
  );
  const treeSha = requireCandidateIdentity(
    candidateTreeSha,
    "candidate tree SHA",
  );
  if (!Number.isSafeInteger(contractVersion) || contractVersion < 1) {
    throw new Error("invalid Gate B2 contract version for attempt ledger");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        candidateCommitSha: commitSha,
        candidateTreeSha: treeSha,
        contractVersion,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Reserve the next append-only attempt directory for one candidate/suite.
 * A non-recursive mkdir makes the reservation unique across processes; a
 * crashed process still consumes its directory and cannot be overwritten by a
 * later retry.
 */
export async function allocateGateB2Attempt({
  ledgerRoot,
  candidateCommitSha,
  candidateTreeSha,
  contractVersion = GATE_B2_CONTRACT_VERSION,
  suiteId,
}) {
  const provisioned = await readProvisionedLedgerRoot(ledgerRoot);
  const suiteSegment = safeAttemptPathSegment(suiteId);
  const candidateKey = gateB2AttemptLedgerKey({
    candidateCommitSha,
    candidateTreeSha,
    contractVersion,
  });
  const attemptsRoot = path.join(
    provisioned.root,
    "candidates",
    candidateKey,
    "attempts",
    suiteSegment,
  );
  const existingSnapshot = await loadGateB2AttemptLedgerSnapshot({
    ledgerRoot: provisioned.root,
    candidateCommitSha,
    candidateTreeSha,
    contractVersion,
  });
  await mkdir(attemptsRoot, { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    const attemptDir = path.join(attemptsRoot, `attempt-${attempt}`);
    try {
      await mkdir(attemptDir);
      const sequence = existingSnapshot.attemptLedgerMaxSequence + 1;
      const reservation = {
        schemaVersion: 1,
        contractVersion,
        ...provisioned.identity,
        candidateCommitSha,
        candidateTreeSha,
        suiteId,
        attempt,
        sequence,
        previousRecordDigest: existingSnapshot.attemptLedgerHeadDigest,
        reservedAt: new Date().toISOString(),
      };
      await writeFile(
        path.join(attemptDir, "reservation.json"),
        `${JSON.stringify(
          { ...reservation, reservationDigest: reservationDigest(reservation) },
          null,
          2,
        )}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      return {
        attempt,
        attemptDir,
        sequence,
        previousRecordDigest: existingSnapshot.attemptLedgerHeadDigest,
        ledgerSnapshot: existingSnapshot,
        ledgerIdentity: provisioned.identity,
      };
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
}

async function loadGateB2AttemptLedgerSnapshotInternal({
  ledgerRoot,
  candidateCommitSha,
  candidateTreeSha,
  contractVersion = GATE_B2_CONTRACT_VERSION,
  suiteBuckets = {},
}) {
  const provisioned = await readProvisionedLedgerRoot(ledgerRoot);
  const ledger = provisioned.identity;
  const genesisDigest = gateB2LedgerGenesisDigest({
    configDigest: ledger.attemptLedgerConfigDigest,
    instanceId: ledger.attemptLedgerInstanceId,
    receiptDigest: ledger.controllerReceiptDigest,
  });
  const candidateKey = gateB2AttemptLedgerKey({
    candidateCommitSha,
    candidateTreeSha,
    contractVersion,
  });
  const attemptsRoot = path.join(
    provisioned.root,
    "candidates",
    candidateKey,
    "attempts",
  );
  let suiteEntries;
  try {
    suiteEntries = await readdir(attemptsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ...ledger,
        attemptLedgerHeadDigest: genesisDigest,
        attemptHistoryDigest: canonicalLedgerDigest([]),
        attemptLedgerRecordCount: 0,
        attemptLedgerMaxSequence: 0,
        attemptLedgerDigest: canonicalLedgerDigest({
          configDigest: ledger.attemptLedgerConfigDigest,
          instanceId: ledger.attemptLedgerInstanceId,
          controllerReceiptDigest: ledger.controllerReceiptDigest,
          headDigest: genesisDigest,
          historyDigest: canonicalLedgerDigest([]),
          recordCount: 0,
          maxSequence: 0,
        }),
        history: [],
      };
    }
    throw error;
  }
  const history = [];
  for (const suiteEntry of suiteEntries) {
    if (suiteEntry.isSymbolicLink()) {
      throw new Error(`invalid Gate B2 attempt ledger symlink: ${suiteEntry.name}`);
    }
    if (!suiteEntry.isDirectory()) continue;
    const suiteDir = path.join(attemptsRoot, suiteEntry.name);
    const attemptEntries = await readdir(suiteDir, { withFileTypes: true });
    for (const attemptEntry of attemptEntries) {
      if (attemptEntry.isSymbolicLink()) {
        throw new Error(`invalid Gate B2 attempt ledger symlink: ${attemptEntry.name}`);
      }
      if (!attemptEntry.isDirectory() || !/^attempt-[1-9][0-9]*$/.test(attemptEntry.name)) {
        continue;
      }
      const attempt = Number(attemptEntry.name.slice("attempt-".length));
      const attemptDir = path.join(suiteDir, attemptEntry.name);
      const recordPath = path.join(attemptDir, "attempt.json");
      const reservationPath = path.join(attemptDir, "reservation.json");
      let reservation;
      try {
        reservation = JSON.parse(await readFile(reservationPath, "utf8"));
      } catch (error) {
        throw new Error(`invalid Gate B2 attempt reservation: ${reservationPath}`);
      }
      if (
        reservation.attemptLedgerId !== ledger.attemptLedgerId ||
        reservation.attemptLedgerConfigDigest !==
          ledger.attemptLedgerConfigDigest ||
        reservation.attemptLedgerInstanceId !==
          ledger.attemptLedgerInstanceId ||
        reservation.controllerReceiptDigest !== ledger.controllerReceiptDigest ||
        reservation.attemptLedgerAttestation !== ledger.attemptLedgerAttestation ||
        reservation.candidateCommitSha !== candidateCommitSha ||
        reservation.candidateTreeSha !== candidateTreeSha ||
        reservation.contractVersion !== contractVersion ||
        safeAttemptPathSegment(reservation.suiteId) !== suiteEntry.name ||
        reservation.attempt !== attempt ||
        !Number.isInteger(reservation.sequence) ||
        reservation.sequence < 1 ||
        reservation.previousRecordDigest === undefined ||
        reservation.reservationDigest !== reservationDigest(reservation)
      ) {
        throw new Error(`invalid Gate B2 attempt reservation: ${reservationPath}`);
      }
      let record;
      try {
        record = JSON.parse(await readFile(recordPath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") {
          history.push({
            schemaVersion: 1,
            contractVersion,
            ...ledger,
            candidateCommitSha,
            candidateTreeSha,
            suiteId: suiteEntry.name,
            bucket: suiteBuckets[suiteEntry.name] ?? "requiredHeavy",
            attempt,
            sequence: reservation.sequence,
            previousRecordDigest: reservation.previousRecordDigest,
            recordDigest: reservation.reservationDigest,
            result: "blocked",
            message: "attempt reservation has no completed record",
          });
          continue;
        }
        throw error;
      }
      if (
        record.candidateCommitSha !== candidateCommitSha ||
        record.candidateTreeSha !== candidateTreeSha ||
        record.contractVersion !== contractVersion ||
        record.attemptLedgerId !== ledger.attemptLedgerId ||
        record.attemptLedgerConfigDigest !== ledger.attemptLedgerConfigDigest ||
        record.attemptLedgerInstanceId !== ledger.attemptLedgerInstanceId ||
        record.controllerReceiptDigest !== ledger.controllerReceiptDigest ||
        record.attemptLedgerAttestation !== ledger.attemptLedgerAttestation ||
        safeAttemptPathSegment(record.suiteId) !== suiteEntry.name ||
        !Number.isInteger(record.attempt) ||
        record.attempt !== attempt ||
        record.sequence !== reservation.sequence ||
        record.previousRecordDigest !== reservation.previousRecordDigest ||
        !ATTEMPT_RESULT_VALUES.has(record.result) ||
        record.recordDigest !== attemptRecordDigest(record) ||
        record.recordDigest === reservation.reservationDigest
      ) {
        throw new Error(`invalid Gate B2 attempt record: ${recordPath}`);
      }
      history.push(record);
    }
  }
  const chain = [...history].sort(sortLedgerRecords);
  let previousDigest = genesisDigest;
  let expectedSequence = 1;
  const seenSequences = new Set();
  for (const record of chain) {
    if (seenSequences.has(record.sequence)) {
      throw new Error(`duplicate Gate B2 attempt sequence: ${record.sequence}`);
    }
    seenSequences.add(record.sequence);
    if (record.sequence !== expectedSequence) {
      throw new Error(
        `non-contiguous Gate B2 attempt sequence: expected ${expectedSequence}, got ${record.sequence}`,
      );
    }
    if (record.previousRecordDigest !== previousDigest) {
      throw new Error(`broken Gate B2 attempt hash chain at sequence ${record.sequence}`);
    }
    previousDigest = record.recordDigest;
    expectedSequence += 1;
  }
  const historyDigest = canonicalLedgerDigest(
    chain.map((record) => ({
      suiteId: record.suiteId,
      attempt: record.attempt,
      sequence: record.sequence,
      result: record.result,
      recordDigest: record.recordDigest,
    })),
  );
  const maxSequence = chain.at(-1)?.sequence ?? 0;
  const stateDigest = canonicalLedgerDigest({
    configDigest: ledger.attemptLedgerConfigDigest,
    instanceId: ledger.attemptLedgerInstanceId,
    controllerReceiptDigest: ledger.controllerReceiptDigest,
    headDigest: previousDigest,
    historyDigest,
    recordCount: chain.length,
    maxSequence,
  });
  history.sort((left, right) => {
    if (left.suiteId !== right.suiteId) return left.suiteId.localeCompare(right.suiteId);
    return left.attempt - right.attempt;
  });
  return {
    ...ledger,
    attemptLedgerHeadDigest: previousDigest,
    attemptHistoryDigest: historyDigest,
    attemptLedgerRecordCount: chain.length,
    attemptLedgerMaxSequence: maxSequence,
    attemptLedgerDigest: stateDigest,
    history,
  };
}

export async function loadGateB2AttemptLedgerSnapshot(options) {
  return loadGateB2AttemptLedgerSnapshotInternal(options);
}

export async function loadGateB2AttemptHistory(options) {
  const snapshot = await loadGateB2AttemptLedgerSnapshotInternal(options);
  return snapshot.history;
}

export async function writeGateB2AttemptRecord({ attemptDir, record }) {
  const reservationPath = path.join(attemptDir, "reservation.json");
  let reservation;
  try {
    reservation = JSON.parse(await readFile(reservationPath, "utf8"));
  } catch (error) {
    throw new Error(`Gate B2 attempt reservation missing: ${reservationPath}`);
  }
  if (
    record.attempt !== reservation.attempt ||
    record.sequence !== reservation.sequence ||
    record.previousRecordDigest !== reservation.previousRecordDigest
  ) {
    throw new Error("Gate B2 attempt record does not match its reservation");
  }
  const enriched = {
    ...record,
    recordDigest: attemptRecordDigest(record),
  };
  if (record.recordDigest && record.recordDigest !== enriched.recordDigest) {
    throw new Error("Gate B2 attempt record digest mismatch");
  }
  const recordPath = path.join(attemptDir, "attempt.json");
  await writeFile(recordPath, `${JSON.stringify(enriched, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return recordPath;
}

export function assertDigestsMatchFreeze(
  currentDigests,
  freezeCandidate,
  freezeMeta = {},
) {
  const errors = [];
  const contractVersion =
    freezeMeta.contractVersion ?? freezeCandidate?.contractVersion;
  if (
    contractVersion !== undefined &&
    contractVersion !== GATE_B2_CONTRACT_VERSION
  ) {
    errors.push(
      `contractVersion: freeze=${contractVersion} expected=${GATE_B2_CONTRACT_VERSION}`,
    );
  }

  for (const key of Object.keys(HARNESS_DIGEST_PATHS)) {
    const expected = freezeCandidate?.[key];
    if (!expected) {
      errors.push(`${key}: missing in freeze`);
      continue;
    }
    const actual = currentDigests?.[key];
    if (actual !== expected) {
      errors.push(`${key}: freeze=${expected} current=${actual ?? "missing"}`);
    }
  }

  for (const key of INPUT_DIGEST_KEYS) {
    const expected = freezeCandidate?.[key];
    if (!expected) continue;
    const actual = currentDigests?.[key];
    if (actual !== expected) {
      errors.push(`${key}: freeze=${expected} current=${actual ?? "missing"}`);
    }
  }

  return errors;
}

export function sanitizeCertificationEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  // Full certification must not use partial/diagnostic overrides.
  delete env.NARRATIVE_EVAL_LIMIT;
  delete env.NARRATIVE_EVAL_CASE_ID;
  delete env.NARRATIVE_EVAL_ATTEMPT;
  // The attempt ledger is controller-bound; never forward the retired
  // caller-selected override into a suite runner.
  delete env.GATE_B2_ATTEMPT_LEDGER_ROOT;
  // Preserve GATE_B2_* binding vars for heavy suite runners.
  return env;
}

export function buildHeavyCertificationEnv({
  candidate,
  suiteId,
  runId,
  outputPath,
  commandDigest,
  freezeId,
  certificationRunId,
  attempt,
  attemptDir,
  ledgerSnapshot = null,
  baseEnv = process.env,
}) {
  const ledger = ledgerSnapshot ?? getGateB2AttemptLedgerIdentity();
  const env = {
    ...sanitizeCertificationEnv(baseEnv),
    GATE_B2_CANDIDATE_COMMIT_SHA: candidate.commitSha,
    GATE_B2_CANDIDATE_TREE_SHA: candidate.treeSha,
    GATE_B2_SUITE_ID: suiteId,
    GATE_B2_RUN_ID: runId,
    GATE_B2_OUTPUT_PATH: outputPath,
    GATE_B2_COMMAND_DIGEST: commandDigest,
    GATE_B2_ATTEMPT_LEDGER_ID: ledger.attemptLedgerId,
    GATE_B2_ATTEMPT_LEDGER_CONFIG_DIGEST:
      ledger.attemptLedgerConfigDigest,
    GATE_B2_ATTEMPT_LEDGER_DIGEST:
      ledger.attemptLedgerDigest ?? ledger.attemptLedgerConfigDigest,
    GATE_B2_ATTEMPT_LEDGER_INSTANCE_ID: ledger.attemptLedgerInstanceId ?? "",
    GATE_B2_ATTEMPT_LEDGER_HEAD_DIGEST: ledger.attemptLedgerHeadDigest ?? "",
    GATE_B2_ATTEMPT_HISTORY_DIGEST: ledger.attemptHistoryDigest ?? "",
    GATE_B2_ATTEMPT_LEDGER_RECORD_COUNT: String(
      ledger.attemptLedgerRecordCount ?? 0,
    ),
    GATE_B2_ATTEMPT_LEDGER_MAX_SEQUENCE: String(
      ledger.attemptLedgerMaxSequence ?? 0,
    ),
    GATE_B2_CONTROLLER_RECEIPT_DIGEST: ledger.controllerReceiptDigest ?? "",
    GATE_B2_ATTEMPT_LEDGER_ATTESTATION: ledger.attemptLedgerAttestation,
  };
  if (freezeId) env.GATE_B2_FREEZE_ID = freezeId;
  if (certificationRunId) {
    env.GATE_B2_CERTIFICATION_RUN_ID = certificationRunId;
  }
  if (Number.isInteger(attempt)) env.GATE_B2_ATTEMPT = String(attempt);
  if (attemptDir) env.GATE_B2_ATTEMPT_DIR = attemptDir;
  return env;
}

export function buildJourneyCertificationEnv({
  candidate,
  journeyId,
  outputPath,
  runnerArtifactPath,
  commandDigest,
  environmentDigest,
  runnerId,
  runnerVersion,
  freezeId,
  certificationRunId,
  attempt,
  attemptDir,
  ledgerSnapshot = null,
  baseEnv = process.env,
}) {
  const ledger = ledgerSnapshot ?? getGateB2AttemptLedgerIdentity();
  const env = {
    ...sanitizeCertificationEnv(baseEnv),
    GATE_B2_CANDIDATE_COMMIT_SHA: candidate.commitSha,
    GATE_B2_CANDIDATE_TREE_SHA: candidate.treeSha,
    GATE_B2_SUITE_ID: journeyId,
    GATE_B2_OUTPUT_PATH: outputPath,
    GATE_B2_RUNNER_ARTIFACT_PATH: runnerArtifactPath,
    GATE_B2_COMMAND_DIGEST: commandDigest,
    GATE_B2_ENVIRONMENT_DIGEST: environmentDigest,
    GATE_B2_RUNNER_ID: runnerId,
    GATE_B2_RUNNER_VERSION: String(runnerVersion),
    GATE_B2_ATTEMPT_LEDGER_ID: ledger.attemptLedgerId,
    GATE_B2_ATTEMPT_LEDGER_CONFIG_DIGEST:
      ledger.attemptLedgerConfigDigest,
    GATE_B2_ATTEMPT_LEDGER_DIGEST:
      ledger.attemptLedgerDigest ?? ledger.attemptLedgerConfigDigest,
    GATE_B2_ATTEMPT_LEDGER_INSTANCE_ID: ledger.attemptLedgerInstanceId ?? "",
    GATE_B2_ATTEMPT_LEDGER_HEAD_DIGEST: ledger.attemptLedgerHeadDigest ?? "",
    GATE_B2_ATTEMPT_HISTORY_DIGEST: ledger.attemptHistoryDigest ?? "",
    GATE_B2_ATTEMPT_LEDGER_RECORD_COUNT: String(
      ledger.attemptLedgerRecordCount ?? 0,
    ),
    GATE_B2_ATTEMPT_LEDGER_MAX_SEQUENCE: String(
      ledger.attemptLedgerMaxSequence ?? 0,
    ),
    GATE_B2_CONTROLLER_RECEIPT_DIGEST: ledger.controllerReceiptDigest ?? "",
    GATE_B2_ATTEMPT_LEDGER_ATTESTATION: ledger.attemptLedgerAttestation,
    GATE_B2_FREEZE_ID: freezeId,
    GATE_B2_CERTIFICATION_RUN_ID: certificationRunId,
    GATE_B2_ATTEMPT: String(attempt),
  };
  if (attemptDir) env.GATE_B2_ATTEMPT_DIR = attemptDir;
  return env;
}

const FULL_CI_REQUIRED = [
  "commitSha",
  "treeSha",
  "workflowId",
  "runId",
  "runAttempt",
  "conclusion",
  "requiredJobs",
];

function requiredJobsMatchContract(evidenceJobs, contractJobs) {
  const evidence = [...evidenceJobs].sort();
  const contract = [...contractJobs].sort();
  if (evidence.length !== contract.length) return false;
  return evidence.every((job, index) => job === contract[index]);
}

/**
 * Validate full-ci evidence structure and candidate binding.
 * When `contract` is provided, `raw.requiredJobs` must equal `contract.requiredJobs`
 * exactly (same set; order may differ).
 */
export function validateFullCiEvidence(raw, candidate, contract) {
  const missing = FULL_CI_REQUIRED.filter((key) => {
    if (key === "requiredJobs") {
      return !Array.isArray(raw.requiredJobs) || raw.requiredJobs.length === 0;
    }
    return raw[key] === undefined || raw[key] === null || raw[key] === "";
  });
  if (missing.length > 0) {
    return {
      ok: false,
      result: "failed",
      message: `full-ci evidence missing required fields: ${missing.join(", ")}`,
    };
  }
  if (raw.commitSha !== candidate.commitSha) {
    return {
      ok: false,
      result: "failed",
      message: `full-ci commitSha ${raw.commitSha} != candidate ${candidate.commitSha}`,
    };
  }
  if (raw.treeSha !== candidate.treeSha) {
    return {
      ok: false,
      result: "failed",
      message: `full-ci treeSha ${raw.treeSha} != candidate ${candidate.treeSha}`,
    };
  }
  const conclusion = String(raw.conclusion).toLowerCase();
  if (conclusion !== "success" && conclusion !== "passed") {
    return {
      ok: false,
      result: "failed",
      message: `full-ci conclusion is ${conclusion}`,
    };
  }
  if (
    contract?.requiredJobs &&
    !requiredJobsMatchContract(raw.requiredJobs, contract.requiredJobs)
  ) {
    return {
      ok: false,
      result: "failed",
      message:
        "full-ci evidence requiredJobs must match contract requiredJobs exactly",
    };
  }
  // checkoutCommitSha/checkoutTreeSha are optional in evidence; when present they
  // are consistency-checked against the downloaded artifact in verifyFullCiWithGithub.
  return { ok: true, result: "passed", message: "full-ci evidence accepted" };
}

export function checkoutIdentityArtifactName(runId, runAttempt) {
  return `checkout-identity-${runId}-${runAttempt}`;
}

export function buildGhRunDownloadArgs({ runId, slug, artifactName, dir }) {
  return [
    "run",
    "download",
    String(runId),
    "--repo",
    slug,
    "--name",
    artifactName,
    "--dir",
    dir,
  ];
}

export async function listRunArtifacts({
  slug,
  runId,
  repoRoot,
  runGh = runCommand,
}) {
  const artifacts = [];
  let page = 1;
  for (;;) {
    const listJson = await runGh(
      "gh",
      [
        "api",
        `repos/${slug}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
      ],
      repoRoot,
    );
    const batch = JSON.parse(listJson).artifacts ?? [];
    artifacts.push(...batch);
    if (batch.length < 100) break;
    page += 1;
    if (page > 50) {
      throw new Error("artifact listing exceeded pagination safety limit");
    }
  }
  return artifacts;
}

async function findCheckoutIdentityJsonFiles(rootDir) {
  const matches = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name === "checkout-identity.json") {
        matches.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return matches;
}

/**
 * Download and parse the CI checkout-identity GitHub Actions artifact.
 * Uses `gh run download` (supported) rather than unsupported `gh api --output`.
 */
export async function fetchCheckoutIdentityArtifact({
  repoRoot,
  runId,
  runAttempt,
  slug: slugOverride,
  runGh = runCommand,
  downloadCheckoutIdentity = null,
}) {
  const slug = slugOverride ?? (await resolveGithubRepoSlug(repoRoot));
  const artifactName = checkoutIdentityArtifactName(runId, runAttempt);
  const artifacts = await listRunArtifacts({
    slug,
    runId,
    repoRoot,
    runGh,
  });
  const matching = artifacts.filter((entry) => entry.name === artifactName);
  if (matching.length === 0) {
    throw new Error(`no checkout-identity artifact named ${artifactName}`);
  }
  if (matching.length > 1) {
    throw new Error(
      `expected exactly one checkout-identity artifact named ${artifactName}, found ${matching.length}`,
    );
  }
  const artifact = matching[0];

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gate-b2-artifact-"));
  try {
    if (downloadCheckoutIdentity) {
      await downloadCheckoutIdentity({
        slug,
        runId,
        artifactName,
        artifactId: artifact.id,
        dir: tempDir,
        repoRoot,
      });
    } else {
      const args = buildGhRunDownloadArgs({
        runId,
        slug,
        artifactName,
        dir: tempDir,
      });
      if (args.includes("--output")) {
        throw new Error("internal error: unsupported gh flag --output");
      }
      await runGh("gh", args, repoRoot);
    }

    const jsonFiles = await findCheckoutIdentityJsonFiles(tempDir);
    if (jsonFiles.length === 0) {
      throw new Error(
        "checkout-identity.json not found in downloaded artifact",
      );
    }
    if (jsonFiles.length > 1) {
      throw new Error(
        `expected exactly one checkout-identity.json, found ${jsonFiles.length}`,
      );
    }
    const jsonBytes = await readFile(jsonFiles[0]);
    const identity = JSON.parse(jsonBytes.toString("utf8"));
    if (!identity.commitSha || !identity.treeSha) {
      throw new Error("checkout-identity.json missing commitSha or treeSha");
    }
    const artifactDigest = `sha256:${createHash("sha256")
      .update(jsonBytes)
      .digest("hex")}`;
    return {
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactDigest,
      identity,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function resolveGithubRepoSlug(repoRoot) {
  try {
    const json = await runCommand(
      "gh",
      ["repo", "view", "--json", "nameWithOwner"],
      repoRoot,
    );
    const parsed = JSON.parse(json);
    if (parsed?.nameWithOwner) return parsed.nameWithOwner;
  } catch {
    // fall through to git remote
  }
  const remoteUrl = await runGit(["remote", "get-url", "origin"], repoRoot);
  const sshMatch = remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = remoteUrl.match(
    /^https:\/\/github\.com\/(.+?)(?:\.git)?$/,
  );
  if (httpsMatch) return httpsMatch[1];
  throw new Error(
    `unable to resolve GitHub repo slug from origin: ${remoteUrl}`,
  );
}

async function defaultFetchGithubRun(runId, { repoRoot, raw }) {
  const slug = await resolveGithubRepoSlug(repoRoot);
  const runJson = await runCommand(
    "gh",
    ["api", `repos/${slug}/actions/runs/${runId}`],
    repoRoot,
  );
  const jobsJson = await runCommand(
    "gh",
    ["api", `repos/${slug}/actions/runs/${runId}/jobs`],
    repoRoot,
  );
  return {
    run: JSON.parse(runJson),
    jobs: JSON.parse(jobsJson).jobs ?? [],
    raw,
  };
}

function workflowPathMatches(runPath, contractPath) {
  const normalizedRunPath = String(runPath);
  const normalizedContractPath = String(contractPath);
  return (
    normalizedRunPath === normalizedContractPath ||
    normalizedRunPath.endsWith(normalizedContractPath)
  );
}

export async function verifyFullCiWithGithub(
  raw,
  candidate,
  { fetchRun, fetchCheckoutIdentity, repoRoot, fullCiContract } = {},
) {
  const base = validateFullCiEvidence(raw, candidate, fullCiContract);
  if (!base.ok) return base;

  if (
    fullCiContract?.requiredJobs &&
    Array.isArray(raw.requiredJobs) &&
    !requiredJobsMatchContract(raw.requiredJobs, fullCiContract.requiredJobs)
  ) {
    return {
      ok: false,
      result: "failed",
      message:
        "full-ci evidence requiredJobs must match contract requiredJobs exactly",
    };
  }

  try {
    const resolvedRepoRoot = repoRoot ?? process.cwd();
    const payload = await (fetchRun ?? defaultFetchGithubRun)(raw.runId, {
      repoRoot: resolvedRepoRoot,
      raw,
    });
    const run = payload.run ?? payload;
    const jobs = payload.jobs ?? run.jobs ?? [];

    if (String(run.head_sha).toLowerCase() !== candidate.commitSha) {
      return {
        ok: false,
        result: "failed",
        message: `github run head_sha ${run.head_sha} != candidate ${candidate.commitSha}`,
      };
    }
    if (Number(run.run_attempt) !== Number(raw.runAttempt)) {
      return {
        ok: false,
        result: "failed",
        message: `github run_attempt ${run.run_attempt} != evidence ${raw.runAttempt}`,
      };
    }
    const runConclusion = String(run.conclusion ?? run.status).toLowerCase();
    if (runConclusion !== "success") {
      return {
        ok: false,
        result: "failed",
        message: `github run conclusion is ${runConclusion}`,
      };
    }

    if (fullCiContract) {
      if (Number(run.workflow_id) !== Number(fullCiContract.workflowId)) {
        return {
          ok: false,
          result: "failed",
          message: `github workflow_id ${run.workflow_id} != contract ${fullCiContract.workflowId}`,
        };
      }
      if (!workflowPathMatches(run.path, fullCiContract.workflowPath)) {
        return {
          ok: false,
          result: "failed",
          message: `github workflow path ${run.path} != contract ${fullCiContract.workflowPath}`,
        };
      }
      const event = String(run.event);
      if (!fullCiContract.acceptedEvents.includes(event)) {
        return {
          ok: false,
          result: "failed",
          message: `github event ${event} not in acceptedEvents`,
        };
      }
    }

    const requiredJobs = fullCiContract?.requiredJobs ?? raw.requiredJobs;
    for (const requiredJob of requiredJobs) {
      const job = jobs.find((entry) => entry.name === requiredJob);
      if (!job) {
        return {
          ok: false,
          result: "failed",
          message: `github run missing required job ${requiredJob}`,
        };
      }
      const jobConclusion = String(job.conclusion ?? job.status).toLowerCase();
      if (jobConclusion !== "success") {
        return {
          ok: false,
          result: "failed",
          message: `github job ${requiredJob} conclusion is ${jobConclusion}`,
        };
      }
    }

    if (fullCiContract?.requireCheckoutIdentityArtifact) {
      const slug = await resolveGithubRepoSlug(resolvedRepoRoot);
      const fetcher = fetchCheckoutIdentity ?? fetchCheckoutIdentityArtifact;
      const checkout = await fetcher({
        repoRoot: resolvedRepoRoot,
        runId: raw.runId,
        runAttempt: raw.runAttempt,
        slug,
      });
      const artifactCommit = String(checkout.identity.commitSha).toLowerCase();
      const artifactTree = String(checkout.identity.treeSha).toLowerCase();
      if (artifactCommit !== candidate.commitSha) {
        return {
          ok: false,
          result: "failed",
          message: `checkout-identity commitSha ${artifactCommit} != candidate ${candidate.commitSha}`,
        };
      }
      if (artifactTree !== candidate.treeSha) {
        return {
          ok: false,
          result: "failed",
          message: `checkout-identity treeSha ${artifactTree} != candidate ${candidate.treeSha}`,
        };
      }
      if (raw.checkoutCommitSha) {
        const evidenceCommit = String(raw.checkoutCommitSha).toLowerCase();
        if (evidenceCommit !== artifactCommit) {
          return {
            ok: false,
            result: "failed",
            message: `evidence checkoutCommitSha ${evidenceCommit} != artifact ${artifactCommit}`,
          };
        }
      }
      if (raw.checkoutTreeSha) {
        const evidenceTree = String(raw.checkoutTreeSha).toLowerCase();
        if (evidenceTree !== artifactTree) {
          return {
            ok: false,
            result: "failed",
            message: `evidence checkoutTreeSha ${evidenceTree} != artifact ${artifactTree}`,
          };
        }
      }
      return {
        ok: true,
        result: "passed",
        message: "full-ci github evidence verified",
        checkoutArtifactId: checkout.artifactId,
        checkoutArtifactDigest: checkout.artifactDigest,
        checkoutCommitSha: artifactCommit,
        checkoutTreeSha: artifactTree,
      };
    }

    return {
      ok: true,
      result: "passed",
      message: "full-ci github evidence verified",
    };
  } catch (error) {
    return {
      ok: false,
      result: "failed",
      message: `full-ci github verify failed: ${error.message}`,
    };
  }
}

const JOURNEY_REQUIRED = [
  "schemaVersion",
  "journeyId",
  "candidateCommitSha",
  "candidateTreeSha",
  "freezeId",
  "certificationRunId",
  "runnerId",
  "runnerVersion",
  "environmentDigest",
  "commandDigest",
  "runnerArtifactDigest",
  "assertions",
  "result",
  "startedAt",
  "completedAt",
  "artifactDigests",
];

export function validateJourneyEvidence(
  raw,
  { journeyId, candidate, contract, expected = {} },
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      result: "failed",
      message: "journey evidence must be an object",
    };
  }
  const missing = JOURNEY_REQUIRED.filter((key) => {
    if (key === "assertions") {
      return !Array.isArray(raw.assertions) || raw.assertions.length === 0;
    }
    if (key === "artifactDigests") {
      return !Array.isArray(raw.artifactDigests) || raw.artifactDigests.length === 0;
    }
    return raw[key] === undefined || raw[key] === null || raw[key] === "";
  });
  if (missing.length > 0) {
    return {
      ok: false,
      result: "failed",
      message: `journey evidence missing required fields: ${missing.join(", ")}`,
    };
  }
  if (raw.schemaVersion !== 2) {
    return {
      ok: false,
      result: "failed",
      message: "journey schemaVersion must be 2",
    };
  }
  if (raw.journeyId !== journeyId) {
    return {
      ok: false,
      result: "failed",
      message: `journeyId ${raw.journeyId} != manifest ${journeyId}`,
    };
  }
  if (raw.candidateCommitSha !== candidate.commitSha) {
    return {
      ok: false,
      result: "failed",
      message: "journey candidateCommitSha mismatch",
    };
  }
  if (raw.candidateTreeSha !== candidate.treeSha) {
    return {
      ok: false,
      result: "failed",
      message: "journey candidateTreeSha mismatch",
    };
  }
  if (!SHA256_RE.test(String(raw.environmentDigest))) {
    return {
      ok: false,
      result: "failed",
      message: "journey environmentDigest must be sha256:...",
    };
  }
  for (const [key, label] of [
    ["commandDigest", "commandDigest"],
    ["runnerArtifactDigest", "runnerArtifactDigest"],
  ]) {
    if (!SHA256_RE.test(String(raw[key]))) {
      return {
        ok: false,
        result: "failed",
        message: `journey ${label} must be sha256:...`,
      };
    }
  }
  if (!raw.artifactDigests.every((digest) => SHA256_RE.test(String(digest)))) {
    return {
      ok: false,
      result: "failed",
      message: "journey artifactDigests must contain sha256:... values",
    };
  }
  if (!raw.artifactDigests.includes(raw.runnerArtifactDigest)) {
    return {
      ok: false,
      result: "failed",
      message: "journey artifactDigests must include runnerArtifactDigest",
    };
  }

  if (expected.freezeId !== undefined && raw.freezeId !== expected.freezeId) {
    return {
      ok: false,
      result: "failed",
      message: "journey freezeId mismatch",
    };
  }
  if (
    expected.certificationRunId !== undefined &&
    raw.certificationRunId !== expected.certificationRunId
  ) {
    return {
      ok: false,
      result: "failed",
      message: "journey certificationRunId mismatch",
    };
  }
  if (expected.commandDigest !== undefined && raw.commandDigest !== expected.commandDigest) {
    return {
      ok: false,
      result: "failed",
      message: "journey commandDigest mismatch",
    };
  }
  if (
    expected.runnerArtifactDigest !== undefined &&
    raw.runnerArtifactDigest !== expected.runnerArtifactDigest
  ) {
    return {
      ok: false,
      result: "failed",
      message: "journey runnerArtifactDigest mismatch",
    };
  }
  if (
    expected.environmentDigest !== undefined &&
    raw.environmentDigest !== expected.environmentDigest
  ) {
    return {
      ok: false,
      result: "failed",
      message: "journey environmentDigest mismatch",
    };
  }

  if (
    !raw.assertions.every(
      (assertion) =>
        assertion &&
        typeof assertion.id === "string" &&
        typeof assertion.passed === "boolean",
    )
  ) {
    return {
      ok: false,
      result: "failed",
      message: "journey assertions must all have id and boolean passed",
    };
  }

  if (contract) {
    if (raw.runnerId !== contract.runnerId) {
      return {
        ok: false,
        result: "failed",
        message: `journey runnerId ${raw.runnerId} != contract ${contract.runnerId}`,
      };
    }
    if (String(raw.runnerVersion) !== String(contract.runnerVersion)) {
      return {
        ok: false,
        result: "failed",
        message: `journey runnerVersion ${raw.runnerVersion} != contract ${contract.runnerVersion}`,
      };
    }
    const actualIds = raw.assertions.map((assertion) => assertion.id);
    const requiredIds = contract.requiredAssertions ?? [];
    if (actualIds.length !== requiredIds.length) {
      return {
        ok: false,
        result: "failed",
        message: `journey assertions count ${actualIds.length} != contract ${requiredIds.length}`,
      };
    }
    for (const id of requiredIds) {
      if (!actualIds.includes(id)) {
        return {
          ok: false,
          result: "failed",
          message: `journey missing required assertion ${id}`,
        };
      }
    }
    const extra = actualIds.filter((id) => !requiredIds.includes(id));
    if (extra.length > 0) {
      return {
        ok: false,
        result: "failed",
        message: `journey has unexpected assertions: ${extra.join(", ")}`,
      };
    }
  }

  const result = String(raw.result).toLowerCase();
  if (result === "passed") {
    if (!raw.assertions.every((assertion) => assertion.passed === true)) {
      return {
        ok: false,
        result: "failed",
        message: "passed Journey evidence must have passed:true for every assertion",
      };
    }
    return { ok: true, result: "passed", message: "journey evidence accepted" };
  }
  if (result === "hold") {
    return { ok: true, result: "hold", message: raw.message ?? "HOLD" };
  }
  if (result === "blocked") {
    return { ok: true, result: "blocked", message: raw.message ?? "BLOCKED" };
  }
  return {
    ok: false,
    result: "failed",
    message: raw.message ?? `journey result=${result}`,
  };
}

export function buildDecisionDocument({
  candidate,
  freezeId = null,
  certificationRunId = null,
  verdict,
  reasons,
  suites,
  attemptHistory = [],
  reportDigest,
  digests,
}) {
  const fixedLedger = getGateB2AttemptLedgerIdentity();
  const ledger = {
    attemptLedgerId: candidate.attemptLedgerId ?? fixedLedger.attemptLedgerId,
    attemptLedgerConfigDigest:
      candidate.attemptLedgerConfigDigest ??
      fixedLedger.attemptLedgerConfigDigest,
    attemptLedgerDigest:
      candidate.attemptLedgerDigest ?? fixedLedger.attemptLedgerConfigDigest,
    attemptLedgerInstanceId:
      candidate.attemptLedgerInstanceId ?? fixedLedger.attemptLedgerInstanceId,
    attemptLedgerHeadDigest:
      candidate.attemptLedgerHeadDigest ?? fixedLedger.attemptLedgerHeadDigest,
    attemptHistoryDigest:
      candidate.attemptHistoryDigest ?? fixedLedger.attemptHistoryDigest,
    attemptLedgerRecordCount:
      candidate.attemptLedgerRecordCount ?? fixedLedger.attemptLedgerRecordCount,
    attemptLedgerMaxSequence:
      candidate.attemptLedgerMaxSequence ?? fixedLedger.attemptLedgerMaxSequence,
    controllerReceiptDigest:
      candidate.controllerReceiptDigest ?? fixedLedger.controllerReceiptDigest,
    attemptLedgerAttestation:
      candidate.attemptLedgerAttestation ??
      fixedLedger.attemptLedgerAttestation,
  };
  const tally = (bucket) => {
    const rows = suites.filter((s) => s.bucket === bucket);
    const counts = {
      passed: 0,
      failed: 0,
      blocked: 0,
      hold: 0,
      notRun: 0,
    };
    for (const row of rows) {
      if (row.result === "passed") counts.passed += 1;
      else if (row.result === "failed") counts.failed += 1;
      else if (row.result === "blocked") counts.blocked += 1;
      else if (row.result === "hold") counts.hold += 1;
      else counts.notRun += 1;
    }
    return counts;
  };
  return {
    schemaVersion: 1,
    gateId: "gate-b2",
    candidateCommitSha: candidate.commitSha,
    candidateTreeSha: candidate.treeSha,
    baseMasterSha: candidate.baseMasterSha,
    freezeId,
    certificationRunId,
    ...ledger,
    schemaVersionProduct: candidate.schemaVersion,
    verdict,
    reasons,
    suiteSummaries: {
      requiredLight: tally("requiredLight"),
      requiredHeavy: tally("requiredHeavy"),
      requiredJourneys: tally("requiredJourneys"),
    },
    digests: {
      writerRegistryDigest: digests.writerRegistryDigest,
      aiPathRegistryDigest: digests.aiPathRegistryDigest,
      qualityManifestDigest: digests.qualityManifestDigest,
      narrativeEvalManifestDigest: digests.narrativeEvalManifestDigest,
      adrChecklistDigest: digests.adrChecklistDigest ?? null,
      classificationDigest: digests.classificationDigest ?? null,
      reportDigest,
    },
    heavyAttempts: suites
      .filter((s) => s.bucket === "requiredHeavy" && s.attempt)
      .map((s) => ({
        suiteId: s.suiteId,
        attempt: s.attempt,
        result: s.result,
        normative: s.attempt === 1,
        message: s.message,
      })),
    attemptHistory: [...attemptHistory]
      .filter((s) => s && s.suiteId && Number.isInteger(s.attempt))
      .map((s) => ({
        suiteId: s.suiteId,
        bucket: s.bucket,
        attempt: s.attempt,
        result: s.result,
        message: s.message,
      })),
    generatedAt: new Date().toISOString(),
  };
}

function validateHeavyReportBinding(report, candidate, expected) {
  const commitSha = expected?.commitSha ?? candidate?.commitSha;
  const treeSha = expected?.treeSha ?? candidate?.treeSha;
  if (!report.candidateCommitSha || report.candidateCommitSha !== commitSha) {
    return {
      ok: false,
      message: `report candidateCommitSha mismatch (expected ${commitSha})`,
    };
  }
  if (!report.candidateTreeSha || report.candidateTreeSha !== treeSha) {
    return {
      ok: false,
      message: `report candidateTreeSha mismatch (expected ${treeSha})`,
    };
  }
  if (!expected?.suiteId || report.suiteId !== expected.suiteId) {
    return {
      ok: false,
      message: "report suiteId mismatch or missing",
    };
  }
  if (!expected?.runId || report.runId !== expected.runId) {
    return {
      ok: false,
      message: "report runId mismatch or missing",
    };
  }
  if (
    !expected?.commandDigest ||
    report.commandDigest !== expected.commandDigest
  ) {
    return {
      ok: false,
      message: "report commandDigest mismatch or missing",
    };
  }
  if (expected?.freezeId && report.freezeId !== expected.freezeId) {
    return {
      ok: false,
      message: "report freezeId mismatch or missing",
    };
  }
  if (
    expected?.certificationRunId &&
    report.certificationRunId !== expected.certificationRunId
  ) {
    return {
      ok: false,
      message: "report certificationRunId mismatch or missing",
    };
  }
  if (expected?.attempt && report.attempt !== expected.attempt) {
    return {
      ok: false,
      message: `report attempt ${report.attempt} != expected ${expected.attempt}`,
    };
  }
  const completedAt = report.completedAt ?? report.finishedAt;
  if (!report.startedAt || !completedAt) {
    return {
      ok: false,
      message: "report startedAt/completedAt required",
    };
  }
  return { ok: true };
}

export async function readHeavyLiveReport(artifactDir, suiteId, options = {}) {
  const { outputPath, allowedPaths = [], env = process.env } = options;
  const candidates = [];
  const primary = outputPath ?? env.GATE_B2_OUTPUT_PATH;
  if (primary) candidates.push(primary);
  if (!primary) {
    candidates.push(path.join(artifactDir, "heavy", suiteId, "report.json"));
  }
  for (const allowed of allowedPaths) {
    if (allowed) candidates.push(allowed);
  }

  for (const candidatePath of candidates) {
    if (await pathExists(candidatePath)) {
      return JSON.parse(await readFile(candidatePath, "utf8"));
    }
  }
  return null;
}

export function validateChronicleProductionReport(report, candidate, expected) {
  if (!report) {
    return {
      ok: false,
      message: "chronicle production report missing under heavy artifacts",
    };
  }
  const binding = validateHeavyReportBinding(report, candidate, expected);
  if (!binding.ok) return binding;
  if (report.diagnosticOnly === true || report.attempt === 2) {
    return {
      ok: false,
      message: "diagnostic-only / attempt 2 cannot pass certification Heavy",
    };
  }
  if (report.attempt !== 1) {
    return { ok: false, message: `expected attempt 1, got ${report.attempt}` };
  }
  if (report.caseCount !== 14) {
    return {
      ok: false,
      message: `expected caseCount 14, got ${report.caseCount}`,
    };
  }
  if (report.certificationEligible !== true) {
    return {
      ok: false,
      message: "certificationEligible must be true",
    };
  }
  return { ok: true, message: "chronicle production report accepted" };
}

export function validateWebAiConsentReport(report, expected) {
  if (!report) {
    return { ok: false, message: "web AI consent report missing" };
  }
  const binding = validateHeavyReportBinding(
    report,
    {
      commitSha: expected?.commitSha,
      treeSha: expected?.treeSha,
    },
    expected,
  );
  if (!binding.ok) return binding;
  if (report.certificationEligible !== true) {
    return { ok: false, message: "consent certificationEligible must be true" };
  }
  const teardown = report.teardown ?? {};
  if (teardown.serverClosed !== true || teardown.localStorageCleared !== true) {
    return {
      ok: false,
      message: "consent teardown flags must be observed true after teardown",
    };
  }
  return { ok: true, message: "consent report accepted" };
}

export function validateWebAiConsentBrowserReport(report, expected) {
  if (!report) {
    return { ok: false, message: "web AI browser consent report missing" };
  }
  const binding = validateHeavyReportBinding(
    report,
    {
      commitSha: expected?.commitSha,
      treeSha: expected?.treeSha,
    },
    expected,
  );
  if (!binding.ok) return binding;
  if (report.mode !== "web-ai-consent-browser-live") {
    return { ok: false, message: "browser consent report mode is invalid" };
  }
  if (report.certificationEligible !== true) {
    return {
      ok: false,
      message: "browser consent certificationEligible must be true",
    };
  }
  const browser = report.browser ?? {};
  if (
    browser.realBrowser !== true ||
    browser.provider !== "@vitest/browser-playwright" ||
    browser.engine !== "chromium"
  ) {
    return {
      ok: false,
      message: "browser consent report must prove real Chromium execution",
    };
  }
  const counts = [
    report.requestCountBeforeConsent,
    report.requestCountAfterRefuse,
    report.requestCountAfterApprove,
    report.requestCountAfterDestinationChangeRefuse,
    report.providerRequestCount,
  ];
  if (!counts.every((value) => Number.isInteger(value) && value >= 0)) {
    return {
      ok: false,
      message: "browser consent request counts must be non-negative integers",
    };
  }
  if (
    report.requestCountBeforeConsent !== 0 ||
    report.requestCountAfterRefuse !== 0 ||
    report.requestCountAfterApprove <= 0 ||
    report.requestCountAfterDestinationChangeRefuse !==
      report.requestCountAfterApprove ||
    report.providerRequestCount !== report.requestCountAfterDestinationChangeRefuse
  ) {
    return {
      ok: false,
      message:
        "browser consent report does not prove refusal=0, approval>0, and destination re-consent",
    };
  }
  const requiredAssertions = [
    "refusal-before-provider-is-zero-http",
    "approval-dispatches-provider-http",
    "destination-change-requires-fresh-consent",
    "indexeddb-and-localstorage-are-cleared",
    "browser-mock-is-closed-before-evidence",
  ];
  if (
    !Array.isArray(report.assertions) ||
    !requiredAssertions.every((assertion) => report.assertions.includes(assertion))
  ) {
    return {
      ok: false,
      message: "browser consent report is missing required journey assertions",
    };
  }
  const teardown = report.teardown ?? {};
  if (
    teardown.serverClosed !== true ||
    teardown.evidenceServerClosed !== true ||
    teardown.localStorageCleared !== true ||
    teardown.indexedDbCleared !== true ||
    teardown.consentBrokerDeclined !== true ||
    teardown.browserMockClosed !== true
  ) {
    return {
      ok: false,
      message:
        "browser consent teardown must close servers, storage, broker, and mock",
    };
  }
  return { ok: true, message: "browser consent report accepted" };
}

async function resolvePnpmStoreDir(repoRoot, baseEnv = process.env) {
  if (baseEnv.PNPM_STORE_DIR) {
    return baseEnv.PNPM_STORE_DIR;
  }
  return runCommand("pnpm", ["store", "path"], repoRoot, baseEnv);
}

async function verifyWorkspacePackageUnderExecutionRoot(executionRoot) {
  const resolvedExecutionRoot = path.resolve(executionRoot);
  const script = `
import { realpathSync } from 'fs';
import path from 'path';
const executionRoot = ${JSON.stringify(resolvedExecutionRoot)};
const pkgLink = path.join(executionRoot, 'node_modules', '@grimodex', 'scan-core');
const resolved = realpathSync(pkgLink);
const resolvedRoot = realpathSync(executionRoot);
if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
  throw new Error('workspace package resolved outside executionRoot: ' + resolved);
}
`;
  await runCommand(
    "node",
    ["--input-type=module", "-e", script],
    resolvedExecutionRoot,
  );
}

export async function prepareWorktreeDependencies({ repoRoot, executionRoot }) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedExecutionRoot = path.resolve(executionRoot);
  if (resolvedRepoRoot === resolvedExecutionRoot) {
    return { mode: "in-place" };
  }

  const repoLockPath = path.join(resolvedRepoRoot, "pnpm-lock.yaml");
  const executionLockPath = path.join(resolvedExecutionRoot, "pnpm-lock.yaml");
  const repoLock = await readFile(repoLockPath, "utf8");
  const executionLock = await readFile(executionLockPath, "utf8");
  const repoDigest = sha256Text(repoLock);
  const executionDigest = sha256Text(executionLock);
  if (repoDigest !== executionDigest) {
    throw new Error(
      `pnpm-lock.yaml digest mismatch: repo=${repoDigest} execution=${executionDigest}`,
    );
  }

  const storeDir = await resolvePnpmStoreDir(resolvedRepoRoot);
  const installEnv = { ...process.env, PNPM_STORE_DIR: storeDir };

  let mode;
  try {
    await runCommand(
      "pnpm",
      ["install", "--frozen-lockfile", "--offline"],
      resolvedExecutionRoot,
      installEnv,
    );
    mode = "offline-install";
  } catch {
    await runCommand(
      "pnpm",
      ["install", "--frozen-lockfile"],
      resolvedExecutionRoot,
      installEnv,
    );
    mode = "online-install";
  }

  await verifyWorkspacePackageUnderExecutionRoot(resolvedExecutionRoot);
  return { mode, lockfileDigest: repoDigest };
}

export function validateJsonAgainstSchema(document, schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const ok = validate(document);
  return {
    ok: Boolean(ok),
    errors: validate.errors ?? [],
  };
}

export async function persistHeavyReport({
  report,
  artifactDir,
  suiteId,
  attemptDir = null,
}) {
  const reportPath =
    attemptDir != null
      ? path.join(attemptDir, "report.json")
      : path.join(artifactDir, "heavy", suiteId, "report.json");
  const content = `${JSON.stringify(report, null, 2)}\n`;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, content, { encoding: "utf8", flag: "wx" });
  return sha256Text(content);
}
