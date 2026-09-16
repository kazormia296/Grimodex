# Local CI runner

`pnpm ci:local:quick` and `pnpm ci:local:full` read
`scripts/local-ci-registry.json`. Full maps the existing 16 logical groups and
52 obligations onto 60 scheduled tasks. The duplicate
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

PR-bound Quick evidence is collected only after focused validation and the
requested candidate commit. Confirm the candidate worktree is clean, resolve
`candidate_base` and `candidate_head` once, and pass those same expanded values
to Quick and its immediate verify. A later candidate change invalidates the old
receipt. Commit-only or CI-excluded work keeps its candidate commit without
starting Quick or claiming merge readiness. Investigation, review, or a change
without a requested commit/PR does not create a commit or start PR-bound CI
solely for Quick; an explicitly requested dirty working-tree run remains
diagnostic evidence and cannot establish merge readiness.

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
processes covering all 28 catalog entries as 10/9/9 shards. Catalog order is retained within
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
