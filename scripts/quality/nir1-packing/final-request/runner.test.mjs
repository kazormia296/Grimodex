import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FREEZE_PATH } from "./contract.mjs";
import { loadFixedTemplate } from "./payload.mjs";
import {
  EXIT,
  main,
  resolveCandidate,
  runFinalRequestEvaluation,
} from "./runner.mjs";
import { buildSyntheticWorld } from "./synthetic.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const template = await loadFixedTemplate(repoRoot);

async function withRun(world, body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nir1-runner-"));
  try {
    const receiptPath = path.join(directory, "receipt.json");
    const setupReceiptPath = path.join(directory, "setup-receipt.json");
    await writeFile(receiptPath, JSON.stringify(world.receipt));
    await writeFile(setupReceiptPath, JSON.stringify(world.setupReceipt));
    return await body({ directory, receiptPath, setupReceiptPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Dependencies that stand for a satisfied freeze gate and a clean candidate. */
function satisfiedDeps(world) {
  const expected = world.expectedInputs;
  return {
    resolveCandidate: async () => ({
      head: expected.head,
      tree: expected.tree,
      dirtyPaths: [],
      fixtureSha256: expected.fixtureSha256,
      freezeSha256: expected.freezeSha256,
      scorerSha256: expected.scorerSha256,
      featureSet: expected.featureSet,
    }),
    verifyFrozen: () => ({ errors: [], freezeCommit: expected.freezeCommit }),
    loadFixture: async () => structuredClone(world.fixture),
    loadTemplate: async () => template,
  };
}

const newWorld = () => buildSyntheticWorld({ template });

test("the runner scores a receipt after the freeze gate and the candidate check pass", async () => {
  const world = newWorld();
  await withRun(world, async ({ receiptPath, setupReceiptPath }) => {
    const outcome = await runFinalRequestEvaluation({
      repoRoot,
      receiptPath,
      setupReceiptPath,
      deps: satisfiedDeps(world),
    });
    assert.equal(outcome.status, "passed", JSON.stringify(outcome.reasons));
    assert.equal(outcome.exit, EXIT.passed);
    assert.equal(outcome.result.evidence.dp1Evidence, false);
    assert.equal(outcome.result.evidence.rejectVariantsCountTowardDp1, false);
  });
});

test("the runner holds, and does not score, while the freeze gate is not satisfied", async () => {
  const world = newWorld();
  await withRun(world, async ({ receiptPath, setupReceiptPath }) => {
    let scored = false;
    const deps = {
      ...satisfiedDeps(world),
      verifyFrozen: () => ({
        errors: ["no commit holds a frozen freeze record"],
        freezeCommit: undefined,
      }),
      loadFixture: async () => {
        scored = true;
        return structuredClone(world.fixture);
      },
    };
    const outcome = await runFinalRequestEvaluation({
      repoRoot,
      receiptPath,
      setupReceiptPath,
      deps,
    });
    assert.equal(outcome.status, "hold");
    assert.equal(outcome.exit, EXIT.hold);
    assert.match(
      outcome.reasons.join("\n"),
      /no commit holds a frozen freeze record/,
    );
    assert.equal(scored, false, "a held run never reaches the scorer");
    assert.equal(outcome.result, undefined);
  });
});

test("the runner holds on a dirty checkout", async () => {
  const world = newWorld();
  await withRun(world, async ({ receiptPath, setupReceiptPath }) => {
    const deps = satisfiedDeps(world);
    const resolve = deps.resolveCandidate;
    deps.resolveCandidate = async (args) => ({
      ...(await resolve(args)),
      dirtyPaths: [" M scripts/quality/nir1-packing/final-request/scorer.mjs"],
    });
    const outcome = await runFinalRequestEvaluation({
      repoRoot,
      receiptPath,
      setupReceiptPath,
      deps,
    });
    assert.equal(outcome.status, "hold");
    assert.match(outcome.reasons.join("\n"), /workspace-not-clean/);
  });
});

test("the runner holds on a development receipt", async () => {
  const world = newWorld();
  world.receipt.extensions = { developmentRun: true };
  await withRun(world, async ({ receiptPath, setupReceiptPath }) => {
    const outcome = await runFinalRequestEvaluation({
      repoRoot,
      receiptPath,
      setupReceiptPath,
      deps: satisfiedDeps(world),
    });
    assert.equal(outcome.status, "hold");
    assert.match(outcome.reasons.join("\n"), /development-receipt/);
  });
});

test("stale-receipt-rejected: a receipt of another commit is compared with this candidate and rejected", async () => {
  const world = newWorld();
  await withRun(world, async ({ receiptPath, setupReceiptPath }) => {
    const deps = satisfiedDeps(world);
    const resolve = deps.resolveCandidate;
    deps.resolveCandidate = async (args) => ({
      ...(await resolve(args)),
      head: "e".repeat(40),
    });
    const outcome = await runFinalRequestEvaluation({
      repoRoot,
      receiptPath,
      setupReceiptPath,
      deps,
    });
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.exit, EXIT.failed);
    assert.match(outcome.reasons.join("\n"), /stale-receipt-rejected/);
  });
});

test("a failing request makes the run fail, not hold", async () => {
  const world = newWorld();
  const positive = world.receipt.requests.find(
    (row) => row.requestKind === "positive",
  );
  positive.dfinal = {
    outcome: "err",
    code: "NIR1_NATIVE_A2_UNAVAILABLE",
    reason: "revision-stale",
  };
  positive.capture = null;
  positive.candidate = null;
  await withRun(world, async ({ receiptPath, setupReceiptPath }) => {
    const outcome = await runFinalRequestEvaluation({
      repoRoot,
      receiptPath,
      setupReceiptPath,
      deps: satisfiedDeps(world),
    });
    assert.notEqual(outcome.status, "passed");
    assert.equal(outcome.exit, EXIT.failed);
  });
});

test("unreadable receipts are reported, not scored", async () => {
  const outcome = await runFinalRequestEvaluation({
    repoRoot,
    receiptPath: path.join(os.tmpdir(), "nir1-runner-missing", "receipt.json"),
    setupReceiptPath: path.join(
      os.tmpdir(),
      "nir1-runner-missing",
      "setup-receipt.json",
    ),
    deps: {},
  });
  assert.equal(outcome.status, "unreadable");
  assert.equal(outcome.exit, EXIT.unreadable);
});

test("the real freeze gate holds a run while the freeze record is not frozen", async (t) => {
  const freeze = JSON.parse(
    await readFile(path.join(repoRoot, FREEZE_PATH), "utf8"),
  );
  if (freeze.status === "frozen") {
    t.skip(
      "the freeze record is frozen: the real gate is covered by contract.test.mjs",
    );
    return;
  }
  const world = newWorld();
  await withRun(world, async ({ receiptPath, setupReceiptPath }) => {
    const outcome = await runFinalRequestEvaluation({
      repoRoot,
      receiptPath,
      setupReceiptPath,
    });
    assert.equal(outcome.status, "hold");
    assert.equal(outcome.exit, EXIT.hold);
    assert.match(outcome.reasons.join("\n"), /frozen/);
  });
});

test("resolveCandidate names this checkout and the bytes the freeze record binds", async () => {
  const candidate = await resolveCandidate({ repoRoot });
  assert.match(candidate.head, /^[0-9a-f]{40}$/);
  assert.match(candidate.tree, /^[0-9a-f]{40}$/);
  assert.match(candidate.fixtureSha256, /^[0-9a-f]{64}$/);
  assert.match(candidate.scorerSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(candidate.featureSet, ["nir1-final-request-eval"]);
  assert.ok(Array.isArray(candidate.dirtyPaths));
});

test("main holds when the harness left a hold record and no receipt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nir1-runner-hold-"));
  try {
    await writeFile(
      path.join(directory, "hold.json"),
      JSON.stringify({
        status: "hold",
        reasons: ["freeze-record-not-frozen: status is pending-review"],
      }),
    );
    const lines = [];
    const exit = await main(["--receipt", directory], {
      repoRoot,
      out: {
        log: (line) => lines.push(line),
        error: (line) => lines.push(line),
      },
    });
    assert.equal(exit, EXIT.hold);
    assert.match(lines.join("\n"), /freeze-record-not-frozen/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("main holds when there is no run directory", async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "nir1-runner-empty-"));
  try {
    await mkdir(path.join(empty, ".artifacts"), { recursive: true });
    const lines = [];
    const exit = await main([], {
      repoRoot: empty,
      out: {
        log: (line) => lines.push(line),
        error: (line) => lines.push(line),
      },
    });
    assert.equal(exit, EXIT.hold);
    assert.match(lines.join("\n"), /nothing was run/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("main rejects an unknown argument", async () => {
  const lines = [];
  const exit = await main(["--cargo"], {
    repoRoot,
    out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  });
  assert.equal(exit, EXIT.unreadable);
});

test("the runner never starts cargo or a resident process", async () => {
  const source = await readFile(
    new URL("./runner.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /(?:spawn|exec|execFile)(?:Sync)?\(\s*["']cargo/);
  assert.doesNotMatch(source, /\bspawn\(/);
  assert.doesNotMatch(source, /detached/);
  // The only child process is the bounded synchronous git call.
  assert.match(source, /execFileSync\("git"/);
  assert.match(source, /timeout: GIT_TIMEOUT_MS/);
});
