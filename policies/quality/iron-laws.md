# Grimodex Quality Iron Laws

These rules are the stable policy layer for AI behavior assets and evaluation workflows. The
machine-readable links from requirements to implementation, cases, and tests live in
`evals/quality-manifest.yaml`.

## GDX-ROUTE-001 — Register every AI route

Every production AI surface must have one canonical route, capability decision, and verifier.
Adding a transport or surface without updating the AI path registry and model-role coverage is a
hard failure.

## GDX-AI-AUDIT-001 — Persist every observable AI execution before dispatch

Every production generative or inference execution is recorded independently of whether it writes
manuscript prose. This includes chat and Agent iterations, research children and tool exchanges,
reviews and pseudo comments, synopsis/title/metadata generation, retries and fallbacks, connection
probes that invoke a model, browser BYOK calls, CLI/Codex runtimes, embeddings, and rerankers. Before
provider or local-model dispatch, Grimodex durably appends the exact normalized observable request
(system/developer/user/history messages, context, tools, model/provider and generation options) and
freezes its project, workspace, path, operation, execution, and parent identities. Transport
credentials supplied outside the model-visible request body—such as API keys, authorization
headers, and credential-bearing environment values—are excluded and never become audit payloads.
Credential-shaped text intentionally included in model-visible prompt, context, tool content, or
output is preserved exactly; the export bundle warns that it can therefore contain user-authored or
model-generated secret-looking text. An unresolved audit owner/path is a `[routing]` failure. Once
resolved, a failed durable audit start is a missing dispatch prerequisite: it disables that model
dispatch and is a `[precheck]` failure.

"Exact" and `complete` are relative to the declared Grimodex observation boundary. Renderer paths
record typed normalized arguments and application-observed parsed blocks/deltas, not a byte-for-byte
copy of provider-native HTTP request/response envelopes or transport headers. A complete effective
JSON-body receipt preserves the model-visible JSON value; unless explicitly declared otherwise, it
does not preserve serialization whitespace, object-key order, or the serialized byte sequence.

Here, "production execution" means a model dispatch or local inference that Grimodex itself
initiates. A standalone MCP client's private prompts/model calls and content generated externally
then pasted or imported into Grimodex are not observable to this ledger. MCP tool/change evidence
remains available through its own trace, and externally sourced authorship remains `unknown`; the
attribution report must not describe either case as completely AI-audited.

Project-associated executions use the immutable `project:<id>` chain. A pre-project execution such
as the settings connection probe uses the separate `workspace` chain; it never borrows an arbitrary
project identity. Model-list and metadata-only control-plane requests are not model executions. A
prompt-free selected-model runner preload that may load weights but supplies no prompt and requests
no token generation or model output remains control-plane activity.

Every started execution reaches an append-only terminal state when observable: response text and
thinking exposed by the provider, tool calls/results, usage, stop reason, retry/fallback edges,
partial output, success, failure, or cancellation. A workspace switch never redirects terminal
events into the newly active database; a start-only record remains explicitly ambiguous for the
report. `full-observable` never claims provider-private chain-of-thought or prompts added internally
by an external CLI/runtime that Grimodex cannot observe. Every registered full-observable path must
point to an executable audit contract test. A partial-observable path must additionally declare the
omitted value and representation retained. Owner labels without evidence do not satisfy this law.

<a id="GDX-PRECHECK-001"></a>

## GDX-PRECHECK-001 — Stop on failed prechecks

Load required references and verify inputs, permissions, tool availability, freshness, and output
shape before mutation. Missing prerequisites are classified as `[precheck]`; they are not guessed.

Security-sensitive threat models remain `draft` until explicit user confirmation of trusted/untrusted
actors, in-scope and out-of-scope attacks, mandatory defenses, and acceptance implications. Material
changes require reconfirmation. Subagents and reviewers may propose a change, but may not silently
freeze or change the threat model. Missing confirmation is a blocking precheck and must stop as
`[precheck]` before mutation. For the remaining NIR-1 lanes (C-resource, C-body, C-product, the
D-final addendum, D-transport, D-dispatch, H-store/H-current, DI-1 and E), the user has delegated
technical decisions on worker, owner, termination and lifecycle, and technical threat-model revisions
within the already confirmed actors, defenses, recipients and acceptance. Before mutation, the
integrator records each decision and its trust boundary in the lane's decision record and the PR
body, and indexes the decision ID and record location in the
[NIR-1 work record](../../docs/plans/nir1-continuation-2026-10.md); for a hard decision, obtain
read-only advisor input and decide explicitly. This is a delegated technical
decision, not a claim of individual user approval. New recipients of secrets or data, expanded
storage scope, relaxed thresholds (including any relaxation or silent change of the current
confirmation-ledger thresholds and Gold), product publication, deleting product authorization, and
new contracts or authorities fall outside this delegation and still fail the precheck. This
delegation does not apply outside the remaining NIR-1 lanes.

Long or high-risk work uses one integrator, implementer(s), and candidate-untouched independent
acceptance reviewer(s). Keep separate implementation and acceptance reviewers; these roles do not
overlap, and acceptance reviewer(s) must not edit the candidate. A single candidate ledger records
the requested base, head, tree, clean state, receipt directory, and user-confirmed threat-model
version/ref. Large cross-boundary changes are split into reviewable lanes, while the critical
candidate stays minimal. Focused gates must pass before the candidate freezes. After freeze, no edits
are allowed: a finding reopens the candidate and invalidates its receipts.

Changes involving external egress, subprocesses, background work, or async lifecycle require a
finite owner/lifecycle matrix before mutation. It covers every entry/start/retry/reentrant path,
admission closure, pending-start work, active handle ownership, cancellation, bounded wait, actual
termination evidence (close/exit/terminal receipt), error/timeout/onClosed ownership, and persisted
restart state. A kill request, error event, or rejected promise alone is not termination proof.
High-effort review and candidate-untouched independent acceptance must resolve P2+ findings before
freeze and merge (for a release PR, before the expensive Full as well); after the canonical Quick or
Full, acceptance confirms the unchanged candidate and does not reopen semantics without a candidate
change.

Before an expensive Full, require generic resource isolation: no competing heavy run, enough writable
capacity on the actual workspace, build-cache, and temp filesystems, and separate checks for root/home
pressure and temp quota. Do not use any fixed capacity/quota threshold (including GB, percentage, inode,
or other numeric thresholds), a host-specific cache deletion list, or deletion automation. Derive any
thresholds from risk, workload, and filesystem state rather than hardcoding them. This preflight is read-only and must not auto-delete artifacts, kill other jobs, or
rewrite temp paths. A competing job is a coordination stop, not kill authority. Also use a focused
preflight for risk-derived applicable late stages only.
Resolve the immutable candidate base and head once as expanded shell-local values before the canonical Quick
or Full, and pass those exact same values to it and every verify of that receipt. The merge precheck for each
kind of PR is defined in [GDX-TRACE-001](#GDX-TRACE-001); only the release path records an `approved_merge_base`
and compares the squash merge commit's first parent (`<merge-sha>^1`) with it after merge. An explicitly
requested non-squash method must, before merge, have a method-specific actual-base/post-merge verification
procedure defined and approved; if absent, stop before merge. Do not reuse the squash first-parent rule or
add general non-squash verification logic.
Runtime performance/fresh Xvfb, migration/recovery, and real product journeys are examples, not
blanket requirements. Do not require or block on an inapplicable host capability. These checks are
diagnostic only and never replace a clean Full-from-stage-1 + verify. An unexplained runtime failure remains
an unattributed runtime blocker until causal evidence exists. Do not infer environment or product
status from touched paths; correlate rAF and event-loop behavior, wake/discovery counts,
memory-sampler duration, process CPU/I/O, and device/PSI, while preserving the exact failed receipt.
Diagnostic/P3 debt stays separate from the critical candidate unless the user explicitly authorizes
including it.

For an external Claude review, fix its data categories, permission, model, effort, and Fast service
tier in a start-of-work precheck before execution. Confirm data categories and permission before
sending. The current default when the user requests that review is requested model `claude-fable-5-1`
with effort `high`, unless the user overrides it. Record requested and effective model, effort, and
Fast service tier; never silently substitute. This confirmation is scoped to the approved data and
is not blanket permission to send all repositories or logs.

## GDX-AI-CONSENT-001 — Disclose AI data use and obtain route-scoped consent

Before Web Editor Local LLM or BYOK sends any manuscript, prompt, selected context, conversation,
credential, or derived content beyond its current browser storage boundary, show the exact data
categories, every processor and processing purpose, provider storage and retention, model-training
status, and current policy links. Consent is explicit and bound to policy version, route, provider,
and actual connection destination; a change to any of those invalidates prior consent. Missing consent, an incomplete
disclosure, or an unknown processor fails closed before provider dispatch. Consent records never
contain content or credentials. Web Editor has no application-owned AI credential or managed AI
provider route. BYOK credentials remain in page session memory only and are never persisted to
IndexedDB or Local Storage; Local LLM endpoints and BYOK providers are activated only by explicit
user configuration.

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

## GDX-NARR-EVAL-001 — Version and replay Narrative Extraction evaluations

Every Narrative Extraction case, model request, raw-response replay, parser result, and report is
bound to explicit Prompt, response-schema, extractor, parser, corpus, and model identities. Human
Gold is canonical; a model never authors or silently repairs its own Gold. A legacy baseline may be
measured, but it is never reported as certification for a richer production contract.

Transport credentials are runtime-only. Replay and report artifacts reject authorization, API-key,
credential, password, bearer-token, and secret fields while retaining non-secret usage counts,
provider-reported cost, duration, requested model, and resolved model identity.

## GDX-NARR-EVIDENCE-001 — Resolve Narrative Evidence exactly

Every accepted Narrative observation or inference cites an exact quote from a declared immutable
Source View and resolves through the production Evidence resolver. Model-provided offsets are not
accepted. Missing, unknown, ambiguous, transformed-to-a-different-string, or otherwise unresolved
Evidence is a hard failure rather than a best-effort match.

## GDX-NARR-SEMANTIC-001 — Preserve narrative assertion semantics

Event detection, actuality, attribution, narrative frame, clustering, significance, and Proposal
gate are scored as independent semantic dimensions. Plans, rumors, dreams, hypotheses, failed or
blocked attempts, negations, recollections, and disputed claims are not promoted to narrator-
asserted story-world facts. A missing output dimension is `unobservable`, never an implicit pass.

## GDX-NARR-SEMANTIC-CONTRACT-001 — Keep narrative authority and state axes explicit

Mutation `origin` and `authorityRoute` are separate audit and authorization
attributes. Human Direct, Interactive Agent Command, Interpreter Projection,
Import, History, and Restore/Migration routes are classified explicitly, and
unknown routes fail closed. Review, Evidence Freshness, Reconciliation Signal,
Build Action, Component Compatibility, and Projection Application State are
orthogonal vocabularies; no one axis may be used as another. Evidence, Scope,
Disclosure, and the canonical Freshness authority are machine-readable and
validated before C2 adds durable dependency graph state.

Scope comparison records the strongest relation established by the current
structural Scope and revision-bound Registry／Order Basis; it is never a truth
verdict. `any` is intentional lack of constraint, `unresolved` is an unknown
constraint, matching unresolved reasons do not establish identity, and an
Oracle-derived `equal` requires the same Basis discipline as every other
Oracle-derived relation.

Narrative producers keep Evidence, invalidation Dependency, and model-visible
Context as separate declared sets. Dynamic Source input reaches a model only
through the recorded Context Set; unclassified model input remains an opaque
Dependency. Dependency Role × Consumer Kind × Source Change Class maps only to
the existing Freshness, Finding Reason, and Build Action vocabularies. Required
and advisory Build Actions aggregate independently of Freshness, and only a
sealed, complete Declaration Set may replace the active V1 Dependency set.
Dependency invalidation never authorizes semantic retraction or Domain mutation.

## GDX-NARR-COVERAGE-001 — Do not overclaim from partial narrative coverage

Narrative evaluations and extraction artifacts declare included and omitted documents. Partial
coverage cannot support claims that no other event exists, that an unresolved entity is absent, or
that the corpus is complete. Such claims are hard failures even if precision or recall is otherwise
high.

## GDX-NARR-DETAIL-001 — Project details only through stable, type-safe bindings

Automatic Narrative Detail projection targets only an existing Detail Definition resolved by stable
Definition ID through a confirmed user binding, a preset binding, or an explicit per-proposal user
selection. A field name, translated label, or similarity match alone never authorizes automatic
binding. Preset backfill requires one exact localized, field-type-compatible match and rejects
ambiguity.

Every projected value preserves the binding version and temporal policy and must be losslessly
compatible with the declared field type and dropdown/reference catalog. `inherit`, `set`, and
`clear` remain distinct. Legacy stored values may be decoded, but canonical encoders never invent a
Definition, option, reference, or silently turn absence into an explicit clear.

## GDX-NARR-TEMPORAL-001 — Preserve temporal axes and deterministic calendar authority

Discourse position, story relation, calendar coordinate, and state validity are separate temporal
axes. Chronicle Event ordinal and manuscript reading order are not calendar facts. A partial story
order remains partial, and a multi-period Scene is never collapsed into one date merely to satisfy
a projection.

Models may identify temporal expressions, relations, and attachment candidates, but they do not
author epoch coordinates, calendar arithmetic, propagated order, or conflict resolution. Unknown
week length, month, era, reform, timezone, or qualitative duration remains symbolic, ambiguous, or
unresolved rather than inheriting a familiar-world default.

Project Calendar snapshots are strict, immutable, versioned artifacts. Calendar writers use
optimistic concurrency control, and stale snapshots cannot authorize a later resolution. Existing
Scene/Event times and manual story order enter the graph as virtual user constraints; values
materialized from an approved constraint set are folded back into that provenance and never counted
again as an independent source.

## GDX-ISOLATION-001 — Isolate every evaluation case

Each case owns a unique run, conversation, workspace, and artifact namespace, declares locale,
timezone, time, and available tool schemas, and tears down all derived state. Cases never depend on
another case's history or files.

<a id="GDX-TRACE-001"></a>

## GDX-TRACE-001 — Preserve traceability and failure state

Requirement ID, canonical source, implementation, evaluation case, selected suite, command result,
and failure class remain linked. Failures use `[routing]`, `[precheck]`, `[tool]`, `[policy]`,
`[quality]`, or `[artifact]`. Runnable Heavy evaluations are `deferred` until executed; missing
runners or prerequisites are `blocked`. Neither state is ever reported as `passed`.

Pull requests (opened, synchronize, reopened), `master` pushes and the nightly schedule run the
ordinary `ci.yml` checks automatically. Ordinary checks are not a canonical Quick/Full receipt, and
the absence of hosted PR checks is not evidence of a passing gate; a pending or missing check,
`no checks reported`, or a green ordinary run never replaces the canonical receipt. Canonical Quick
and Full run as a hosted `canonical-ci.yml` `workflow_dispatch` with `profile`, `candidate_base`,
and `candidate_head`; the dispatched ref's head must equal `candidate_head`. A hosted Quick runs its
immediate verify in the same job. Full runs as independent part jobs plus the `full-aggregate` job,
which assembles the single receipt and runs the immediate verify with the same tuple; a re-run
re-runs all jobs, never only failed ones. Full admission refuses a local `pnpm ci:local:full`
outside a standard GitHub-hosted job, so a local Full is never merge evidence. Windows NSIS final
compilation remains a separate manual Full CI / tag-release obligation; an unavailable release-only
check is never passed.

Before any canonical Quick/Full evidence, focused validation finishes first. If a completion commit is in scope,
the candidate commit is created before any PR/release evidence; the candidate must be clean. Only when PR/release evidence is requested
and CI is allowed does the clean candidate run local Quick or the hosted canonical Quick; the Quick is immediately verified with the same fixed base/head
values. Commit-only or CI-excluded work keeps the candidate commit without starting Quick and does not claim
merge/release readiness. A change without a requested commit or PR does not create a commit or start PR-bound CI
solely for Quick; any explicitly requested dirty working-tree Quick is diagnostic-only.
After a candidate change, older receipts are invalid and are not reused.

Merge evidence depends on the kind of PR. An ordinary PR is every PR that is not a release PR; it merges on the
complete Quick of a rebased candidate and the same-head ordinary checks. A release PR is any PR that changes the
`package.json` `version`, including the version-bump PR prepared by `bump-version`; when it is unclear whether a PR is
one, treat it as a release PR. A release PR keeps a complete hosted Full as merge evidence.
The two cases are called the ordinary path and the release path below.

An ordinary PR merges as follows. After `git fetch origin master`, the current `origin/master` must be an ancestor of
the candidate HEAD (rebased); otherwise rebase and take the candidate again. The condition is the ancestry, not the
method: where a force push is not allowed (it needs the user's explicit permission), merge `origin/master` into the
branch instead of rebasing. Resolve immutable `candidate_base` and `candidate_head` values once as expanded shell-local
strings, pass those same strings to the canonical Quick (local, or hosted with `profile=quick`) and every verify of that
receipt, and obtain a complete Quick receipt. Before merge, after `git fetch origin master`, `candidate_base` must be an
ancestor of both `candidate_head` and `origin/master` (`git merge-base --is-ancestor "$candidate_base" "$candidate_head"`
and `git merge-base --is-ancestor "$candidate_base" origin/master`), where `candidate_base` is the `origin/master`
fetched just before that Quick; it stays an ancestor after `origin/master` advances, so freshness is not asked. The local
Quick checks neither and the hosted Quick checks only the first; a base that is not on `origin/master`, such as a commit
on the branch, narrows the Quick's changed-path selection to part of the PR diff. A Quick whose pair fails either check
(for example one taken for a PR-only goal on a branch that had fallen behind) is not merge evidence even when the
candidate is unchanged, and the Quick is taken again after the branch is brought up to date.

The ordinary `ci.yml` PR checks must have succeeded on the same head with none pending or failing, and the review gate
must hold (no requested changes, no unresolved thread, no P2+ finding). Merge with
`gh pr merge --squash --match-head-commit` and the candidate head. The current base is not required to equal a recorded
base immediately before merge, and this path does not use `approved_merge_base`: if `origin/master` advanced after the
Quick, GitHub reports the PR mergeable without conflict, and the PR HEAD still equals `candidate_head`, neither the
rebase nor the Quick is repeated; only a conflict or a needed candidate change restarts from the rebase. After merge,
fetch and verify that the merge commit is included in `origin/master`; a squash merge commit whose first parent
(`<merge-sha>^1`) differs from `candidate_base` may be recorded but is not a failure on this path. Canonical Full is not
an ordinary PR merge condition, and no Full is dispatched for an ordinary PR.

The party that merged an ordinary PR then dispatches a hosted canonical Full on the `origin/master` head (`--ref master`,
`candidate_head` the master head, `candidate_base` the master commit that last passed a complete Full, or the merge
commit's first parent when that is unknown), and the next merge does not wait for it. If a canonical Full for `master` is
already running, dispatch nothing now; after it finishes, dispatch one Full on the latest master head, so that several
merges share one Full. A party that cannot wait for that one dispatch reports it as pending and hands it to its caller
(the integrator, or the user who requested the work), who first checks that no Full already covers the latest master
head. The party that dispatched a Full watches it to completion and starts the red handling below if it fails; a party
that cannot wait reports the run id and hands the watching to its caller.

A master Full follows the same Full rules as any other Full: the resource-isolation preflight, all part jobs plus
`full-aggregate`, re-running all jobs, and no local Full as evidence. A run that stopped at the dispatch's selection
validation (for example because `master` advanced between resolving `candidate_head` and the dispatch, so that it no
longer equals the head of the dispatched ref) never ran the Full: it is neither a green nor a red master Full, it is not
re-run, and a new dispatch with a fresh `candidate_head` replaces it.

A failed master Full takes priority over other work. Master is red when the last concluded attempt of the newest master
Full run that has a concluded attempt (not counting a run stopped at the selection validation) did not succeed (it failed,
was cancelled, or timed out). A run whose jobs are being re-run is judged by the attempt before the re-run, and a first
attempt that is still running is skipped, so a re-run in progress does not reopen merging. While master is red, merge only the fix or
the revert: before the next merge, re-run all jobs to see whether it reproduces and find which merge introduced it, then
merge the fix or the revert ahead of other PRs. Red clears only when a re-run or a later master Full completes
successfully, or when the fix or the revert is on `origin/master`. The one exception is a failure shown to be an
unrelated flake and recorded where the merging party can read it: other merges are not blocked while all jobs are
re-run, a red whose record cannot be found is not treated as a flake, and a failed re-run ends the exception. A party
that only has merge authority and finds master red stops merging and reports to its caller, who decides whether to
revert.

A release PR's initial merge Full first confirms the fetched current `origin/master` is an ancestor of the candidate
HEAD, then resolves immutable `candidate_base` and `candidate_head` values once and passes the same expanded strings to
Full and every verify of that receipt. A release merge precheck fetches `origin/master` before base comparison or
classification and records exactly one `approved_merge_base`: the verified candidate base when no exception applies, or
the current base only after the narrow editorial docs/ADR-only exception is approved. A release tag requires a new
complete Full run on the merged release commit itself.

Receipts bind the requested and resolved base and head, current HEAD and tree, worktree state, and
completeness. Dirty Quick receipts additionally bind the tracked diff and untracked file-content fingerprint.
Partial `--from` runs, dry runs, stale receipts, missing prerequisites, and release-only coverage are never
converted into merge or release passes.

Before an expensive Full, record generic resource isolation: no competing heavy run, enough writable
capacity on the actual workspace, build-cache, and temp filesystems, and separate checks for root/home
pressure and temp quota. Do not use any fixed capacity/quota threshold (including GB, percentage, inode,
or other numeric thresholds), a host-specific cache deletion list, or deletion automation. Derive any
thresholds from risk, workload, and filesystem state rather than hardcoding them. This preflight is read-only and must not auto-delete artifacts, kill other jobs, or
rewrite temp paths. A competing job is a coordination stop, not kill authority. For a hosted Full,
Full admission observes the actual workspace, build-cache, temp, memory, and pressure state on each
fresh part VM and refuses unsafe placement or pressure; before dispatch, the dispatcher still checks
read-only that no other canonical Full for the same target ref (`master`, or the release PR branch) is
in progress.

At candidate freeze, bind the exact candidate once in the receipt/ledger, including base, head, tree,
clean state, receipt directory, and completeness. Use an expected-head check at push and merge state
transitions; a squash merge through `gh` uses `gh pr merge --squash --match-head-commit` with the
candidate head on both paths. On the release path only, immediately before merge, fetch `origin/master` and
confirm the current base equals the recorded `approved_merge_base`. For a release PR's squash merge only, after
merge and fetch, compare the actual squash merge commit's first parent (`<merge-sha>^1`) once with the recorded
`approved_merge_base`, and verify that the merge commit is included in `origin/master`.
An explicitly requested non-squash method must, before merge, have a method-specific actual-base/post-merge
verification procedure defined and approved; if absent, stop before merge. Do not reuse the squash
first-parent rule or add general non-squash verification logic.
Do not require repeated tree equality checks or user-facing SHA recitation except on mismatch or request. On the
release path, an upstream-base change is exempt from a Full rerun only when candidate HEAD and PR diff are unchanged and the
upstream delta is editorial docs/ADR-only: it must change no executable, build, dependency, CI, policy,
schema, manifest, or generated-contract content and no ratified decision or acceptance meaning. Record the
exception and proportionate static/focused checks; the old receipt remains bound to its old base, not the new
one, and is reverified with the same original candidate values. Any ambiguity or candidate HEAD change
invalidates the receipt and requires a clean Full-from-stage-1 + verify. If a release PR's first-parent
comparison mismatches, do not report verified success: classify the newly added base delta and perform the
necessary exception/revalidation path; the merge may have occurred, but acceptance evidence is not valid until
resolved.

Decisive acceptance evidence is either directly candidate-bound, or transitively bound through a
verified parent receipt that is itself candidate-bound. When metrics or artifacts are quoted or adopted
independently of that parent receipt, bind them directly to candidate identity, commit/tree/run, and
artifact digest; without that direct binding, the standalone evidence is diagnostic-only. Missing direct
binding is tracked hardening debt and does not by itself retroactively invalidate a complete parent
receipt.

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

A credential-free formal certification never places an external-credential-dependent evaluation in
a required bucket and never converts missing credentials into a pass or skip. Live provider/model
quality is recorded by a separate maintainer-local qualification with its own schema, artifacts, and
`QUALIFIED` / `HOLD` / `FAILED` / `INCOMPLETE` vocabulary. Qualification evidence cannot be reused
as a formal certification report or decision, and its absence or failure cannot silently change a
certification or merge verdict that explicitly excludes live model quality.

<a id="agent-validation"></a>

## Agent validation scope

Choose validation from the requested work and the affected contracts before starting commands.

- Investigation, inventory, explanation, or review only: Read-only findings; no Quick/Full solely for inspection
- Ordinary prose, comments, or formatting: Relevant diff, formatting, and link checks
- Implementation or bug fix: Focused checks for changed behavior and affected boundaries
- AI instructions, skills, policy, or evaluation contracts: Related contract tests and the canonical `grimodex-impact-gate` Light evaluation
- Commit only: Focused validation and the requested candidate commit; no Quick or merge-readiness claim
- PR/release evidence with CI allowed: Clean candidate Quick plus immediate verify under GDX-TRACE-001
- Ordinary PR merge with CI allowed: Rebased clean candidate Quick plus immediate verify, and success of the same-head PR checks, under GDX-TRACE-001; the canonical Full runs on master after the merge
- Release PR merge or release tag with CI allowed: Full and verify under GDX-TRACE-001, including applicable preflight

Instruction and policy changes are behavior changes, even when stored in Markdown. Reuse a successful
command result only for the same candidate, environment, and command; rerun when those inputs change,
a failure needs resolution, or an unresolved concern warrants it. Do not add whole-suite testing just
because a targeted check passed. This classification does not change the impact selector's all-suite
fallback for empty, unavailable, or unclassified diffs, nor replace a required acceptance receipt.

<a id="immutable-identity"></a>

## Immutable identity and bounded lookup

For changes involving immutable child/revision records, bind restoration, Decision writes, rereads,
display, and receipts to the same child/revision ID. Never reselect by parent `runId` alone, and verify
that non-target Decision records remain unchanged. A bounded lookup must not filter an already limited
global list and infer absence; use authority-scoped lookup or exhaust pagination. Mocks reproduce
limit, order, cursor, and N/N+1 boundaries. Product journeys wait for the newly created durable ID and
its corresponding UI projection before editing; selector visibility alone is not a ready signal.
