# Local CI runner

`pnpm ci:local:quick` and `pnpm ci:local:full` read
`scripts/local-ci-registry.json`. Full maps the existing 16 logical groups and
52 obligations onto 68 scheduled tasks. The duplicate
`workspace_migration_supervisor` failpoint
invocation is one task whose receipt result names both obligations. Supporting
shard commands can declare an empty obligation list; the `rust.tests` terminal
task carries the original shared-Rust test obligation exactly once.
The renderer unit suite runs as complementary Vitest `1/3`, `2/3`, and `3/3`
shards; the final task carries the existing `frontend.unit` obligation, and all
three results are bound into the receipt.

Each registry command has a stable `id`. `after` lists direct task
dependencies, `lane` prevents two tasks with the same exclusive lane from
overlapping, `slots` reserves part of the global twelve-slot limit, and
`timeoutMs` optionally shortens the task timeout. The runner validates IDs,
dependencies, slot bounds, and cycles before starting a command.

Use `--max-parallel-tasks N` (1 through 12, default 12) to additionally limit
the number of tasks admitted at once on a constrained host. For example,
`pnpm ci:local:full -- --base "$candidate_base" --head "$candidate_head" --max-parallel-tasks 1`
runs tasks serially while preserving the twelve-slot budget, every task's
command, internal worker count, timeout, and acceptance criteria. Twelve-slot
tasks still run normally. The selected limit is bound into the existing receipt
plan; pass the same option to `pnpm ci:local:verify -- full` with the same base
and head. Quick supports the same option. This limits task overlap, not the
resource consumption inside an individual task.

PR-bound Quick evidence is collected only after focused validation and the
requested candidate commit. Confirm the candidate worktree is clean, resolve
`candidate_base` and `candidate_head` once, and pass those same expanded values
to Quick and its immediate verify. A later candidate change invalidates the old
receipt. Commit-only or CI-excluded work keeps its candidate commit without
starting Quick or claiming merge readiness. Investigation, review, or a change
without a requested commit/PR does not create a commit or start PR-bound CI
solely for Quick; an explicitly requested dirty working-tree run remains
diagnostic evidence and cannot establish merge readiness.

### Manual GitHub connection (source preparation)

`.github/workflows/canonical-ci.yml` is a thin manual/reusable adapter to the
same package scripts and registry. Its default `contracts` selection installs
the frozen dependencies and runs the workflow/runner/supervisor source contracts;
it does **not** run Quick or Full, generate notices, or produce a canonical
receipt. The existing `ci.yml` default and release-reusable jobs remain separate.

Registered `ci.yml` reuses its existing `canonical_profile` input for two fixed
OS-only modes (no eleventh dispatch input). `os-contracts` runs only changed
OS-route source contracts and three affected existing selection contracts with
frozen dependencies; helpers are synthetic in those tests. `os-check` uses only
the runner's installed Node, `/usr/bin/env`, `/usr/bin/unshare` and
`/usr/bin/python3`, with no setup or installation. The `os-` family selects only
the bounded OS owner; exact malformed or mixed inputs reject before checkout/setup.
Nonempty profiles still exclude all fifteen ordinary jobs. Keep product mode
`all`, all booleans false and canonical tuple/options empty. Existing
contracts/quick/full semantics are unchanged.

The single Linux check inventories those fixed executable permissions, owner,
mode and digest, then attempts user/mount/network/PID namespaces with the
existing util-linux helper. Its clean-environment Python process observes
namespace separation, PID1 and loopback-only interface names, then forks and
reaps one immediate-exit synthetic child. No socket, bus/client, Electron or
external service is started. Existing supervisor close/group-exit and log
identities are retained; unknown close retains the same private evidence owner
through late close and cannot become a pass or replacement. Missing, denied,
unsupported or unknown facts fail the job without fallback/retry. The artifact
contains the existing checkout identity, source TAP or shaped helper results,
not raw helper logs/environment/argv/endpoints or a capability certificate.

This is a bounded instance-specific permission observation, **not** filesystem
bus-route masking, all-route/activation denial, authentication, native no-escape
retirement, future-runner B authority, Full resource admission or a product gate.
Before the separately authorized one `os-check` dispatch, bind registered workflow,
ref/head/tree/base, exact inputs/purpose/data, unique owner and durable possible
start. A later B instance still needs fresh applicable route/auth/ownership/
lifetime/retirement proof before any bus/client/app start. Source preparation
and source-contract success do not authorize that runtime stage.

For independently safe normal jobs, registered `ci.yml` has an opt-in manual
`independent_gates=true` boolean (default false; absent from release calls).
With canonical inputs empty and all source-repair flags false, it selects ten
complete ordinary job definitions, including the unchanged Linux/macOS/Windows
C-query real-worker matrix. It excludes only `electron-runtime-performance`,
`electron-product-journeys`, `electron-native`, `rust`, and `migration-recovery-gate`:
the first two need independent runtime/D-Bus prerequisites; the latter three
remain deferred pending reviewed admission and affected proof after removal of
host-cache reclamation. Removing those deletion steps does not establish resource
admission or a job pass. These five jobs remain **deferred / SKIPPED, not passed**.
Their default/reusable selection and complete product commands are retained.
This is negative job selection, not resource admission, complete normal CI,
canonical Full, or merge evidence. It never waives the five remaining gates.
Source-focused combinations remain source-only; canonical combinations are
rejected by the sole canonical owner before setup. Before dispatch, record the
exact ordinary inputs, immutable candidate, registration and unique run owner.
Any source change requires affected review and proof on the new checkpoint;
old candidate Quick/worker receipts are not transferred.

A branch-only new workflow is not assumed registered for manual dispatch. The
already registered `ci.yml` now has an opt-in `canonical_profile` string input:
empty preserves ordinary CI; `contracts`, `quick` or `full` calls the canonical
adapter with GitHub's local reusable-workflow syntax at the **same commit** as
the caller. The callee does not need independent manual registration. Verify
current caller availability, checkpoint identity and unique run ownership before
dispatch; source preparation alone is not permission to select a gate.

For the new shared-entry source proof, select ONLY `canonical_profile=contracts`,
leave `candidate_base`, `candidate_head` and `max_parallel_tasks` empty, keep ALL
four source-repair booleans false and `product_journey_mode=all`. Any nonempty
canonical selector, tuple or option excludes all fifteen ordinary jobs, even for
malformed or mixed requests; the sole canonical owner rejects invalid selection
before checkout/setup/install. There is no nonempty disabled sentinel: `none`,
whitespace and unknown profiles are invalid. Contracts rejects candidate tuples;
its artifact contains checkout identity and source TAP, not canonical receipts.
The new manual inputs are absent from reusable release calls.

The earlier `source_focused=true`/`source_canonical_contracts=true` fallback still
runs the same four suites in the Electron source owner, with new canonical inputs
empty and resolver/audit flags false. Its selection, frozen install and evidence
are unchanged. Repeating that old fallback does **not** exercise the new reusable
connection. New shared-entry validation must call the actual changed connection
in contracts-only mode; neither mode establishes a canonical gate pass.

A later eligible `quick` invocation through registered `ci.yml` selects
`canonical_profile=quick` (or `profile=quick` for a separately registered direct
adapter dispatch), with all source-repair flags false and product mode `all`.
It requires explicit full `candidate_base` and `candidate_head` commit SHAs,
with head equal to the dispatched ref's SHA. Empty `max_parallel_tasks` in the
caller forwards the adapter's existing default12; an explicit option is forwarded
unchanged. The adapter checks a clean checkout and base ancestry, resolves the pair once, and
passes the same expanded values and `max_parallel_tasks` option to the profile
and its immediate verifier. The scheduler default remains 12; a different limit
requires the existing workload/resource admission decision. A failed profile
never starts verify. Uploaded artifacts retain the existing receipt/log formats;
a hosted job result is not a replacement for receipt verification or acceptance.

`full` is deliberately stopped before setup/install. Its command connection is
prepared, but must not be enabled until candidate acceptance/freeze, outstanding
prerequisites, and a reviewed **actual-runner** resource-isolation preflight
connection are complete. No dispatch input or source-contract pass attests those
facts. That preflight must check the actual workspace/build-cache/temp, root/home
pressure, temp quota and competing heavy work without fixed capacity thresholds,
automatic deletion, foreign-process kills or temp-path rewriting.

The deeper canonical shell now contains a **Full-only, partial inspection** after
candidate/ancestry validation and before profile invocation. The first-step Full
rejection remains unchanged, so this inspection is not reachable in a Full
dispatch today. It uses Node standard-library `realpath`, permission checks and
`statfs` for the actual workspace, root, home, Node temp and `RUNNER_TEMP`, resolving
missing directories through existing ancestors without creating them. Output is
limited to labels and scalar filesystem facts; root/home remain separate
observations even on a shared device. These are not allocation or quota proofs,
and available capacity must not be added once per label on a shared filesystem.

Effective native/shared Cargo targets and caches, pnpm/browser/Electron/uv
storage, applicable quota authority, retained/peak workload demand including
logs/artifacts, and competing-heavy-work exclusivity remain **unresolved**. No
consumer cache defaults are guessed. Even successful inspection fails closed
before Full and verify. Missing paths or unavailable facts also reject. The
existing checkout lock excludes cooperating runs in one checkout, not heavy work
across the host; the adapter does not acquire or recover it. An eventual assessment
must remain in the same continuously owned job as invocation, without intervening
setup, approval waits or a replacement runner. No admission/resume mechanism or
new receipt format is introduced. Synthetic contracts shim the inspector and
check both success-without-admission and missing-fact rejection; they do not probe
actual runner resources. D-Bus capability and product acceptance remain independent
pending prerequisites. This adapter preparation does not authorize a gate run or
establish merge readiness.

Product journeys wait for the created durable ID and its corresponding UI
projection before editing. A visible selector alone is not a ready signal.

The shared-Rust test obligation stays Cargo-native. Three two-slot tasks run the
DB library, the DB integration targets plus `schema-contract`, and the rest of
the workspace. The non-DB shard retains its doctests; a fourth Cargo task runs
the DB doctests. Once those pass, the `rust.tests` terminal task runs the
original workspace selector with `--no-run`, which retains compile-only target
coverage. This terminal compile-all task uses the `cargo-shared` lane, so it
cannot overlap the C2-ZC and other tasks registered on that lane. Each execution
uses Cargo's target, runner, and dynamic-library environment directly; there is
no test-executable discovery or replay layer.

The C2-ZC Rust acceptance and restore-fixture tasks use the same debug-free dev
and test Cargo profiles as the shared workspace compilation. This lets those
candidate-bound tasks reuse the same compiled profile without changing their
gates or fixture contract.

The MCP journey dependency build reserves two scheduler admission slots and
caps Cargo build jobs at two. Cargo may reuse compatible earlier debug-free
artifacts when their feature, `cfg`, and fingerprint inputs match.

The release-only native test gate uses two scheduler admission slots, two Cargo
build jobs, and two Rust test threads. These calibrated resource settings keep
the exact native feature gate unchanged and carry no timing guarantee.

Migration and recovery Rust checks use the separate `cargo-recovery` lane. Its
first failpoint task starts after dependency bootstrap, so it can overlap the
shared-Rust lanes while the global slot bound still limits host load. The six
Cargo commands on that lane reserve two slots and cap both Cargo build jobs and
Rust test threads at two; the IPC and renderer checks keep their existing
limits.

The DAG schedules individual commands. After the first failure it admits no
new command and waits for commands that already started. Full has a
600,000 ms timing target for planning and measurement. This target is advisory:
elapsed time does not stop task admission or execution and does not determine
whether the run passes. Full passes when every required task and ordinary
receipt verification pass. Individual task timeouts, user interruption, and
cleanup failures retain their existing behavior. The external verifier has
its own 120-second timeout. The four-slot runtime contract task starts
after workspace dependency bootstrap and can overlap independent gates. Runtime
performance waits for it and every pre-runtime terminal task, then owns all
twelve slots as the final group. Product journeys run as three fixed, disjoint
processes covering all 33 catalog entries as 11/11/11 shards. Catalog order is retained within
each shard, and only the shard containing the catalog's C2-ZC acceptance roles
sets `acceptanceRequired` and can complete C2-ZC acceptance. Each process
has a calibrated two-slot scheduler admission weight. Exact co-load with all
three journey processes, four-slot quality contracts, and two-slot browser tests
fills the twelve-slot limit. The weights control scheduler admission; each
process retains its own CPU and thread behavior. Each process atomically
allocates a separate Xvfb display and owns a separate artifact directory; a
final one-slot task rejects missing, duplicate, extra, failed, unclean, or
differently bound results before writing the existing canonical v5 result and
v1 manifest.

Full's deterministic priority order starts with bootstrap, recovery, security,
and renderer checks, then browser tests before native work. This lets ready
browser tests take available slots ahead of later bulk tasks instead of waiting
at the tail of the run. It keeps the candidate-bound C2-ZC receipt and fixture
adjacent before quality, product journeys, LFM, Rust, WebGL, Storybook, and
Electron work. Dependency edges and exclusive lanes still control actual
eligibility, and the runtime benchmark remains the final fan-in. Earlier
admission changes co-load and carries no timing guarantee.

The canonical plan retains `__LOCAL_CI_RUN_ID__` in run-owned paths. Command
execution and post-run evidence collection bind the same validated run UUID
without changing the plan descriptor used by receipt verification.

Commands run with Node `spawn({ detached: true })`. Each command writes to:

```text
.artifacts/local-ci/runs/<run-id>/logs/<task-id>.stdout.log
.artifacts/local-ci/runs/<run-id>/logs/<task-id>.stderr.log
```

The receipt records each log's size and SHA-256. After a normal child `close`,
the supervisor gives its process group the bounded TERM grace to finish an
already-started teardown. A group still present is rejected after `SIGTERM` and
`SIGKILL` cleanup; timeout or interruption starts that cleanup immediately. CI
commands must not daemonize, call `setsid`, or double-fork because those
operations escape ordinary process-group cleanup.

The Web Editor Vite build writes directly to
`.artifacts/local-ci/runs/<run-id>/web-editor`. The existing Web Editor artifact
validator checks that directory independently of the Desktop build's normal
`dist` output, so the builds may overlap. `ci:build:desktop` builds Electron and
the renderer without repeating the earlier workspace build and typecheck.

The runner creates `.artifacts/local-ci/checkout.lock` with exclusive `wx`
creation, resolves the candidate before and after execution, and releases the
lock once all admitted process groups have finished cleanup. A host crash can
leave the lock behind; inspect active processes and the lock metadata before
removing it manually.

The CLI converts `SIGINT` and `SIGTERM` into the same abort path, waits for
admitted process groups to finish cleanup, and then releases the checkout lock.

Receipt v3 stores the registry digest, exact task plan, ordered task results,
candidate bindings, cleanup state, and log identities. When all tasks pass,
their receipt is written atomically to a run-owned staging path and checked by
the separate staging-verifier process, including when task execution has
already exceeded the timing target. The verifier only reads the receipt, logs,
candidate, and product-journey evidence. The final receipt records execution,
verification, and total duration, and binds the retained staging receipt by
hash. Measured time includes candidate prechecks, tasks, receipt checks,
external verification, and final receipt persistence. Publication requires
successful verification; durations beyond 600,000 ms remain recorded without
changing that result. Ordinary `--verify` continues to reject invalid or
inconsistent durations, unfinished receipts, and changed evidence.
