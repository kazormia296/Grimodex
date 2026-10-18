// The one entry that scores a DP-H run (K6/2 nir1-final-request-packing-eval).
//
//   node scripts/quality/nir1-packing/final-request/runner.mjs [--receipt <dir|file>] [--setup-receipt <file>]
//
// The harness is a cargo test. The evidence entry is the ignored test
// `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml
// --features nir1-final-request-eval --lib nir1_final_request_eval::harness::
// tests::final_request_evidence_run -- --ignored --exact`; it runs only behind
// the freeze gate (see evals/nir1-packing/final-request.README.md). It writes
// `receipt.json` and `setup-receipt.json` under `.artifacts/`. This runner only
// reads them: it never starts cargo, Native or any other process that outlives
// it. The only child processes are the bounded, synchronous `git` calls of
// `verifyFrozenSnapshot` and of the candidate lookup.
//
// Order (draft: 作者の分離と freeze の順序): the freeze gate first, scoring
// second. A receipt is scored only if the freeze record is `frozen`, binds the
// bytes at the candidate commit, and the candidate is a clean checkout. A run
// that cannot be scored is a HOLD (exit 2), never a PASS and never a FAIL.
//
// Exit status: 0 every request passed, 1 the scorer failed, rejected or
// invalidated the run, 2 hold (the freeze gate or a clean candidate is missing,
// or there is no receipt), 3 the input could not be read.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIXTURE_PATH,
  FREEZE_PATH,
  scorerDigest,
  verifyFrozenSnapshot,
} from "./contract.mjs";
import { loadFixedTemplate } from "./payload.mjs";
import { scoreFinalRequestReceipt } from "./scorer.mjs";

export const RUNNER_VERSION = "nir1-final-request-runner/1";
export const EVAL_FEATURE = "nir1-final-request-eval";
export const ARTIFACT_ROOT = ".artifacts/nir1-final-request-eval";
export const EXIT = Object.freeze({
  passed: 0,
  failed: 1,
  hold: 2,
  unreadable: 3,
});

const GIT_TIMEOUT_MS = 10_000;
const defaultRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  }).trim();
}

/**
 * The candidate under test: this checkout. A receipt is compared with it, not
 * with itself, so a receipt of another commit, tree, fixture or scorer is stale.
 */
export async function resolveCandidate({ repoRoot }) {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const tree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  const dirty = git(repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const fixtureBytes = await readFile(path.join(repoRoot, FIXTURE_PATH));
  const freezeBytes = await readFile(path.join(repoRoot, FREEZE_PATH));
  const freeze = JSON.parse(freezeBytes.toString("utf8"));
  return {
    head,
    tree,
    dirtyPaths: dirty,
    fixtureSha256: sha256(fixtureBytes),
    freezeSha256: sha256(freezeBytes),
    scorerSha256: scorerDigest(freeze?.scorer?.files ?? []),
    featureSet: [EVAL_FEATURE],
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * Scores one run. Returns `{ status, exit, reasons, result? }` where `status`
 * is `passed`, `failed`, `invalid`, `rejected` (the scorer's verdicts), `hold`
 * or `unreadable`.
 */
export async function runFinalRequestEvaluation({
  repoRoot = defaultRepoRoot,
  receiptPath,
  setupReceiptPath,
  deps = {},
}) {
  const resolve = deps.resolveCandidate ?? resolveCandidate;
  const verifyFrozen = deps.verifyFrozen ?? verifyFrozenSnapshot;
  const loadFixture =
    deps.loadFixture ??
    (async (root) => readJson(path.join(root, FIXTURE_PATH)));
  const loadTemplate = deps.loadTemplate ?? loadFixedTemplate;

  let receipt;
  let setupReceipt;
  try {
    receipt = await readJson(receiptPath);
    setupReceipt = await readJson(setupReceiptPath);
  } catch (error) {
    return {
      status: "unreadable",
      exit: EXIT.unreadable,
      reasons: [
        `the receipts could not be read: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  // A development receipt (the harness's own mechanics tests) is not evidence.
  if (
    receipt?.extensions?.developmentRun === true ||
    setupReceipt?.extensions?.developmentRun === true
  ) {
    return {
      status: "hold",
      exit: EXIT.hold,
      reasons: [
        "development-receipt: a receipt made without the freeze gate is not scored",
      ],
    };
  }

  const candidate = await resolve({ repoRoot });
  const reasons = [];
  if ((candidate.dirtyPaths ?? []).length > 0) {
    reasons.push(
      `workspace-not-clean: ${candidate.dirtyPaths.length} path(s) differ from HEAD ${candidate.head}`,
    );
  }
  const frozen = verifyFrozen({
    repoRoot,
    runCommit: candidate.head,
    expectedFreezeCommit: receipt?.freeze?.commit,
  });
  if (frozen.errors.length > 0) reasons.push(...frozen.errors);
  if (reasons.length > 0) {
    return { status: "hold", exit: EXIT.hold, reasons };
  }

  const fixture = await loadFixture(repoRoot);
  const template = await loadTemplate(repoRoot);
  const result = scoreFinalRequestReceipt({
    fixture,
    receipt,
    setupReceipt,
    template,
    expectedInputs: {
      head: candidate.head,
      tree: candidate.tree,
      fixtureSha256: candidate.fixtureSha256,
      freezeSha256: candidate.freezeSha256,
      scorerSha256: candidate.scorerSha256,
      featureSet: candidate.featureSet,
      freezeCommit: frozen.freezeCommit,
    },
  });
  return {
    status: result.status,
    exit: result.status === "passed" ? EXIT.passed : EXIT.failed,
    reasons: result.failures.map(
      (failure) => `${failure.code}: ${failure.message}`,
    ),
    result,
  };
}

/** The newest `run-*` directory under `.artifacts/` that holds a receipt or a hold record. */
export async function latestRunDirectory(repoRoot) {
  const root = path.join(repoRoot, ARTIFACT_ROOT);
  let names;
  try {
    names = await readdir(root);
  } catch {
    return undefined;
  }
  const runs = [];
  for (const name of names.filter((entry) => entry.startsWith("run-"))) {
    const directory = path.join(root, name);
    try {
      runs.push({ directory, modified: (await stat(directory)).mtimeMs });
    } catch {
      // A directory that vanished is not a run.
    }
  }
  runs.sort((left, right) => right.modified - left.modified);
  return runs[0]?.directory;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--receipt" || flag === "--setup-receipt") {
      const value = argv[(index += 1)];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      options[flag === "--receipt" ? "receipt" : "setupReceipt"] = value;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return options;
}

export async function main(
  argv,
  { repoRoot = defaultRepoRoot, out = console } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error));
    return EXIT.unreadable;
  }
  let receiptPath = options.receipt;
  if (receiptPath === undefined) {
    const directory = await latestRunDirectory(repoRoot);
    if (directory === undefined) {
      out.log(
        JSON.stringify({
          runner: RUNNER_VERSION,
          status: "hold",
          reasons: [`no run directory under ${ARTIFACT_ROOT}: nothing was run`],
        }),
      );
      return EXIT.hold;
    }
    receiptPath = directory;
  }
  let directory = path.dirname(receiptPath);
  if ((await stat(receiptPath).catch(() => undefined))?.isDirectory()) {
    directory = receiptPath;
    receiptPath = path.join(directory, "receipt.json");
  }
  const setupReceiptPath =
    options.setupReceipt ?? path.join(directory, "setup-receipt.json");

  // A harness that was refused by its freeze gate left a hold record, no receipt.
  const hold = await readJson(path.join(directory, "hold.json")).catch(
    () => undefined,
  );
  if (hold !== undefined && !(await stat(receiptPath).catch(() => undefined))) {
    out.log(
      JSON.stringify({
        runner: RUNNER_VERSION,
        status: "hold",
        reasons: hold.reasons ?? [],
        note: "the harness did not run Native: its freeze gate refused",
      }),
    );
    return EXIT.hold;
  }

  const outcome = await runFinalRequestEvaluation({
    repoRoot,
    receiptPath,
    setupReceiptPath,
  });
  const summary = {
    runner: RUNNER_VERSION,
    status: outcome.status,
    reasons: outcome.reasons.slice(0, 50),
    summary: outcome.result?.summary,
    evidence: outcome.result?.evidence,
  };
  out.log(JSON.stringify(summary, null, 2));
  if (outcome.result !== undefined) {
    try {
      await writeFile(
        path.join(directory, `score-${Date.now()}.json`),
        `${JSON.stringify(outcome.result, null, 2)}\n`,
        { flag: "wx" },
      );
    } catch (error) {
      out.error(
        `the score file could not be written: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return outcome.exit;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
