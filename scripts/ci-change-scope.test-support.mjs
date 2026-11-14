// Shared by the workflow-structure tests. Not a test file itself.
//
// The change-scope gate wraps a dependent job's original `if` as
//   ${{ !cancelled() && (<original>) && needs.changes.outputs.<lane> != 'false' }}
// These helpers peel that wrapper off so the tests that pin the original
// expressions keep pinning them, and evaluate the wrapped form with the same
// restricted evaluator the tests already use.

const SCOPE_GATE =
  /^\$\{\{ !cancelled\(\) && \((.+)\) && needs\.changes\.outputs\.([a-z][a-z0-9]*) != 'false' \}\}$/su;

/** Expression body without the `${{ }}` wrapper. */
export function unwrapIf(expression) {
  return String(expression)
    .trim()
    .replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
}

/** `{ gated, lane, original }`; `original` is the body without the gate. */
export function stripScopeGate(expression) {
  const match = SCOPE_GATE.exec(String(expression ?? ""));
  return match
    ? { gated: true, lane: match[2], original: match[1] }
    : { gated: false, lane: undefined, original: unwrapIf(expression) };
}

/** job id -> lane, for the jobs the rules gate directly. */
export function laneByGatedJob(rules) {
  const map = {};
  for (const [lane, definition] of Object.entries(rules.lanes)) {
    for (const job of definition.gatedJobs) map[job] = lane;
  }
  return map;
}

/**
 * Evaluates the restricted expression subset ci.yml uses. `changes` maps lane
 * names to the `changes` job outputs; the default (no outputs) models a
 * skipped or failed `changes` job. GitHub string equality is case-insensitive.
 */
export function evaluateIf(expression, { inputs = {}, event = "workflow_dispatch", changes = {} } = {}) {
  const body = unwrapIf(expression).replace(
    /(inputs\.\w+|github\.\w+)\s*([!=]=)\s*('[^']*')/gu,
    "String($1 ?? '').toLowerCase() $2 $3",
  );
  const needs = { changes: { outputs: { ...changes } } };
  return new Function(
    "inputs",
    "github",
    "needs",
    "cancelled",
    "startsWith",
    `return (${body});`,
  )(
    inputs,
    { event_name: event },
    needs,
    () => false,
    (value, prefix) => String(value ?? "").toLowerCase().startsWith(prefix),
  );
}
