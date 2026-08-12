import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("freeze script refuses dirty trees and writes digest-only freeze metadata when clean", async () => {
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
        }),
      /dirty working tree/i,
    );
    return;
  }

  const temp = await mkdtemp(path.join(os.tmpdir(), "gate-b2-freeze-"));
  try {
    // When clean, freeze against HEAD into default paths then restore via git checkout of freeze file if needed.
    const result = await freezeGateB2Candidate({
      repoRoot,
      writeResults: true,
    });
    assert.match(result.freeze.candidate.commitSha, /^[0-9a-f]{40}$/);
    assert.match(result.freeze.candidate.treeSha, /^[0-9a-f]{40}$/);
    assert.match(
      result.freeze.candidate.writerRegistryDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.equal(result.provisionalDecision.verdict, "INCOMPLETE");
    const saved = JSON.parse(
      await readFile(result.repoFreezePath, "utf8"),
    );
    assert.equal(saved.candidate.commitSha, result.freeze.candidate.commitSha);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
