#!/usr/bin/env node
/**
 * Freeze a Gate B2 candidate commit/tree and write digest-only freeze metadata.
 *
 *   pnpm certify:gate-b2:freeze -- --candidate HEAD
 *
 * Does not claim PASS. After freeze, production/prompt/writer changes require a
 * new candidate.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
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

export async function freezeGateB2Candidate({
  repoRoot = DEFAULT_REPO_ROOT,
  candidate = null,
  baseMaster = null,
  writeResults = true,
} = {}) {
  const { raw: manifest, digest: manifestDigest } =
    await loadGateB2Manifest(repoRoot);
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
  const digests = await collectInputDigests(manifest, repoRoot);

  const freeze = {
    schemaVersion: 1,
    gateId: "gate-b2",
    frozenAt: new Date().toISOString(),
    candidate: {
      commitSha: identity.commitSha,
      treeSha: identity.treeSha,
      baseMasterSha: identity.baseMasterSha,
      schemaVersion: 16,
      ...digests,
      certificationManifestDigest: manifestDigest,
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

  const artifactDir = path.join(
    repoRoot,
    ".artifacts/gate-b2",
    identity.commitSha,
  );
  await mkdir(path.join(artifactDir, "environment"), { recursive: true });
  const freezePath = path.join(artifactDir, "freeze.json");
  await writeFile(freezePath, `${JSON.stringify(freeze, null, 2)}\n`, "utf8");

  const repoFreezePath = path.join(
    repoRoot,
    "evals/certifications/gate-b2-candidate.freeze.json",
  );
  await writeFile(
    repoFreezePath,
    `${JSON.stringify(freeze, null, 2)}\n`,
    "utf8",
  );

  const provisionalDecision = {
    schemaVersion: 1,
    gateId: "gate-b2",
    candidateCommitSha: identity.commitSha,
    candidateTreeSha: identity.treeSha,
    baseMasterSha: identity.baseMasterSha,
    schemaVersionProduct: 16,
    verdict: "INCOMPLETE",
    reasons: [
      "Candidate frozen; required Light/Heavy/Journey evidence not yet attached to this freeze.",
      "ADR checklist still contains FAIL items that block Engineering PASS until remediated.",
      "Billed Heavy suites and journey evidence must be recorded against this tree SHA.",
    ],
    suiteSummaries: {
      requiredLight: {
        passed: 0,
        failed: 0,
        blocked: 0,
        hold: 0,
        notRun: 5,
      },
      requiredHeavy: {
        passed: 0,
        failed: 0,
        blocked: 0,
        hold: 0,
        notRun: 6,
      },
      requiredJourneys: {
        passed: 0,
        failed: 0,
        blocked: 0,
        hold: 0,
        notRun: 6,
      },
    },
    digests: {
      ...digests,
      reportDigest: null,
    },
    heavyAttempts: [],
    generatedAt: new Date().toISOString(),
    notes:
      "Provisional freeze decision only. Replace after --run-light/--run-heavy/--run-journeys against this candidate.",
  };

  await writeFile(
    path.join(artifactDir, "decision.json"),
    `${JSON.stringify(provisionalDecision, null, 2)}\n`,
    "utf8",
  );

  if (writeResults) {
    const resultsPath = path.join(
      repoRoot,
      "evals/certifications/results",
      `gate-b2-${identity.commitSha}.json`,
    );
    await writeFile(
      resultsPath,
      `${JSON.stringify(provisionalDecision, null, 2)}\n`,
      "utf8",
    );
  }

  return { freeze, freezePath, repoFreezePath, provisionalDecision };
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
      `- freeze: \`${result.repoFreezePath}\``,
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
