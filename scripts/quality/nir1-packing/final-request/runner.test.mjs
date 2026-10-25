import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EVIDENCE_FIXTURE_VERSION, FIXTURE_VERSIONS } from "./contract.mjs";
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

/** The synthetic world as the evidence version (the runner scores no other). */
function newWorld() {
  const world = buildSyntheticWorld({ template });
  world.fixture.fixtureVersion = EVIDENCE_FIXTURE_VERSION;
  world.receipt.inputs.fixtureVersion = EVIDENCE_FIXTURE_VERSION;
  world.receipt.freeze.path =
    FIXTURE_VERSIONS[EVIDENCE_FIXTURE_VERSION].freezePath;
  return world;
}

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
  const freezePath = FIXTURE_VERSIONS[EVIDENCE_FIXTURE_VERSION].freezePath;
  const freezeText = await readFile(
    path.join(repoRoot, freezePath),
    "utf8",
  ).catch(() => undefined);
  if (freezeText === undefined) {
    // The replacement fixture is not placed yet: the run is a HOLD, not scored.
    const world = newWorld();
    await withRun(world, async ({ receiptPath, setupReceiptPath }) => {
      const outcome = await runFinalRequestEvaluation({
        repoRoot,
        receiptPath,
        setupReceiptPath,
      });
      assert.equal(outcome.status, "hold");
      assert.equal(outcome.exit, EXIT.hold);
      assert.match(outcome.reasons.join("\n"), /not-placed/);
      assert.equal(outcome.result, undefined);
    });
    return;
  }
  const freeze = JSON.parse(freezeText);
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
  const candidate = await resolveCandidate({ repoRoot, fixtureVersion: 1 });
  assert.equal(candidate.fixtureVersion, 1);
  assert.deepEqual(candidate.missing, []);
  assert.match(candidate.head, /^[0-9a-f]{40}$/);
  assert.match(candidate.tree, /^[0-9a-f]{40}$/);
  assert.match(candidate.fixtureSha256, /^[0-9a-f]{64}$/);
  assert.match(candidate.scorerSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(candidate.featureSet, ["nir1-final-request-eval"]);
  assert.ok(Array.isArray(candidate.dirtyPaths));
  // By default the candidate is the evidence version; files that are not
  // placed are listed instead of throwing.
  const evidence = await resolveCandidate({ repoRoot });
  assert.equal(evidence.fixtureVersion, EVIDENCE_FIXTURE_VERSION);
  assert.ok(Array.isArray(evidence.missing));
  const spec = FIXTURE_VERSIONS[EVIDENCE_FIXTURE_VERSION];
  assert.equal(
    evidence.missing.includes(spec.fixturePath),
    evidence.fixtureSha256 === undefined,
  );
  assert.equal(
    evidence.missing.includes(spec.freezePath),
    evidence.freezeSha256 === undefined,
  );
});

test("the runner gates and scores the evidence version only, and holds while its files are not placed", async () => {
  const world = newWorld();
  await withRun(world, async ({ receiptPath, setupReceiptPath }) => {
    const seen = {};
    const deps = {
      ...satisfiedDeps(world),
      resolveCandidate: async (args) => {
        seen.resolved = args.fixtureVersion;
        return satisfiedDeps(world).resolveCandidate(args);
      },
      verifyFrozen: (args) => {
        seen.verified = args.fixtureVersion;
        return { errors: [], freezeCommit: world.expectedInputs.freezeCommit };
      },
    };
    const outcome = await runFinalRequestEvaluation({
      repoRoot,
      receiptPath,
      setupReceiptPath,
      deps,
    });
    assert.equal(outcome.status, "passed", JSON.stringify(outcome.reasons));
    assert.equal(seen.resolved, EVIDENCE_FIXTURE_VERSION);
    assert.equal(seen.verified, EVIDENCE_FIXTURE_VERSION);

    let scored = false;
    const missing = await runFinalRequestEvaluation({
      repoRoot,
      receiptPath,
      setupReceiptPath,
      deps: {
        ...satisfiedDeps(world),
        resolveCandidate: async (args) => ({
          ...(await satisfiedDeps(world).resolveCandidate(args)),
          missing: [FIXTURE_VERSIONS[EVIDENCE_FIXTURE_VERSION].freezePath],
        }),
        verifyFrozen: () => {
          scored = true;
          return {
            errors: [],
            freezeCommit: world.expectedInputs.freezeCommit,
          };
        },
      },
    });
    assert.equal(missing.status, "hold");
    assert.equal(missing.exit, EXIT.hold);
    assert.match(missing.reasons.join("\n"), /not-placed/);
    assert.equal(scored, false);
  });
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

test("the runner holds, and does not score, a fixture that names another version", async () => {
  const world = newWorld();
  await withRun(world, async ({ receiptPath, setupReceiptPath }) => {
    const deps = satisfiedDeps(world);
    deps.loadFixture = async () => ({
      ...structuredClone(world.fixture),
      fixtureVersion: 1,
    });
    const outcome = await runFinalRequestEvaluation({
      repoRoot,
      receiptPath,
      setupReceiptPath,
      deps,
    });
    assert.equal(outcome.status, "hold");
    assert.equal(outcome.exit, EXIT.hold);
    assert.match(outcome.reasons.join("\n"), /fixture-version-mismatch/);
    assert.equal(outcome.result, undefined);
  });
});
