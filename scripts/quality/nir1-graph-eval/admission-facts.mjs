// Provenance of the N-1 admission facts (P2-7). The guard in
// ../nir1-retrieval/contract.mjs accepts observation-prep facts only when
// admission.mjs collected them from the local git object store, the same
// binding outcome.mjs keeps for loaded fixtures (a module-private WeakSet).
//
// The sealer is handed out once: admission.mjs claims it when it loads. A
// second claim throws, so code that tried to seal its own facts would make
// admission.mjs fail to load instead of passing silently. Sealed facts are
// deep-frozen; a copy or an edit is no longer sealed.

import process from "node:process";

const COLLECTED = new WeakSet();
let claimed = false;

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function claimFactsSealer() {
  if (claimed)
    throw new Error("[precheck] the admission facts sealer is already claimed");
  claimed = true;
  return (facts) => {
    const sealed = deepFreeze(facts);
    COLLECTED.add(sealed);
    return sealed;
  };
}

let testClaimed = false;

/**
 * P2-2: whether this process is a node test run: the runner's child
 * (`NODE_TEST_CONTEXT=child-v8`, process isolation) or `node --test` itself
 * (no isolation). A production runner is neither.
 */
function underNodeTest() {
  return (
    process.env.NODE_TEST_CONTEXT === "child-v8" ||
    process.execArgv.includes("--test")
  );
}

/**
 * E-1: the sealer of the test suites' 批准 5 evidence (test-support.mjs claims
 * it at load). It marks every record `testOnly: true`; the formal entries
 * (admitGraphCaseRun, assertReceiptHeadBound) never produce such a record and
 * validateCp4Receipt refuses one. A second claim throws, so a production
 * module that claimed it would make the test suites fail to load. P2-2: it is
 * handed out only inside a node test run, so a production process cannot
 * seal its own 批准 5; the summaries accept test-only evidence only after
 * this claim (`isTestEvidenceAllowed`).
 */
export function claimTestEvidenceSealer() {
  if (!underNodeTest())
    throw new Error(
      "[precheck] the test evidence sealer exists only inside a node --test run (P2-2)",
    );
  if (testClaimed)
    throw new Error(
      "[precheck] the test evidence sealer is already claimed (test-support.mjs only)",
    );
  testClaimed = true;
  return (facts) => {
    const sealed = deepFreeze({ ...facts, testOnly: true });
    COLLECTED.add(sealed);
    return sealed;
  };
}

/** P2-2: test-only evidence counts only in a test run that claimed its sealer. */
export function isTestEvidenceAllowed() {
  return testClaimed && underNodeTest();
}

export function isCollectedFacts(facts) {
  return facts !== null && typeof facts === "object" && COLLECTED.has(facts);
}
