// Provenance of the N-1 admission facts (P2-7). The guard in
// ../nir1-retrieval/contract.mjs accepts observation-prep facts only when
// admission.mjs collected them from the local git object store, the same
// binding outcome.mjs keeps for loaded fixtures (a module-private WeakSet).
//
// The sealer is handed out once: admission.mjs claims it when it loads. A
// second claim throws, so code that tried to seal its own facts would make
// admission.mjs fail to load instead of passing silently. Sealed facts are
// deep-frozen; a copy or an edit is no longer sealed.

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
 * E-1: the sealer of the test suites' 批准 5 evidence (test-support.mjs claims
 * it at load). It marks every record `testOnly: true`; the formal entries
 * (admitGraphCaseRun, assertReceiptHeadBound) never produce such a record and
 * validateCp4Receipt refuses one. A second claim throws, so a production
 * module that claimed it would make the test suites fail to load.
 */
export function claimTestEvidenceSealer() {
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

export function isCollectedFacts(facts) {
  return facts !== null && typeof facts === "object" && COLLECTED.has(facts);
}
