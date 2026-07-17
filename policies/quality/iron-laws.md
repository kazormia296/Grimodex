# Grimodex Quality Iron Laws

These rules are the stable policy layer for AI behavior assets and evaluation workflows. The
machine-readable links from requirements to implementation, cases, and tests live in
`evals/quality-manifest.yaml`.

## GDX-ROUTE-001 — Register every AI route

Every production AI surface must have one canonical route, capability decision, and verifier.
Adding a transport or surface without updating the AI path registry and model-role coverage is a
hard failure.

## GDX-PRECHECK-001 — Stop on failed prechecks

Load required references and verify inputs, permissions, tool availability, freshness, and output
shape before mutation. Missing prerequisites are classified as `[precheck]`; they are not guessed.

## GDX-TOOL-001 — Call only manifest-backed tools

Tool name, channel, capability, policy, confirmation requirement, and schema must resolve through
`agent-tool-manifest.json`. A nonexistent or unavailable tool cannot be substituted silently.

## GDX-POLICY-001 — Do not silently retry side effects

Write and destructive operations must pass their policy and confirmation gates. A failed or
ambiguous non-idempotent action is never retried merely to obtain a passing result.

## GDX-GROUND-001 — Verify volatile facts and grounding

Project facts must be tied to current tool results; externally volatile facts require live
verification and a citation. Stale or ungrounded evidence is a quality failure.

## GDX-ARTIFACT-001 — Validate outputs before completion

Structured output, citations, links, and generated artifacts must pass their declared validators.
Existence alone is insufficient when a parser, schema, fingerprint, or provenance contract exists.

## GDX-ISOLATION-001 — Isolate every evaluation case

Each case owns a unique run, conversation, workspace, and artifact namespace, declares locale,
timezone, time, and available tool schemas, and tears down all derived state. Cases never depend on
another case's history or files.

## GDX-TRACE-001 — Preserve traceability and failure state

Requirement ID, canonical source, implementation, evaluation case, selected suite, command result,
and failure class remain linked. Failures use `[routing]`, `[precheck]`, `[tool]`, `[policy]`,
`[quality]`, or `[artifact]`. Runnable Heavy evaluations are `deferred` until executed; missing
runners or prerequisites are `blocked`. Neither state is ever reported as `passed`.

## Evaluation evidence boundaries

`pnpm eval:fixtures` validates fixture metadata, reciprocal traceability, isolated namespace
declarations, symbolic validator IDs, and tool/policy contracts against the canonical manifest. It
does not call a model, execute the symbolic output validators, create fixture state, or perform the
declared teardown. Production behavior is evidence only when the selected Light suites run through
`pnpm eval:impact -- --run`; credentialed or environment-dependent behavior remains an explicit
Heavy evaluation.

Failure classification follows the earliest enforceable boundary: `[routing]` for a disabled or
unresolved route; `[precheck]` for a missing prerequisite, policy grant, or confirmation before
dispatch; `[tool]` for an unknown manifest schema; `[policy]` for an explicit channel or boundary
denial; `[quality]` for stale or ungrounded evidence; and `[artifact]` for output validation failure.
When one automatic suite spans several boundaries, it reports the bounded candidate classes and
`pending-triage` instead of inventing a single class. That state blocks completion until the failing
step is assigned exactly one of the six classes.
