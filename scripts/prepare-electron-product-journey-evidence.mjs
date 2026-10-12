#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { appendFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readC2ZcRustAcceptanceEvidence } from "../electron/scripts/product-journeys.mjs";
import {
  assertOutsideRepository,
  bindC2ZcProductJourneyCommand,
  captureC2ZcRestoreFixtureEvidence,
  readC2ZcRestoreFixtureEvidence,
} from "./local-ci.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureNames = {
  backup: "c2zc-restore-fixture.backup.db",
  database: "c2zc-restore-fixture.db",
  manifest: "c2zc-restore-fixture.manifest.json",
};

function githubEnvEntry(name, value) {
  const delimiter = `GRIMODEX_${randomUUID().replaceAll("-", "")}`;
  if (value.includes(delimiter)) {
    throw new Error(
      "GitHub environment delimiter collides with evidence value",
    );
  }
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

async function main() {
  const environmentFile = process.env.GITHUB_ENV;
  const fixtureBuildDirectory =
    process.env.GRIMODEX_C2ZC_RESTORE_FIXTURE_BUILD_DIR;
  if (
    !environmentFile ||
    !fixtureBuildDirectory ||
    !path.isAbsolute(fixtureBuildDirectory)
  ) {
    throw new Error(
      "GITHUB_ENV and an absolute external C2-ZC fixture directory are required",
    );
  }

  const rustAcceptance = await readC2ZcRustAcceptanceEvidence({
    required: true,
    root,
    environment: process.env,
  });
  const candidate = rustAcceptance.candidate;
  if (candidate.worktreeClean !== true) {
    throw new Error(
      "product journey evidence requires a clean Rust acceptance candidate",
    );
  }

  const [repository, fixtureDirectory] = await Promise.all([
    realpath(root),
    realpath(fixtureBuildDirectory),
  ]);
  assertOutsideRepository(
    repository,
    fixtureDirectory,
    "C2-ZC fixture build directory",
  );
  const sourcePaths = {
    fixturePath: path.join(fixtureDirectory, fixtureNames.backup),
    databasePath: path.join(fixtureDirectory, fixtureNames.database),
    manifestPath: path.join(fixtureDirectory, fixtureNames.manifest),
  };
  const sourceEvidence = await readC2ZcRestoreFixtureEvidence(sourcePaths, {
    root: fixtureDirectory,
    candidate,
    label: "candidate-bound external C2-ZC fixture",
  });
  const fixtureEvidence = await captureC2ZcRestoreFixtureEvidence(
    {
      ...sourcePaths,
      input: { manifestPath: sourcePaths.manifestPath },
      candidate,
    },
    root,
  );

  const commandEnvironment = {
    ...process.env,
    GRIMODEX_C2ZC_RUST_REQUESTED_BASE: candidate.requestedBase,
    GRIMODEX_C2ZC_RUST_REQUESTED_HEAD: candidate.requestedHead,
    GRIMODEX_PRODUCT_JOURNEY_SET: "",
    GRIMODEX_PRODUCT_JOURNEY_IDS: "",
  };
  delete commandEnvironment.GRIMODEX_C2ZC_RUST_RECEIPT_SHA256;
  const boundCommand = await bindC2ZcProductJourneyCommand(
    { env: commandEnvironment },
    "electron-product-journeys",
    {
      root,
      plan: {
        comparison: {
          base: candidate.requestedBase,
          head: candidate.requestedHead,
        },
      },
      candidate,
      buildStagePassed: true,
      restoreFixtureEvidence: fixtureEvidence,
    },
  );
  const boundEnvironment = boundCommand.env;
  const entries = [
    [
      "GRIMODEX_PRODUCT_JOURNEY_BUILD_RECEIPT",
      boundEnvironment.GRIMODEX_PRODUCT_JOURNEY_BUILD_RECEIPT,
    ],
    [
      "GRIMODEX_C2ZC_RESTORE_FIXTURE",
      boundEnvironment.GRIMODEX_C2ZC_RESTORE_FIXTURE,
    ],
    [
      "GRIMODEX_C2ZC_RUST_RECEIPT_SHA256",
      boundEnvironment.GRIMODEX_C2ZC_RUST_RECEIPT_SHA256,
    ],
  ];
  if (
    entries.some(([, value]) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error(
      "canonical local-CI product journey evidence is incomplete",
    );
  }
  await appendFile(
    environmentFile,
    entries.map(([name, value]) => githubEnvEntry(name, value)).join(""),
    "utf8",
  );
  console.log(
    `Prepared candidate-bound product journey evidence for ${candidate.resolvedHeadSha}: fixture ${sourceEvidence.fixtureSha256}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
