import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("freeze script refuses dirty trees and isolates writes when clean", async () => {
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(status.status, 0);
  const dirty = status.stdout.trim().length > 0;

  const { freezeGateB2Candidate } = await import(
    "./freeze-gate-b2-candidate.mjs"
  );

  if (dirty) {
    await assert.rejects(
      () =>
        freezeGateB2Candidate({
          repoRoot,
          writeResults: false,
          writeRepoFreeze: false,
        }),
      /dirty working tree/i,
    );
    return;
  }

  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-freeze-"));
  const manifest = yaml.load(
    await readFile(
      path.join(repoRoot, "evals/certifications/gate-b2.yaml"),
      "utf8",
    ),
  );
  try {
    const result = await freezeGateB2Candidate({
      repoRoot,
      writeResults: true,
      writeRepoFreeze: false,
      artifactRoot: path.join(temp, "artifacts"),
      resultsDir: path.join(temp, "results"),
    });
    assert.match(result.freeze.candidate.commitSha, /^[0-9a-f]{40}$/);
    assert.match(result.freeze.candidate.treeSha, /^[0-9a-f]{40}$/);
    assert.match(
      result.freeze.candidate.writerRegistryDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.equal(result.provisionalDecision.verdict, "INCOMPLETE");
    assert.equal(
      result.provisionalDecision.suiteSummaries.requiredLight.notRun,
      manifest.requiredLight.length,
    );
    assert.equal(
      result.provisionalDecision.suiteSummaries.requiredHeavy.notRun,
      manifest.requiredHeavy.length,
    );
    assert.equal(
      result.provisionalDecision.suiteSummaries.requiredJourneys.notRun,
      manifest.requiredManualJourneys.length,
    );
    const saved = JSON.parse(await readFile(result.freezePath, "utf8"));
    assert.equal(saved.candidate.commitSha, result.freeze.candidate.commitSha);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
