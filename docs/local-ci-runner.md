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

For a separately reviewed real-worker lane, `canonical_profile=c-query-workers`
selects **only the existing Linux/macOS/Windows `nir1-c-query-worker` matrix**.
Use product mode `all`, false booleans and empty canonical tuple/options. The
first literal Bash guard rejects mixed inputs, case variants and wrong events
before checkout/setup on every OS; unknown profiles reach canonical rejection.
Empty/default, reusable and independent selections keep the original matrix,
`fail-fast: false`, pinned setup/cache, 45-minute timeout and complete unchanged
`bash scripts/nir1-c-query-worker-ci.sh` command. No input/job/executor, registry
profile, per-file filter, fixture or acceptance change is added.

That script builds its own closed synthetic Q2/Q512 sources using the existing
opt-in fixture branch and real schema/A2/Human Decision writers. Its integral
in-process disposable-copy shape validation is not a separate capacity or
memory diagnostic campaign. The normal worker is built separately with default
features; seam-enabled crash, overflow and postcommit tests use the existing
isolated invocations. Source review and affected canonical `contracts` proof
precede a fresh admission of these actual consumers, subprocess ownership and
egress. No Electron, Editor, bus/client, provider/keyring service, namespace
probe, model installation or extra diagnostic is introduced. A matrix/job pass
proves only the executed cases at that candidate: it does not replace individual
lease/exit/EOF/join/quarantine evidence, all lifecycle coverage, B or Full
prerequisites, final candidate-untouched acceptance or canonical Quick/Full.

For a separately reviewed caller-cancellation lane, `canonical_profile=c-query-cancellation`
selects that **same three-OS matrix**, but runs only
`bash scripts/nir1-c-query-worker-ci.sh caller-cancellation`. Keep product mode
`all`, all booleans false and canonical tuple/options empty; the same first
literal guard accepts only the allowlisted exact worker profiles and rejects mixed or
wrong-event inputs before checkout/setup. Malformed/unknown profiles still reach
canonical rejection. No new input, job, registry profile or arbitrary test filter
is introduced; default/reusable/independent and `c-query-workers` commands remain
unchanged, with the same pinned setup/cache, `fail-fast: false` and 45-minute limit.

The script rejects wrong/extra arguments before filesystem or build work. The
opt-in branch reuses the original closed Q2 fixture validation and a disposable
copy, builds the existing seam-enabled worker, then runs only the existing ignored
`native_worker_cancels_after_request_admission_and_retires_before_reloan` test.
It checks input/source checksums and absence of sidecars, then exits through the
original owned cleanup trap **before Q512 or the original eleven cases**. The
case requires real nonempty Q2 work at the pre-frame barrier, distinct caller
refusal without a lease, and actual exit/necessary EOF/writer completion/reader
join before claim reloan, plus coordinator join and participant release. It
returns no successful Native frame, so it cannot claim a Native Gold pass or
universal lifecycle coverage. Source-contract mocks exercise only script routing
and failure propagation, not Rust/SQLite/worker acceptance.

Independent source review and affected hosted guard proof precede a separately
admitted runtime purpose with fresh workflow/ref/head/tree/base, exact inputs,
unique owner and durable possible-start. Merely exposing this profile does not
authorize dispatch, replay successful cases, renew diagnostics or waive B/Full,
final acceptance or canonical gates. Actual cancellation outcomes on each OS
remain distinct from source contracts and from previous original-matrix results.

For a separately reviewed startup-registration-refusal lane,
`canonical_profile=c-query-startup-refusal` selects that same three-OS matrix,
but runs only `bash scripts/nir1-c-query-worker-ci.sh startup-registration-refusal`.
The same literal guard rejects mixed/case-variant/wrong-event inputs before
checkout/setup; malformed profiles reach canonical rejection. Use product mode
`all`, false booleans and empty canonical tuple/options. No new input, job,
registry profile or arbitrary test filter is added; both existing standalone
selections and default/reusable/independent commands remain unchanged.

The exact optional argument shares the original Q2-only closed fixture, disposable
copy, checksum/sidecar assertions and owned cleanup trap, exiting before Q512 or
the original eleven cases. It builds the worker with **default features**, then
runs only the existing ignored
`native_worker_reports_canonical_registration_refusal_before_ready` test. That
case supplies an unregistered project to the real Native owner, requires the
fixed canonical-registration refusal before READY, and proves actual exit,
necessary EOF and successful reader join before claim reloan and participant
release. It admits no query and returns no successful frame or lease, so it is
not Gold, admission-to-lease timing or universal lifecycle acceptance.

Source review, reviewed checkpoint and affected hosted contracts must precede
any separately admitted runtime purpose with fresh exact candidate/inputs,
unique ownership and durable possible-start. Prepared script mocks are routing
contracts only, not Rust/SQLite/Native Windows evidence. Exposing the selection
does not authorize dispatch, replay either successful lane, renew diagnostics
or waive B/Full, final acceptance or canonical gates.

For a separately reviewed trailing-data lane, `canonical_profile=c-query-trailing-data`
selects the same three-OS matrix and only
`bash scripts/nir1-c-query-worker-ci.sh trailing-data`. Keep product mode `all`,
false booleans and empty canonical tuple/options. The literal guard rejects
mixed/case-variant/wrong-event inputs before checkout/setup, and wrong/extra
script arguments reject before files/build. No input, job, registry profile or
arbitrary test filter is added; existing selections, default/reusable/independent
commands, pinned setup/cache, `fail-fast: false` and 45-minute limit stay unchanged.

The Q2-only branch reuses the original closed synthetic fixture, disposable copy,
checksum/sidecar assertions and owned cleanup trap, exiting before Q512 and the
original eleven cases. It builds the existing seam-enabled worker and runs only
`native_worker_rejects_committed_q2_frame_with_trailing_data`. The real worker
performs same-connection canonical registration and nonempty Q2 work, sends a
complete request-bound frame and terminal-success commit, then one trailing byte.
Native must refuse specifically for trailing pipe data without a result lease,
prove actual exit, necessary EOF, writer completion and successful reader joins
before claim reloan, and release the workspace participant. This is specific
adversarial tail-rejection/retirement evidence, not independent Native Gold,
100 ms success, universal lifecycle or Windows stalled-request-write proof.

Source review, reviewed checkpoint and affected hosted contracts plus results
review precede a separately admitted runtime purpose with fresh exact candidate,
TEN inputs, unique ownership and durable possible-start. Script mocks verify
routing only, not Rust/SQLite/Native Windows acceptance. Exposing this selection
does not authorize dispatch, replay successful lanes, renew diagnostics or waive
B/Full, final acceptance or canonical gates.

For a separately reviewed partial-terminal-marker lane,
`canonical_profile=c-query-partial-terminal` selects the same three-OS matrix
and only `bash scripts/nir1-c-query-worker-ci.sh partial-terminal-marker`.
Keep product mode `all`, false booleans and empty canonical tuple/options. The
literal guard rejects mixed/case-variant/wrong-event inputs before checkout/setup;
malformed profiles reach canonical rejection and wrong/extra script arguments
reject before files/build. TEN inputs, all existing selections and commands,
default/reusable/independent behavior, registry, pinned setup/cache,
`fail-fast: false` and 45-minute limit remain unchanged.

The Q2-only branch reuses the original closed synthetic fixture, disposable copy,
checksum/sidecar assertions and owned cleanup trap, exiting before Q512 and the
original eleven cases. It builds the existing seam-enabled worker and runs only
`native_worker_rejects_complete_q2_frame_with_partial_terminal_marker`. The real
worker performs same-connection canonical registration and nonempty Q2 work,
sends a complete request-bound frame, then only the first two terminal-success
marker bytes and exits. Native must observe that available bound frame while
holding the claim and refuse specifically for a truncated pipe without a lease.
Actual exit, necessary EOF, writer completion **if started**, and all successful
reader joins must precede claim reloan, owner drop and participant release;
unproved cleanup quarantines rather than stacking another worker. This is
specific partial-terminal rejection/retirement evidence, not Gold, a 100 ms
successful lease, universal lifecycle or Windows stalled-request-writing proof.

Independent source review precedes a reviewed checkpoint and affected hosted
contracts plus complete results review; runtime still requires separate fresh
exact candidate/TEN-input admission, exhaustive scoped availability, unique owner
and durable possible-start before ONE three-OS dispatch. Script mocks are routing
contracts, not Rust/SQLite/Native Windows acceptance. Exposing this selection
does not authorize dispatch, replay successful lanes, renew diagnostics or waive
B/Full, final acceptance or canonical gates.

For a separately reviewed grouped terminal-refusal lane,
`canonical_profile=c-query-terminal-refusals` selects the same three-OS matrix
and **both existing steps**, in order: `bash scripts/nir1-c-query-worker-ci.sh trailing-data`
then `bash scripts/nir1-c-query-worker-ci.sh partial-terminal-marker`. Each complete
original command independently builds its closed Q2 fixture and seam-enabled worker,
runs its one original ignored case, checks source/input checksums and sidecars,
and exits through owned cleanup before Q512 or the original eleven cases.
The second build uses the same job/cache; no script argument, test filter, fixture,
assertion, job, input, executor or registry profile is added. Failure propagation
is unchanged: the first failed step prevents the second from running on that OS;
`fail-fast: false` preserves independent results from the other OSes. Skipped
cases are NOT passes, and six outcomes are required for complete lane acceptance.

Use product mode `all`, false booleans and empty canonical tuple/options. The
first literal guard rejects mixed/case-variant/wrong-event inputs before setup.
All existing standalone/default/reusable/independent selections, complete commands,
pinned setup/cache and 45-minute limit are retained. Source review, a reviewed
checkpoint and changed hosted contracts plus results review precede a separate
fresh exact-candidate/TEN-input runtime admission with exhaustive scoped availability,
unique ownership and durable possible-start. Capture all named outcomes and actual
local close/EOF/joins separately from independent remote attempt termination.
This proves only the two original refusal/retirement cases on each OS, not Gold,
a successful 100 ms lease, universal lifecycle coverage, B, Full or merge readiness.
Exposing the group does not authorize dispatch or replay accepted other lanes.

For a separately reviewed grouped frame-lifecycle lane,
`canonical_profile=c-query-frame-lifecycle` reuses the same three-OS worker job
and only `bash scripts/nir1-c-query-worker-ci.sh frame-lifecycle`. The existing
literal guard and TEN inputs remain: product mode `all`, false booleans, empty
canonical tuple/options; malformed/mixed/wrong-event inputs fail before setup.
No input, job, registry profile, dependency, timeout or default command is added.

Only the original closed synthetic Q2 fixture and seam-enabled worker are built.
`native_worker_rejects_declared_q2_frame_with_partial_body` runs on each OS on its
own disposable copy. Only on Linux, the existing
`native_worker_refuses_committed_q2_frame_without_eof` runs next, in a separate
test process on a distinct fresh copy. Each copy and the pristine source retain
checksum/closed-sidecar checks; the original owned cleanup trap remains. This
branch exits before Q512/default eleven cases; no Gold or practical31 replay.

Finally on every OS, a separate default-feature library test process runs the
ignored `request_writer_panic_keeps_claim_quarantined_after_handle_consumption`
regression with the same locked/release/nocapture/single-thread flags, without
worker or fixture environment assignments. It uses real panic joins and in-memory
workspace claims to cover both join paths, consumed handles, repeated refusal and
claim/participant retention after Drop. It deliberately quarantines claims until
process exit, so it runs last and never shares a test process with the frame cases.
Failure propagates through the existing script and owned EXIT cleanup. This is
not external-worker, Native-region, Gold or universal lifecycle evidence.

Partial body must produce no lease, retain the claim through truncated-pipe
refusal and prove actual exit, necessary EOF and all successful joins before
reloan. Missing EOF must observe a timely request-bound FRAME+NQGC1 with a live
child but no lease, refuse at the 100 ms boundary, then prove SIGKILL, actual
exit, EOF and successful joins before reloan. Writer completion is required if
started; owner drop and zero participants follow. Unproved cleanup quarantines,
never starts a replacement. Refusal/cleanup duration is not successful-lease
timing; Linux missing-EOF results are not macOS/Windows or universal coverage.

Candidate-untouched source review, reviewed checkpoint and affected hosted
contracts plus complete results review precede separately admitted runtime.
Fresh exact candidate/TEN/availability/unique owner and durable possible-start
are required before ONE send. Synthetic script mocks test routing/failure and
copy ownership only, not Rust/worker acceptance. This exposes no B/Editor/Full
permission, diagnostic renewal, gate waiver or physical-total memory proof.

For a separately reviewed finite practical confirmation,
`canonical_profile=c-query-practical` reuses the existing worker job with only
`ubuntu-latest` and `bash scripts/nir1-c-query-worker-ci.sh practical-retention`.
All other worker selections retain the original three OSes. Keep product mode
`all`, false booleans and empty canonical tuple/options; the same first guard
rejects mixed/case-variant/wrong-event inputs before checkout/setup. There is no
new input, job, registry profile, executor, dependency, timeout or default command.
The script also rejects non-Linux practical observation before fixture creation.

This branch builds only the original closed synthetic Q512/R2/A3-eligible-shared
fixture and the separate default-feature worker. It runs the existing
`native_worker_practical_retention_q512_30x`, then the existing maximum accepted
512-charged-row Q512 case once, on **distinct fresh copies**. This is the C-query
maximum fixture, not the whole-project Q2044 capacity diagnostic. Each repeat
checks full independent canonical Gold and a valid lease within 100 ms, releases
that lease and requires actual exit, necessary EOF and all successful joins
before claim reloan, owner drop and zero participants, before the next owner.
Pristine-source checksum/sidecar checks, fresh input-copy checksums and the
original owned cleanup trap remain fail-closed; no Q2 or original eleven-case
suite is replayed. SQLite preflight may leave WAL/SHM on its own disposable input;
these are recorded by role/suffix/byte count, never reused by the separate maximum
case, and removed only by the original owned fixture cleanup trap.

The exact opt-in `NIR1_C_QUERY_PRACTICAL_OBSERVE=1` records fixture bytes/work scale,
OS/architecture and numeric VmRSS/VmHWM KiB snapshots of only the test parent and
its exact owned READY worker. Parent snapshots also occur while holding the
validated lease and after proved retirement. No sampler child/thread, PID scan,
allocator hook or raw status/environment/argv is added. Sampling is outside
admission-to-lease measurement and missing usage fails the opted-in purpose.
Worker READY snapshots are **not full-query peaks**, and observed values are not
thresholds, physical-total bounds, RSS-baseline requirements or leak-free claims.
Concrete retention/growth/OOM/stall requires causal work, not rerun-to-green.

Source review, reviewed checkpoint, affected hosted routing contracts and their
actual results review precede separately admitted practical execution. Runtime
requires fresh exact candidate/TEN inputs, scoped availability, unique owner and
file/directory-fsynced possible-start before one send. Script mocks establish
routing only, not Rust/SQLite/31-query/usage/retirement acceptance. This maintained
finite functional confirmation neither renews consumed diagnostic purposes nor
waives B/Full, final acceptance or canonical gates. The removed aggregate physical
6 MiB and substitute Native 1.5 MiB proofs stay deleted.

For a separately reviewed shared-Rust lane, `canonical_profile=shared-rust`
selects **only the complete existing `rust` job**. This reuses the registered
workflow and its existing string input; it adds no dispatch input or executor.
Keep product mode `all`, all booleans false, and candidate tuple/options empty.
The job's first literal shell guard rejects mixed inputs and nonliteral case
before checkout/setup. Other malformed profiles still go to the canonical
owner for rejection. Default/reusable CI, the ten-job independent selection,
all six Cargo invocations, features, dependencies, build-profile environment,
cache and 30-minute timeout are unchanged. The shared Rust job explicitly empties
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `OPEN_ROUTER_API_KEY`,
`ANTHROPIC_API_KEY` and `SAKANA_API_KEY`, overriding inherited credentials for
both standalone and default/reusable callers. The unfiltered suite includes
16 credential-gated live-provider bodies; their no-key early-return libtest OK
is **not** live-provider qualification. Model-dependent early returns likewise
prove no model/performance qualification. Credentialed maintainer-local
qualification remains separate. No provider credentials are read or logged by
CI admission. Source proof uses the existing canonical
`contracts` route, including affected selection and adversarial shell contracts.
Neither the selector nor source proof attests consumer safety, actual-runner
resources or a Rust pass: reviewed current consumers/prerequisites and applicable
workload-derived resource checks still precede the distinct ordinary dispatch.
No Electron/runtime journey, keyring/provider service, namespace probe, model
installation, diagnostics or Full is added. Native and migration lanes remain
separate deferred work, not implicitly cleared by this connection.

For independently admitted development N-API compilation, `canonical_profile=native-development-build`
selects the same **existing `electron-native` owner** and only the original
`pnpm napi:build` command. The existing development build/test step is split into
adjacent steps: empty/default and reusable callers still build then run the
complete public test command in the original order. This manual build selection
skips public tests, release-feature check/clippy/tests and licensed MCP tests,
not passing or replaying them. Package `build` remains `napi build --release`
with default features; no module is loaded or Backend constructed by this build.

Keep product mode `all`, false booleans and empty canonical tuple/options. The
literal guard rejects mixed inputs, case variants and wrong events before
checkout/setup; unknown profiles reach canonical rejection. All original setup,
frozen dependencies, cache, environment, runner and 90-minute timeout remain,
with no new input/job/executor or test filter. Build scripts and dependency
fetches are real effects within the original ordinary frozen-build scope.
Review actual current consumers and applicable prerequisites before a distinct
dispatch. Source contracts and a build result are not public-test/Native abort,
release-feature runtime, maintenance/listener joins, Nativelease/reuse, Windows
cleanup, complete native CI, B or Full evidence.

For separately admitted development public tests, `canonical_profile=native-development-tests`
selects the same **existing `electron-native` owner** and the adjacent original
`pnpm napi:build` then **complete, unfiltered**
`pnpm --dir electron/native/grimodex-node test`. A new ephemeral runner builds
its own development module in that same job/workspace; the earlier standalone
build result is not transferred or arbitrarily replayed for a receipt. Existing
success semantics prevent tests after setup/build failure or cancellation.
Release-feature check/clippy/tests and licensed MCP tests are skipped, not passed.
Empty/default and reusable calls retain all six original commands in order,
setup, frozen dependencies, cache, features, environment, runner and 90-minute
timeout. No new input/job/executor, per-file test filter or fixture is added.

Use product mode `all`, false booleans and empty canonical tuple/options. The
first literal guard includes this fourth fixed native selection and rejects
mixed inputs, case variants and wrong events before checkout/setup; malformed
profiles still reach canonical rejection. Source review and affected coherent
contracts proof precede a separate fresh admission of actual consumers,
loopback synthetic-key mocks, cancellation and egress before any runtime
purpose. Ordinary process/job results are not individual Backend/listener/
maintenance joins, Native lease/reuse/retirement, Windows cleanup, release-feature
runtime, B/Editor or Full evidence; this connection grants none of those.

For independently admitted release-feature compilation, `canonical_profile=native-release-static`
selects the **existing `electron-native` owner** and only these unchanged commands:
- `cargo check --manifest-path electron/native/grimodex-node/Cargo.toml --features licensing,legacy-keyring-migration`
- `cargo clippy --manifest-path electron/native/grimodex-node/Cargo.toml --all-targets --features licensing,legacy-keyring-migration -- -D warnings`

The development N-API build/public tests, release-feature Rust tests and licensed
MCP tests are skipped, not passed. Clippy compiles test targets but does not run
them. Empty/default and reusable callers retain every original command, setup,
frozen dependencies, cache, debug profiles, runner and 90-minute timeout. No new
input/job/executor or per-file filter is added. Use product mode `all`, false
booleans and empty canonical tuple/options; the first literal guard rejects
mixed inputs, case variants and wrong events before checkout/setup. Unknown
profiles still reach canonical rejection. A successful run proves only those
original compile commands, not native runtime/maintenance/disposal/listener retirement, keyring/provider
activation permission, Windows cleanup, complete native CI, B or Full. Existing
build scripts/dependency downloads still execute and need their original approved
build scope. Review current source and applicable prerequisites before a distinct
ordinary dispatch; source contracts do not admit unsafe runtime consumers.

For separately admitted release-feature runtime tests, `canonical_profile=native-release-tests`
selects the same **existing `electron-native` owner** and only the original complete,
unfiltered `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --features licensing,legacy-keyring-migration`.
Cargo builds its own test target in that new job; no development `.node` or earlier
compile receipt is transferred. Development build/public tests, release-feature
check/clippy and licensed MCP are skipped, not passed or replayed. Empty/default
and reusable callers keep all six original commands in order, setup, frozen
dependencies, cache, environment, features, runner and 90-minute timeout.

Keep product mode `all`, false booleans and empty canonical tuple/options. The
first literal guard accepts this fifth fixed native selection; mixed inputs,
case variants and wrong events reject before checkout/setup, and malformed
profiles still reach canonical rejection. No new input/job/executor, per-file
filter, fixture or timeout is added. Actual source review and affected coherent
contracts proof precede separate fresh recovery/maintenance, loopback, license/
keyring-consumer and cancellation/egress admission. Feature presence is not
permission to call a real keyring, provider or service. Existing Rust tests use
injected credential lookups and synthetic workspaces; their detached recovery
status/Drop and an ordinary Cargo/job result are not individual maintenance/
Native lease joins, Windows cleanup, B/Editor or Full evidence. The hosted job's
90-minute bound is not Full's separate `native.tests` 900-second process bound.

For independently admitted licensed MCP proof, `canonical_profile=native-licensed-mcp`
selects the same **existing `electron-native` owner** and only its unchanged
`cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-mcp --features licensing`
command. The development N-API build/public tests, release-feature check/clippy
and native Rust tests are skipped, not passed or replayed. Default/reusable
callers retain all original commands, setup, frozen dependencies, cache, profiles,
runner and 90-minute timeout. Keep product mode `all`, false booleans and empty
canonical tuple/options. The existing literal guard accepts only the five fixed
native selections and rejects mixed, case-variant and wrong-event inputs before
checkout/setup; unknown profiles still reach canonical rejection. No new
input/job/executor or test filter is added.

This is the original unfiltered licensed MCP test command, not a sidecar launch
or permission to use a live MCP client/provider/keyring/service. Current tests
use synthetic in-memory SQLite, injected license files and one in-process rmcp
duplex; the binary test harness does not invoke its stdio `main`. Review actual
consumers, cancellation/close ownership and applicable prerequisites before a
distinct dispatch. Source contracts do not admit runtime effects. Enclosing
Cargo/job results are not individual native maintenance joins, listener
retirement, successful fixture deletion, Windows cleanup, Nativelease/noescape,
complete native CI, B or Full evidence. Existing build scripts/dependency
fetches remain real effects within the original ordinary frozen-build scope.

For the preserved migration ownership regressions, `canonical_profile=migration-crash`
selects the **existing `migration-recovery-gate` owner**, but only its unchanged
`Subprocess crash recovery` step: `cargo test -p grimodex-db --features test-failpoints
--test migration_subprocess_crash --test restore_subprocess_crash` in `src-tauri`.
It is affected Cargo proof, **not a complete Gate A2 pass**. No new input or job is
added. Keep product mode `all`, all booleans false and canonical tuple/options
empty. The first literal guard rejects mixed inputs, case variants and wrong events
before checkout/setup. Unknown profiles still reach the canonical rejecting owner.
Default/reusable CI retains all eight migration test commands; bootstrap, frozen
dependencies, cache, debug-free profiles and the 45-minute timeout are unchanged.

This is selector preparation, not resource admission or permission to dispatch
heavy Cargo. The same-job assessment connection remains to be implemented and
reviewed before execution. It must resolve actual Cargo config/target/cache and
SQLite fixture temp storage after the existing final setup/cache restore, then
assess writable capacity, separate root/home pressure, applicable temp quota,
competing heavy work and workload-derived retained/peak build/link/test/log demand
at actual concurrency. A cache hit, small synthetic fixtures or debug-free profiles
alone do not establish capacity. Real unknowns stop the heavy operation; no fixed
threshold, default serialism, old-runner facts, deletion, foreign-process kill,
temp rewriting, approval gap, replacement runner, Boolean attestation or new
receipt/executor substitutes for this assessment. Necessary same-job wiring can
be authored before target facts are held; this is not a requirement for preexisting
runner evidence or a separate preflight-only campaign. Source contracts exercise
the new selection and adversarial guards, not the Rust tests or resources.

For the remaining Safe Mode failpoint target, `canonical_profile=migration-safe-mode`
selects the same existing `migration-recovery-gate` owner and only its unchanged
`Safe Mode structured outcome + restore-by-id` step: `cargo test -p grimodex-db
--features test-failpoints --test workspace_safe_mode_outcome` in `src-tauri`.
The subprocess crash step and six other migration commands are skipped, not
passed or replayed. Empty/default and reusable selection still run all eight
commands; bootstrap, frozen dependencies, cache, profiles and timeout are unchanged.
Use product mode `all`, false booleans and empty canonical tuple/options. The
first literal guard rejects mixed inputs, case variants and wrong events before
checkout/setup; unknown profiles reach canonical rejection. No input/job/executor,
provider, Electron or service activation is added. Review actual consumers and
apply original risk-derived applicable prerequisites before a distinct dispatch;
selector/source-contract success is not Cargo, complete Gate A2, resource admission,
B authority or Full evidence.

For the remaining failpoint-enabled library command, `canonical_profile=migration-library`
selects the same existing `migration-recovery-gate` owner and only its unchanged
`Migration recovery failpoint library tests` step: `cargo test -p grimodex-db
--features test-failpoints --lib` in `src-tauri`. This is the original unfiltered
library command, including restore/recovery failpoint units, not a complete Gate A2
pass. The successful crash/Safe Mode steps and five other commands are skipped,
not replayed or passed. Default/reusable callers retain all eight commands and
the same bootstrap, frozen dependencies, cache, profiles and timeout. Keep product
mode `all`, false booleans and empty canonical tuple/options; the first literal
guard rejects mixed inputs, case variants and wrong events before checkout/setup.
Unknown profiles reach canonical rejection. No input/job/executor or test suppression
is added. Actual library consumers and original risk-derived applicable prerequisites
must be reviewed before a distinct dispatch; source proof alone does not authorize
Cargo, ignored real-worker/diagnostic cases, B or Full.

For grouped remaining migration proof, `canonical_profile=migration-remaining`
selects only four unchanged steps on the same existing `migration-recovery-gate`
owner, in their original order:
- `cargo test -p grimodex-db --test workspace_migration_supervisor` (in `src-tauri`)
- `cargo test -p grimodex-db --test release_schema_migration` (in `src-tauri`)
- `pnpm test:electron --run electron/shared/ipcContract.test.ts`
- `pnpm test --run src/features/workspace/store.test.ts src/features/workspace/recovery/RecoveryShell.test.tsx`

The failpoint supervisor, crash, Safe Mode and failpoint library commands are
skipped, not replayed or passed by this selection. Their earlier results retain
only their original candidate/command scopes. Broad workspace/frontend/Electron
proof is not an exact receipt for these four named commands. Default/reusable
callers retain all eight commands, bootstrap, frozen dependencies, cache, debug
profiles and timeout. Keep product mode `all`, false booleans and empty canonical
tuple/options; the literal guard rejects mixed inputs, case variants and wrong
events before setup. Unknown profiles reach canonical rejection. No new input,
job, executor, command filter or fixture is added. Review the actual DB/SQLite,
pure IPC fake-backend and mocked renderer consumers and apply original risk-derived
applicable prerequisites before dispatch. Source contracts and this partial
selection are not complete/current Gate A2, resource admission, native lifecycle,
B authority or Full proof; native/runtime/3OS lanes are not implicitly selected.

The ten-job independent selection is negative job selection, not resource admission, complete normal CI,
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

Before **any** pnpm/Node/Rust/uv setup action or system/package/browser/audit
installation, Full now calls `scripts/local-ci-full-admission.mjs --setup` using
only preinstalled Node/Python/git. This initial decision assesses the reviewed
setup envelope (toolchains, download caches, extraction, environments, system
writes and complete logs), actual workspace/root/home/tool-cache/Cargo/rustup/temp
capacity and caller quotas under same-job hosted exclusion. Full's setup step
explicitly supplies the pnpm action destination (`FULL_PNPM_DEST`), pnpm store
(`npm_config_store_dir`), Playwright cache (`PLAYWRIGHT_BROWSERS_PATH`) and uv cache
(`UV_CACHE_DIR`) from the actual runner tool-cache root. These are existing
installer/consumer settings, not temp-path rewrites. The dependency-free helper
rejects absent, relative or multiline settings rather than guessing defaults.
It assesses the pnpm installer, store root and pinned pnpm 10's `v10` store,
browser cache and uv cache **before installations**, including disjoint mounts.
Only successful setup exports those same settings through `GITHUB_ENV`; the pnpm
action's `dest` uses the assessed setting. Quick/contracts keep their default
placement and never run this Full-only export. The helper has no
static product-plan/package imports. Missing sizing, capacity or quota rejects
before the installations; Quick/contracts retain their existing setup path.
Installer-created project placement is not inferred from an ancestor: enabled
project quotas require an actual destination-placement acquisition and currently
reject. User/group quotas and disabled project domains are acquired, not guessed.

The deeper shell connects the same helper after candidate/ancestry validation.
It consumes the successful initial decision bound to the **unchanged entire
estimate**, candidate, registry, option and run/attempt before importing the
product plan or starting preparation. Initial setup and deeper preparation have
separate non-recoverable phase owners; no stale retry or runner transfer. Failed
setup logs are included in the existing canonical evidence upload even when the
profile step is skipped. Setup admission is not a measured Full pass. **Both source refusals remain**: source review,
affected hosted contracts, the reviewed workload-sizing producer and remaining
candidate/B prerequisites must close before enabling Full. Even a successful
helper is currently followed by the second refusal. This is a conditional
mechanism source milestone, not completed admission or a Full pass.

The helper uses the existing registry and process supervisor. It derives required
materialization/build-only preparation from the actual Full commands, adds the
existing C-query release compilation tuples, and converts Cargo tests to
`--no-run` without changing features, profile or environment. Clippy consumers
become equivalent Cargo `check` tuples: compilation target/features/profile/env
are preserved and the Clippy-only trailing rustc lint arguments are removed.
It never runs tests, lint gates, fixtures, a bus or Editor. Doctest execution/compilation remains residual risk.
Effective storage comes from Cargo metadata in both package/root caller contexts,
pnpm and uv cache queries, and Playwright's executable path. These queries must
agree with their already-assessed initial destinations before product-plan
imports or preparation; a different store format/config/cache path rejects rather
than silently assessing it only after its writes. On this Linux lane the actual
Chromium path identifies its cache root, not just the revision directory.
Cargo/rustup home,
Electron's existing installer cache, uv environment, workspace, root/home and both
temp destinations are included. Existing ancestors are observed without creating
or rewriting consumer directories. Caller writability is checked separately from
privileged quota visibility.

`local-ci-full-filesystems.py` reads the actual mounts/statvfs and invokes Linux
`quotactl` for the current caller's user, all applicable groups and effective
project. Applicable groups include the resolved destination's group even outside
caller membership when the directory is SGID or its actual ext4 mount uses
`grpid`/`bsdgroups` (including non-SGID directories). Both mount and superblock
option tokens are read from mountinfo for that destination's mount. A missing
destination uses its nearest existing ancestor's inherited group under either
mode. An unreadable enabled group record rejects.
`sudo -n` supplies only quota visibility, not installation or mutation.
The initial implementation supports ext4's generic quota interface: other actual
filesystem types fail with a missing quota-acquisition operation. Only kernel
`ESRCH` establishes a disabled domain; permission/unsupported/unknown responses
reject. Enabled limits include soft ceilings even during grace, expired grace,
current usage and inode limits; zero kernel limits are unbounded, not guessed
empty-quota attestations. Labels on a shared device share capacity exactly once,
while root/home pressure remains separately observed. All retained, transient,
failure-copy and uncertainty terms are summed conservatively per device; no
fixed GB/percentage/inode threshold or serial-execution assumption is used.

Before setup, the existing helper ingests the fixed Git-tracked dataset
`scripts/local-ci-full-workload-allocation.json`, validates its reviewed physical
allocation inventories, and exclusively creates
`.artifacts/local-ci/full-workload-input.json` and `full-workload-estimate.json`
inside the existing durable setup owner. These are **internal risk data**, not
canonical receipts or admission Booleans. The canonical pre-install `--setup`
invocation performs this ingestion itself; a fresh checkout does not need an
ignored input already bound to an unknowable future run. Missing necessary
numerical facts name the required dataset/inventory acquisition operation and
stop before installations. No nominal
estimate, old local capacity, zero residual or default coefficient is supplied.
The generated estimate contains:

- `binding`: exact expanded base/head/tree, registry digest, scheduler option,
  current hosted run ID and attempt; old-run/candidate evidence is rejected.
- `sources`: repository-relative sizing-source paths and current SHA-256 digests.
- `tasks`: every actual Full task exactly once, not a partial profile.
- `setup`: `workflowSha256` binds all current canonical setup/install actions;
  explicit source-grounded retained/transient/uncertainty terms cover **every**
  observed setup location, including tool-cache and root/home/temp. These are
  conservative coexisting demands, not installed-action success booleans.
- `preparation`: each derived tuple ID/command digest, finite timeout and explicit
  retained/transient/uncertainty byte/inode risk terms **before** that operation.
- `residual`: named positive byte/inode terms with effective location, kind,
  source references, sizing basis and concrete observation/construction operation.
  Required domains include build/link/doctest, simultaneous fixture DB/WAL/backup,
  failure tmpRoot/artifact-copy coexistence, cache/environment and complete
  logs/reports. Build terms connect to actual same-job preparation observations
  through `measurement: { preparationId, mode: retained | peak, location }`.

### Reviewed allocation ingestion

The fixed dataset uses `full-workload-allocation/1` and exactly these keys:
`version`, `registryDigest`, `maxParallelTasks`, `sources`, `inventories`, `setup`,
`preparation`, `tasks`. The final five fields have the input structure below;
registry digest and scheduler option must match the current invocation. It has
**no** supplied base/head/tree/run/attempt binding, executable command, URL,
admission flag or copy multiplier. The existing setup owner constructs the exact
current binding after its supervised clean-candidate/ancestry checks.

Dataset bytes must equal `git show <current-head>:<fixed-path>` and its tracked
mode must be a regular file. All sizing sources must be distinct, Git-tracked,
non-symlink regular files inside the checkout, with current SHA-256 digests. In
addition to workflow/registry/fixture/journey sources, ingestion requires the
admission/filesystem/supervisor/plan/runner source, package manifest/pnpm lock and
both shared/native Cargo manifests/locks. The dataset is excluded from its own
source list to avoid a self-referential hash; its exact byte digest is recorded
separately in the private setup `workload-acquisition.json`.

The complete producer validates all required allocation quantities/roles/recipes
**before** creating run input. Input, estimate and acquisition record use exclusive
`wx`, mode0600, file and directory fsync, and cancellation checks before success.
The acquisition record binds dataset/input/estimate digests and the current run.
Preparation re-ingests the same committed dataset and verifies this record and
byte-identical input/estimate before imports or heavy work. Missing/partial/stale
records reject; failed or cancelled writes retain the phase owner and outputs.
There is no overwrite, retry, reentry or stale-owner/restart recovery path.

The dataset must be populated through actual public/synthetic physical allocation
observations or justified source-grounded cold-operation forecasts and independent
review. This source connection does **not** supply missing numerical inventories:
no dataset is manufactured from the synthetic contract numbers, source lengths or
compressed artifact sizes. No new profile, job, dispatch input, external download
or configuration fallback is added. Both Full fences and separate B/Editor
prerequisites remain until their actual gates close.

### Constructive workload-risk producer

`produceWorkloadEstimate` in the existing admission helper uses only Node stdlib
and the existing dependency-free product-journey catalog before installations.
The exclusively generated `full-workload-input/1` input has the same exact
current-run `binding` and reviewed current `sources` as the estimate, plus:

- `inventories`: distinct `{ id, sources, basis, operation, items }` records.
  Each item names a distinct physical allocation `role` and decimal-string
  `bytes`/`inodes`. Installer components additionally require an effective
  `location` label; `(role, location)` is unique and each component has positive
  allocation. Other inventories retain distinct roles. Members are summed, not inferred from source length, lockfile
  counts, compressed download size or an arbitrary multiplier. `basis` records
  the observation/constructive forecast, applicable assumptions and uncertainty;
  `operation` names the concrete payload inventory, build/link observation or
  synthetic fixture/failure sizing acquisition. Reviewed forecasts are necessary
  before cold operations, not certificates of all future allocations. Inventories
  must be public/synthetic and source-grounded; never inspect a private work or
  production DB, publish raw environment/endpoints, or rehearse Editor/fixtures
  under this producer. Numeric examples in source contracts are synthetic ONLY.
- `setup`: recipes `{ kind, domain, location, inventories }` covering retained,
  transient and explicit additive uncertainty at every actual initial destination.
  All eight `install.pnpm/node/rust/system/uv/packages/browser/audit` inventories
  must be consumed; each covers `installed`, `download-cache`, `extraction`, and
  `logs`. Installed components must cover their finite actual destinations:
  pnpm → `pnpm-installer`; Node/uv → `tool-cache`; Rust → `cargo-home` and
  `rustup-home`; system/browser install-deps → `root`; packages → `workspace`,
  `pnpm-store-root` and `pnpm-store`; audit → `cargo-home`. Chromium binary
  materialization remains preparation demand at the already-assessed browser
  cache. Download/extraction components may occupy those installer destinations
  or the observed temporary roots; local complete logs occupy `workspace`.
  Unknown/unsupported component placement requires its concrete acquisition
  operation, not an arbitrary location with available space. Each component
  must be consumed by a setup recipe at **its own location**; recipes sum only
  that location's components. Merely naming an installer inventory somewhere
  else is rejected, even if unrelated workspace/root capacity would fit. Include
  system writes, Cargo audit compilation and cache placement, not just final
  binaries.
- `preparation`: actual tuple `{ id, commandDigest, timeoutMs, terms }` records.
  `terms` are the same recipes. Every tuple has finite timeout and all three kinds;
  forecasts cover materialization, build/link temporary outputs and complete logs
  before starting it. The later real plan validates every tuple/feature/env digest.
- `tasks`: every Full task `{ id, terms }`, including explicit retained/transient/
  uncertainty and complete log/report demand per task. Build/link/doctest residuals
  include a recipe's `measurement: { preparationId, mode: retained | peak,
  location }`, tied to the same effective destination. Observed same-job growth
  raises that positive forecast; no-growth cached builds cannot erase it.

The producer adds mandatory constructive fixture/failure coexistence terms rather
than leaving them to a nominal residual:

- `worker.q2` and `worker.q512` inventories contain `db`, `wal`, `shm`, `journal`
  and `construction` allocation risks. The current default script supplies its
  actual pristine-plus-input counts (seven Q2 and three Q512), without counting
  opt-in lanes or assuming query completion releases files. The script's actual
  `RUNNER_TEMP`-first precedence determines the charged temporary location.
- `c2zc.fixture` covers simultaneous `db`, `wal`, `shm`, official `backup`,
  `standalone` materialization and `manifest` allocations. Mandatory `backup`
  roles in this inventory and every journey failure inventory require positive
  bytes **and** inodes independently of other roles' positive totals; zero backup
  allocation rejects with that inventory's concrete acquisition operation.
  Logical manifest file lengths alone do not substitute for this physical forecast.
- Every actual catalog case has `journey.<id>.runtime` (`db`, `wal`, `shm`,
  `user-data`, `cache`, `logs`, `receipts`, `other`) and `.failure` (`backup`,
  `receipt-snapshot`, `diagnostics`, `screenshot`) inventories. Each must cover
  **all** its owned workspaces/restarts and failure observations. For every case,
  runtime plus failure snapshots/diagnostics are charged once to retained Node
  tmpRoot and once to the workspace artifact copy; the separate `renderer.png`
  copy is additional. All cases coexist conservatively, with no serial/fail-fast
  saving and no screenshot/log/upload suppression.
- `fixtures.uncertainty` explicitly includes `sqlite-allocation`, `failure-copy`
  and `unsampled-transient` risks with a justified additive basis, not a default
  percentage. It is reserved independently at worker temp, Node temp and artifact
  destinations to avoid borrowing headroom across devices. Every supplied inventory
  is consumed; duplicates, omitted roles or silently unused demand reject.

The setup producer writes the estimate using exclusive creation plus file/directory
fsync. It never overwrites/regenerates a failed or uncertain record. Preparation
consumes the same entire estimate and unchanged input digest, and rejects changed
initial destination/environment placement. Source digests and actual deeper Full
coverage are revalidated, with existing process/phase ownership unchanged. The
actual runner's applicable quotas/capacity and exclusion are still independently
acquired; reviewed numerical input is not proof that they fit. Necessary target
inventories remain to be acquired/reviewed; source implementation and synthetic
contracts are not an executed resource admission or Full pass. Both Full fences
and independent B/Editor prerequisites remain.

These are defensible estimates with explicit uncertainty, not mathematical
all-future allocation certificates. A cached/no-growth preparation does not zero
a reviewed residual. Sampling records retained changes and observed high-water
allocation; envelope overruns cancel only the owned preparation and reject without
retry. Preparation children must really close, complete log-file joins and retire
their groups, and the sampler must join before subsequent admission. Complete logs
are retained, never truncated. Capacity/quota and candidate identity are reacquired
after preparation; sampled growth raises relevant residuals before comparison.

Heavy-work exclusion relies on the fixed standard `ubuntu-24.04` hosted job's
[fresh single-job VM contract](https://docs.github.com/en/actions/using-github-hosted-runners/about-github-hosted-runners),
corroborated by actual hosted-run metadata and Linux VM identity, plus sequential
owned preparation with all required joins. Neither a Boolean, checkout lock nor
scheduler limit proves exclusion. Self-hosted/container/unknown targets reject.
One private run/attempt owner refuses reentry; errors and uncertain retirement
retain it with the existing supervisor. Nothing deletes caches, kills foreign
processes, scans foreign `/proc` or acquires/recovers the CLI's checkout lock.
The fixed canonical caller must retain the same job through Full and adjacent
identical-tuple verify, with no approval wait, intervening heavy work or replacement
runner. Internal records/logs use the existing `.artifacts/local-ci/` upload; the
canonical receipt format and gate commands are unchanged.

Source contracts exercise synthetic setup/preparation demand/quota/owner/observation
adversaries (including disjoint pnpm/browser filesystems, misplaced installer
components, missing explicit settings and post-install query disagreement),
verify that the initial helper imports without installed packages,
assert that no Clippy gate runs and that all eight setup/install steps follow the
initial decision, and shim the hosted call. They do not prepare dependencies or
probe host quotas.
Real reviewed preparation and actual resource/B acceptance remain pending.
D-Bus capability, candidate acceptance and Full/merge readiness are independent;
this connection does not authorize them.

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
