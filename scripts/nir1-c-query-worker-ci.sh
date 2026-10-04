#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

os_name="$(uname -s)"
is_windows=false
if [[ "${RUNNER_OS:-}" == "Windows" || "$os_name" == MINGW* || "$os_name" == MSYS* || "$os_name" == CYGWIN* ]]; then
  is_windows=true
fi

temp_root="${RUNNER_TEMP:-${TMPDIR:-${TMP:-${TEMP:-/tmp}}}}"
if [[ "$is_windows" == true ]]; then
  temp_root="$(cygpath -u "$temp_root")"
fi
fixture_dir="$(mktemp -d "${temp_root%/}/nir1-c-query.XXXXXX")"

cleanup_fixture() {
  local status=$?
  trap - EXIT
  if ! rm -rf -- "$fixture_dir"; then
    printf 'failed to remove C-query fixture directory: %s\n' "$fixture_dir" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup_fixture EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s' \
  '{"schemaVersion":"nir1-capacity/1","diagnosticOnly":true,"fixtures":[{"id":"Q2/R1/D0-local","qualifiedMaterials":2,"qualifiedRevisions":1,"ineligibleCandidates":0},{"id":"Q512/R2/A3-eligible-shared","qualifiedMaterials":140,"qualifiedRevisions":1,"ineligibleCandidates":0}]}' \
  > "$fixture_dir/manifest.json"

q2_fixture_file="$fixture_dir/q2-preseed.db"
q512_fixture_file="$fixture_dir/q512-preseed.db"
q2_test_fixture_file="$fixture_dir/q2-worker-input.db"
q2_quarantine_test_fixture_file="$fixture_dir/q2-quarantine-worker-input.db"
q2_postcommit_test_fixture_file="$fixture_dir/q2-postcommit-worker-input.db"
q2_sql_steps_test_fixture_file="$fixture_dir/q2-sql-steps-worker-input.db"
q2_boundary_test_fixture_file="$fixture_dir/q2-boundary-worker-input.db"
q512_test_fixture_file="$fixture_dir/q512-worker-input.db"
q513_test_fixture_file="$fixture_dir/q513-worker-input.db"

assert_closed_fixture() {
  local fixture="$1"
  test -f "$fixture"
  for suffix in -wal -shm -journal; do
    test ! -e "$fixture$suffix"
  done
}

if [[ "$is_windows" == true ]]; then
  manifest_path="$(cygpath -w "$fixture_dir/manifest.json")"
  q2_fixture_builder_path="$(cygpath -w "$q2_fixture_file")"
  q512_fixture_builder_path="$(cygpath -w "$q512_fixture_file")"
  q2_worker_fixture_path="$(cygpath -w "$q2_test_fixture_file")"
  q2_quarantine_worker_fixture_path="$(cygpath -w "$q2_quarantine_test_fixture_file")"
  q2_postcommit_worker_fixture_path="$(cygpath -w "$q2_postcommit_test_fixture_file")"
  q2_sql_steps_worker_fixture_path="$(cygpath -w "$q2_sql_steps_test_fixture_file")"
  q2_boundary_worker_fixture_path="$(cygpath -w "$q2_boundary_test_fixture_file")"
  q512_worker_fixture_path="$(cygpath -w "$q512_test_fixture_file")"
  q513_worker_fixture_path="$(cygpath -w "$q513_test_fixture_file")"
  worker_file="$PWD/src-tauri/target/release/nir1-c-query-worker.exe"
  worker_path="$(cygpath -w "$worker_file")"
else
  manifest_path="$fixture_dir/manifest.json"
  q2_fixture_builder_path="$q2_fixture_file"
  q512_fixture_builder_path="$q512_fixture_file"
  q2_worker_fixture_path="$q2_test_fixture_file"
  q2_quarantine_worker_fixture_path="$q2_quarantine_test_fixture_file"
  q2_postcommit_worker_fixture_path="$q2_postcommit_test_fixture_file"
  q2_sql_steps_worker_fixture_path="$q2_sql_steps_test_fixture_file"
  q2_boundary_worker_fixture_path="$q2_boundary_test_fixture_file"
  q512_worker_fixture_path="$q512_test_fixture_file"
  q513_worker_fixture_path="$q513_test_fixture_file"
  worker_file="$PWD/src-tauri/target/release/nir1-c-query-worker"
  worker_path="$worker_file"
fi

cargo run --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --features nir1-material-diagnostics \
  --bin nir1-material-capacity -- \
  fixture "$manifest_path" Q2/R1/D0-local "$q2_fixture_builder_path" \
  > "$fixture_dir/q2-fixture-report.json"
grep -Fq '"caseId": "Q2/R1/D0-local"' "$fixture_dir/q2-fixture-report.json"
grep -Fq '"diagnosticOnly": true' "$fixture_dir/q2-fixture-report.json"
grep -Fq '"qualifiedMaterials": 2' "$fixture_dir/q2-fixture-report.json"
grep -Fq '"qualifiedRevisions": 1' "$fixture_dir/q2-fixture-report.json"
grep -Fq '"ineligibleCandidates": 0' "$fixture_dir/q2-fixture-report.json"
grep -Fq '"walBytes": 0' "$fixture_dir/q2-fixture-report.json"
grep -Fq '"shmBytes": 0' "$fixture_dir/q2-fixture-report.json"
grep -Fq '"reopenedReadOnly": true' "$fixture_dir/q2-fixture-report.json"
assert_closed_fixture "$q2_fixture_file"

cargo run --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --features nir1-material-diagnostics \
  --bin nir1-material-capacity -- \
  fixture "$manifest_path" Q512/R2/A3-eligible-shared "$q512_fixture_builder_path" \
  > "$fixture_dir/q512-fixture-report.json"
grep -Fq '"caseId": "Q512/R2/A3-eligible-shared"' "$fixture_dir/q512-fixture-report.json"
grep -Fq '"diagnosticOnly": true' "$fixture_dir/q512-fixture-report.json"
grep -Fq '"qualifiedMaterials": 140' "$fixture_dir/q512-fixture-report.json"
grep -Fq '"qualifiedRevisions": 1' "$fixture_dir/q512-fixture-report.json"
grep -Fq '"ineligibleCandidates": 0' "$fixture_dir/q512-fixture-report.json"
grep -Fq '"walBytes": 0' "$fixture_dir/q512-fixture-report.json"
grep -Fq '"shmBytes": 0' "$fixture_dir/q512-fixture-report.json"
grep -Fq '"reopenedReadOnly": true' "$fixture_dir/q512-fixture-report.json"
assert_closed_fixture "$q512_fixture_file"

q2_fixture_checksum="$(cksum < "$q2_fixture_file")"
q512_fixture_checksum="$(cksum < "$q512_fixture_file")"
cp -- "$q2_fixture_file" "$q2_test_fixture_file"
cp -- "$q2_fixture_file" "$q2_quarantine_test_fixture_file"
cp -- "$q512_fixture_file" "$q512_test_fixture_file"
cp -- "$q512_fixture_file" "$q513_test_fixture_file"
test "$(cksum < "$q2_test_fixture_file")" = "$q2_fixture_checksum"
test "$(cksum < "$q2_quarantine_test_fixture_file")" = "$q2_fixture_checksum"
test "$(cksum < "$q512_test_fixture_file")" = "$q512_fixture_checksum"
test "$(cksum < "$q513_test_fixture_file")" = "$q512_fixture_checksum"
assert_closed_fixture "$q2_test_fixture_file"
assert_closed_fixture "$q2_quarantine_test_fixture_file"
assert_closed_fixture "$q512_test_fixture_file"
assert_closed_fixture "$q513_test_fixture_file"

assert_q512_source_unchanged() {
  test "$(cksum < "$q512_fixture_file")" = "$q512_fixture_checksum"
  assert_closed_fixture "$q512_fixture_file"
}

# Build this executable in a separate default-feature invocation.
cargo build --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --bin nir1-c-query-worker
test -f "$worker_file"

NIR1_Q2_FIXTURE_PATH="$q2_worker_fixture_path" \
NIR1_C_QUERY_WORKER_BIN="$worker_path" \
  cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
    -p grimodex-db --lib native_worker_returns_fixed_q2_frame_from_real_workspace_owner \
    -- --ignored --nocapture --test-threads=1

# This test intentionally quarantines process-global worker capacity; keep it in its own process.
NIR1_Q2_FIXTURE_PATH="$q2_quarantine_worker_fixture_path" \
NIR1_C_QUERY_WORKER_BIN="$worker_path" \
  cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
    -p grimodex-db --lib native_worker_quarantines_live_request_writer_after_cleanup_timeout \
    -- --ignored --nocapture --test-threads=1

NIR1_Q2_FIXTURE_PATH="$q512_worker_fixture_path" \
NIR1_C_QUERY_WORKER_BIN="$worker_path" \
  cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
    -p grimodex-db --lib native_worker_returns_canonical_512_a3_eligible_seed_local_graph \
    -- --ignored --nocapture --test-threads=1
assert_q512_source_unchanged

NIR1_Q2_FIXTURE_PATH="$q513_worker_fixture_path" \
NIR1_C_QUERY_WORKER_BIN="$worker_path" \
  cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
    -p grimodex-db --lib native_worker_refuses_exact_513_seed_local_unrelated_reverse_index_edge \
    -- --ignored --nocapture --test-threads=1
assert_q512_source_unchanged

# Keep the post-commit retirement case separate from ordinary-worker fixtures and runs.
cp -- "$q2_fixture_file" "$q2_postcommit_test_fixture_file"
cp -- "$q2_fixture_file" "$q2_sql_steps_test_fixture_file"
cp -- "$q2_fixture_file" "$q2_boundary_test_fixture_file"
test "$(cksum < "$q2_postcommit_test_fixture_file")" = "$q2_fixture_checksum"
test "$(cksum < "$q2_sql_steps_test_fixture_file")" = "$q2_fixture_checksum"
test "$(cksum < "$q2_boundary_test_fixture_file")" = "$q2_fixture_checksum"
assert_closed_fixture "$q2_postcommit_test_fixture_file"
assert_closed_fixture "$q2_sql_steps_test_fixture_file"
assert_closed_fixture "$q2_boundary_test_fixture_file"

cargo build --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --features nir1-c-query-test-seam --bin nir1-c-query-worker
NIR1_Q2_FIXTURE_PATH="$q2_sql_steps_worker_fixture_path" \
NIR1_C_QUERY_WORKER_BIN="$worker_path" \
  cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
    -p grimodex-db --lib native_worker_refuses_after_actual_sql_steps_over_cap \
    -- --ignored --nocapture --test-threads=1
test "$(cksum < "$q2_sql_steps_test_fixture_file")" = "$q2_fixture_checksum"
assert_closed_fixture "$q2_sql_steps_test_fixture_file"

NIR1_Q2_FIXTURE_PATH="$q2_boundary_worker_fixture_path" \
NIR1_C_QUERY_WORKER_BIN="$worker_path" \
  cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
    -p grimodex-db --lib native_worker_rejects_request_and_frame_length_n_plus_one \
    -- --ignored --nocapture --test-threads=1
test "$(cksum < "$q2_boundary_test_fixture_file")" = "$q2_fixture_checksum"
assert_closed_fixture "$q2_boundary_test_fixture_file"

NIR1_Q2_FIXTURE_PATH="$q2_postcommit_worker_fixture_path" \
NIR1_C_QUERY_WORKER_BIN="$worker_path" \
  cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
    -p grimodex-db --lib native_worker_accepts_committed_q2_frame_before_nonzero_exit \
    -- --ignored --nocapture --test-threads=1
test "$(cksum < "$q2_postcommit_test_fixture_file")" = "$q2_fixture_checksum"
assert_closed_fixture "$q2_postcommit_test_fixture_file"

cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --lib malformed_child_frame_rejected_before_view \
  -- --nocapture --test-threads=1
cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --lib native_region_bounds_request_and_frame \
  -- --nocapture --test-threads=1
cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --bin nir1-c-query-worker q_s_origins_no_fallback_failed_realloc_and_zero_live_seal \
  -- --nocapture --test-threads=1
