#!/usr/bin/env node
/**
 * Freeze a Gate B2 candidate commit/tree and write digest-only freeze metadata.
 *
 *   pnpm certify:gate-b2:freeze -- --candidate HEAD
 *
 * Does not claim PASS. After freeze, production/prompt/writer changes require a
 * new candidate.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FREEZE_RELATIVE,
  GATE_B2_CONTRACT_VERSION,
  bindCandidateDigestRoot,
  loadGateB2AttemptLedgerSnapshot,
  pathExists,
  validateJsonAgainstSchema,
} from "./certify-gate-b2-bindings.mjs";
import {
  GATE_B2_ATTEMPT_LEDGER_ROOT,
  getGateB2AttemptLedgerIdentity,
} from "./gate-b2-controller-config.mjs";
import {
  collectInputDigests,
  loadGateB2Manifest,
  parseCertifyArgs,
  resolveCandidateIdentity,
} from "./certify-gate-b2.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function parseFreezeArgs(argv) {
  const base = parseCertifyArgs(
    argv.filter((arg) => arg !== "--freeze" && arg !== "--write-results"),
  );
  return {
    ...base,
    writeResults: argv.includes("--write-results"),
  };
}

function provisionalSuites(manifest) {
  return [
    ...(manifest.requiredLight ?? []).map((entry) => ({
      suiteId: entry.id,
      bucket: "requiredLight",
      result: "not-run",
    })),
    ...(manifest.requiredHeavy ?? []).map((entry) => ({
      suiteId: entry.id,
      bucket: "requiredHeavy",
      result: "not-run",
    })),
    ...(manifest.requiredManualJourneys ?? []).map((entry) => ({
      suiteId: entry.id,
      bucket: "requiredJourneys",
      result: "not-run",
    })),
  ];
}

function emptySuiteCounts(notRun) {
  return {
    passed: 0,
    failed: 0,
    blocked: 0,
    hold: 0,
    notRun,
  };
}

async function archiveSupersededFreeze({ repoRoot, oldFreeze, newCommitSha }) {
  const archiveDir = path.join(repoRoot, "evals/certifications/archive");
  await mkdir(archiveDir, { recursive: true });
  const archivePath = path.join(
    archiveDir,
    `gate-b2-candidate.${oldFreeze.candidate.commitSha}.freeze.json`,
  );
  const superseded = {
    ...oldFreeze,
    status: "superseded",
    supersededBy: newCommitSha,
    supersededAt: new Date().toISOString(),
  };
  await writeFile(
    archivePath,
    `${JSON.stringify(superseded, null, 2)}\n`,
    "utf8",
  );
  return archivePath;
}

export async function freezeGateB2Candidate({
  repoRoot = DEFAULT_REPO_ROOT,
  candidate = null,
  baseMaster = null,
  writeResults = true,
  writeRepoFreeze = true,
  artifactRoot = null,
  resultsDir = null,
} = {}) {
  const identity = await resolveCandidateIdentity({
    candidate: candidate ?? undefined,
    baseMaster: baseMaster ?? undefined,
    repoRoot,
  });
  if (identity.dirty) {
    throw new Error(
      "Refusing to freeze a dirty working tree. Commit or stash first.",
    );
  }
  const digestRoot = await bindCandidateDigestRoot({
    repoRoot,
    candidateSha: identity.commitSha,
  });
  let manifest;
  let manifestDigest;
  let digests;
  try {
    const loaded = await loadGateB2Manifest(digestRoot.executionRoot);
    manifest = loaded.raw;
    manifestDigest = loaded.digest;
    digests = await collectInputDigests(manifest, digestRoot.executionRoot, {
      manifestDigest,
    });
  } finally {
    await digestRoot.cleanup();
  }
  const freezeId = randomUUID();
  let attemptLedger = getGateB2AttemptLedgerIdentity();
  // Freeze can be prepared before a controller volume is mounted in a local
  // checkout, but once a fixed root exists its metadata/state must be captured
  // rather than silently ignored. The certification runner remains fail-closed
  // when the root is absent at execution time.
  if (await pathExists(GATE_B2_ATTEMPT_LEDGER_ROOT)) {
    const snapshot = await loadGateB2AttemptLedgerSnapshot({
      ledgerRoot: GATE_B2_ATTEMPT_LEDGER_ROOT,
      candidateCommitSha: identity.commitSha,
      candidateTreeSha: identity.treeSha,
      contractVersion: GATE_B2_CONTRACT_VERSION,
    });
    attemptLedger = { ...attemptLedger, ...snapshot };
  }
  const productSchemaVersion = manifest.candidate.schemaVersion;
  const requiredLightCount = Array.isArray(manifest.requiredLight)
    ? manifest.requiredLight.length
    : 0;
  const requiredHeavyCount = Array.isArray(manifest.requiredHeavy)
    ? manifest.requiredHeavy.length
    : 0;
  const requiredJourneyCount = Array.isArray(manifest.requiredManualJourneys)
    ? manifest.requiredManualJourneys.length
    : 0;
  const repoFreezePath = path.join(repoRoot, FREEZE_RELATIVE);
  let archivedPath = null;
  if (writeRepoFreeze && (await pathExists(repoFreezePath))) {
    const oldFreeze = JSON.parse(await readFile(repoFreezePath, "utf8"));
    if (oldFreeze?.candidate?.commitSha && oldFreeze.freezeId !== freezeId) {
      archivedPath = await archiveSupersededFreeze({
        repoRoot,
        oldFreeze,
        newCommitSha: identity.commitSha,
      });
    }
  }

  const freeze = {
    schemaVersion: 1,
    contractVersion: GATE_B2_CONTRACT_VERSION,
    gateId: "gate-b2",
    freezeId,
    candidateCommitSha: identity.commitSha,
    candidateTreeSha: identity.treeSha,
    ...attemptLedger,
    productSchemaVersion,
    frozenAt: new Date().toISOString(),
    candidate: {
      commitSha: identity.commitSha,
      treeSha: identity.treeSha,
      baseMasterSha: identity.baseMasterSha,
      schemaVersion: productSchemaVersion,
      ...attemptLedger,
      ...digests,
    },
    freezeRules: {
      invalidateOn: [
        "production code",
        "prompt",
        "response schema",
        "parser",
        "Human Gold",
        "writer registry",
        "runtime policy",
        "migration",
        "browser mock",
        "test harness semantics",
      ],
      docsTypoOnlyRerunHeavy: false,
      evaluationCodeChangeRequiresHeavyRerun: true,
    },
  };

  const artifactDir =
    artifactRoot ??
    path.join(repoRoot, ".artifacts/gate-b2", identity.commitSha);
  await mkdir(path.join(artifactDir, "environment"), { recursive: true });
  const freezePath = path.join(artifactDir, "freeze.json");
  await writeFile(freezePath, `${JSON.stringify(freeze, null, 2)}\n`, "utf8");

  if (writeRepoFreeze) {
    await writeFile(
      repoFreezePath,
      `${JSON.stringify(freeze, null, 2)}\n`,
      "utf8",
    );
  }

  const provisionalReasons = [
    "Candidate frozen; required Light/Heavy/Journey evidence not yet attached to this freeze.",
    "ADR checklist still contains FAIL items that block Engineering PASS until remediated.",
    "Billed Heavy suites and journey evidence must be recorded against this tree SHA.",
  ];
  const provisionalDecision = {
    schemaVersion: 1,
    gateId: "gate-b2",
    freezeId,
    certificationRunId: null,
    candidateCommitSha: identity.commitSha,
    candidateTreeSha: identity.treeSha,
    baseMasterSha: identity.baseMasterSha,
    ...attemptLedger,
    schemaVersionProduct: productSchemaVersion,
    verdict: "INCOMPLETE",
    reasons: provisionalReasons,
    suiteSummaries: {
      requiredLight: emptySuiteCounts(requiredLightCount),
      requiredHeavy: emptySuiteCounts(requiredHeavyCount),
      requiredJourneys: emptySuiteCounts(requiredJourneyCount),
    },
    digests: {
      writerRegistryDigest: digests.writerRegistryDigest,
      aiPathRegistryDigest: digests.aiPathRegistryDigest,
      qualityManifestDigest: digests.qualityManifestDigest,
      narrativeEvalManifestDigest: digests.narrativeEvalManifestDigest,
      adrChecklistDigest: digests.adrChecklistDigest ?? null,
      classificationDigest: digests.classificationDigest ?? null,
      reportDigest: null,
    },
    heavyAttempts: [],
    generatedAt: new Date().toISOString(),
    notes:
      "Provisional freeze decision only. Replace after --run-light/--run-heavy/--run-journeys against this candidate.",
  };
  const decisionSchema = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        "evals/certifications/schemas/gate-b2-decision-v1.schema.json",
      ),
      "utf8",
    ),
  );
  const decisionValidation = validateJsonAgainstSchema(
    provisionalDecision,
    decisionSchema,
  );
  if (!decisionValidation.ok) {
    throw new Error(
      `Gate B2 provisional decision schema validation failed: ${JSON.stringify(decisionValidation.errors)}`,
    );
  }

  await writeFile(
    path.join(artifactDir, "decision.json"),
    `${JSON.stringify(provisionalDecision, null, 2)}\n`,
    "utf8",
  );

  if (writeResults) {
    const resultsPath = path.join(
      resultsDir ?? path.join(repoRoot, "evals/certifications/results"),
      `gate-b2-${identity.commitSha}.json`,
    );
    await mkdir(path.dirname(resultsPath), { recursive: true });
    await writeFile(
      resultsPath,
      `${JSON.stringify(provisionalDecision, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    freeze,
    freezePath,
    repoFreezePath,
    provisionalDecision,
    archivedPath,
  };
}

async function main() {
  const args = parseFreezeArgs(process.argv.slice(2));
  const result = await freezeGateB2Candidate({
    candidate: args.candidate,
    baseMaster: args.baseMaster,
    writeResults: args.writeResults !== false,
  });
  process.stdout.write(
    [
      `# Gate B2 candidate freeze`,
      ``,
      `- commit: \`${result.freeze.candidate.commitSha}\``,
      `- tree: \`${result.freeze.candidate.treeSha}\``,
      `- contractVersion: ${result.freeze.contractVersion}`,
      `- freeze: \`${result.repoFreezePath}\``,
      ...(result.archivedPath
        ? [`- superseded archive: \`${result.archivedPath}\``]
        : []),
      `- verdict: INCOMPLETE (provisional)`,
      ``,
    ].join("\n"),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
