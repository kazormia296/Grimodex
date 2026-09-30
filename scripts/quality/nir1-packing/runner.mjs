import { validateNir1PackingFixtures } from "./contract.mjs";
import { scoreNir1PackingSuite } from "./scorer.mjs";

function cloneForRun(value) {
  return structuredClone(value);
}

export function runNir1PackingCases(manifest, runCase) {
  const contractErrors = validateNir1PackingFixtures(manifest);
  if (contractErrors.length > 0) {
    throw new Error(`invalid NIR-1 packing fixture contract: ${contractErrors.join("; ")}`);
  }
  if (typeof runCase !== "function") {
    throw new TypeError("runCase must be a function");
  }

  const runState = {
    seed: manifest.execution.seed,
    liveModelCalls: manifest.execution.liveModelCalls,
    budget: cloneForRun(manifest.execution.budget),
    predeclaredImprovement: cloneForRun(manifest.execution.predeclaredImprovement),
  };

  return manifest.cases.map((testCase, index) => {
    const isolatedCase = cloneForRun(testCase);
    const result = runCase(isolatedCase, cloneForRun(runState), index);
    return { caseId: isolatedCase.caseId, result };
  });
}

/**
 * Execute both frozen arms and score their materialized outputs in one
 * deterministic runner. Each arm receives an independent clone of the same
 * case and run state, so a baseline mutation cannot become candidate input.
 */
export function runNir1PackingEvaluation(manifest, arms) {
  if (!arms || typeof arms !== "object") {
    throw new TypeError("arms must be an object");
  }
  if (typeof arms.baseline !== "function" || typeof arms.candidate !== "function") {
    throw new TypeError("baseline and candidate arm functions are required");
  }
  const results = runNir1PackingCases(manifest, (testCase, runState, index) => ({
    liveModelCalls: runState.liveModelCalls,
    baseline: arms.baseline(cloneForRun(testCase), cloneForRun(runState), index),
    candidate: arms.candidate(cloneForRun(testCase), cloneForRun(runState), index),
  }));
  return Object.freeze({ results, score: scoreNir1PackingSuite(manifest, results) });
}

/**
 * Exercise every declared P-10 binding mutation through both the cache
 * predicate and the materialized cached-plan -> replan path.  The runner does
 * not manufacture a replacement plan: the supplied replan callback must run
 * the product selector and return both plans plus its measured assertions.
 */
export function runNir1CacheBindingMutations(manifest, isCurrent, replan) {
  const contractErrors = validateNir1PackingFixtures(manifest);
  if (contractErrors.length > 0) {
    throw new Error(`invalid NIR-1 packing fixture contract: ${contractErrors.join("; ")}`);
  }
  if (typeof isCurrent !== "function") throw new TypeError("isCurrent must be a function");
  if (typeof replan !== "function") throw new TypeError("replan must be a function");
  const checks = [];
  for (const testCase of manifest.cases) {
    const keys = testCase.expected.cacheMustReevaluateOn ?? [];
    if (keys.length === 0) continue;
    if (!testCase.cacheBinding || typeof testCase.cacheBinding !== "object") {
      throw new Error(`${testCase.caseId} declares cache mutations without a binding`);
    }
    for (const key of keys) {
      const cachedBinding = cloneForRun(testCase.cacheBinding);
      const mutated = cloneForRun(testCase.cacheBinding);
      mutated[key] = `${mutated[key]}-stale`;
      const current = isCurrent(cloneForRun(cachedBinding), cloneForRun(mutated));
      if (current !== false) {
        throw new Error(`${testCase.caseId} cache binding mutation ${key} was reused`);
      }
      const result = replan({
        testCase: cloneForRun(testCase),
        runState: cloneForRun({
          seed: manifest.execution.seed,
          liveModelCalls: manifest.execution.liveModelCalls,
          budget: manifest.execution.budget,
        }),
        mutationKey: key,
        cachedBinding: cloneForRun(cachedBinding),
        currentBinding: cloneForRun(mutated),
      });
      if (!result || typeof result !== "object") {
        throw new Error(`${testCase.caseId} cache mutation ${key} did not return a replan result`);
      }
      if (
        !result.cachedPlan || typeof result.cachedPlan !== "object" ||
        !result.plan || typeof result.plan !== "object" ||
        result.plan === result.cachedPlan || result.reused !== false
      ) {
        throw new Error(`${testCase.caseId} cache mutation ${key} did not replan a distinct cached plan`);
      }
      if (result.staleMaterialPresent !== false) {
        throw new Error(`${testCase.caseId} cache mutation ${key} retained stale material`);
      }
      if (result.validMaterialRetained !== true) {
        throw new Error(`${testCase.caseId} cache mutation ${key} lost requalified valid material`);
      }
      const contextBudgetTokens =
        manifest.execution.budget.contextWindowTokens -
        manifest.execution.budget.systemTokens -
        manifest.execution.budget.historyTokens -
        manifest.execution.budget.toolTokens -
        manifest.execution.budget.responseReservationTokens;
      if (
        !Number.isSafeInteger(result.usedTokens) ||
        result.usedTokens < 0 ||
        result.usedTokens > contextBudgetTokens
      ) {
        throw new Error(`${testCase.caseId} cache mutation ${key} exceeded the frozen context budget`);
      }
      checks.push({
        caseId: testCase.caseId,
        key,
        current,
        reused: result.reused,
        staleMaterialPresent: result.staleMaterialPresent,
        validMaterialRetained: result.validMaterialRetained,
        usedTokens: result.usedTokens,
      });
    }
  }
  return checks;
}
