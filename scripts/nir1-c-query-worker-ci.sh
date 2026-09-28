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
  '{"schemaVersion":"nir1-capacity/1","diagnosticOnly":true,"fixtures":[{"id":"Q2/R1/D0-local","qualifiedMaterials":2,"qualifiedRevisions":1,"ineligibleCandidates":0}]}' \
  > "$fixture_dir/manifest.json"

if [[ "$is_windows" == true ]]; then
  manifest_path="$(cygpath -w "$fixture_dir/manifest.json")"
  fixture_path="$(cygpath -w "$fixture_dir/preseed.db")"
  worker_file="$PWD/src-tauri/target/release/nir1-c-query-worker.exe"
  worker_path="$(cygpath -w "$worker_file")"
else
  manifest_path="$fixture_dir/manifest.json"
  fixture_path="$fixture_dir/preseed.db"
  worker_file="$PWD/src-tauri/target/release/nir1-c-query-worker"
  worker_path="$worker_file"
fi

cargo run --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --features nir1-material-diagnostics \
  --bin nir1-material-capacity -- \
  fixture "$manifest_path" Q2/R1/D0-local "$fixture_path" \
  > "$fixture_dir/fixture-report.json"
grep -Fq '"caseId": "Q2/R1/D0-local"' "$fixture_dir/fixture-report.json"
grep -Fq '"diagnosticOnly": true' "$fixture_dir/fixture-report.json"
grep -Fq '"qualifiedMaterials": 2' "$fixture_dir/fixture-report.json"
grep -Fq '"qualifiedRevisions": 1' "$fixture_dir/fixture-report.json"
grep -Fq '"ineligibleCandidates": 0' "$fixture_dir/fixture-report.json"
grep -Fq '"walBytes": 0' "$fixture_dir/fixture-report.json"
grep -Fq '"shmBytes": 0' "$fixture_dir/fixture-report.json"
grep -Fq '"reopenedReadOnly": true' "$fixture_dir/fixture-report.json"
test -f "$fixture_dir/preseed.db"
for suffix in -wal -shm -journal; do
  test ! -e "$fixture_dir/preseed.db$suffix"
done

# Build this executable in a separate default-feature invocation.
cargo build --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --bin nir1-c-query-worker
test -f "$worker_file"

cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --lib malformed_child_frame_rejected_before_view \
  -- --nocapture --test-threads=1
cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --lib native_region_reserves_metadata_and_bounds_request \
  -- --nocapture --test-threads=1
cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --bin nir1-c-query-worker shared_query_region_bounds_rust_and_sqlite_allocations \
  -- --nocapture --test-threads=1
NIR1_Q2_FIXTURE_PATH="$fixture_path" \
NIR1_C_QUERY_WORKER_BIN="$worker_path" \
  cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
    -p grimodex-db --lib native_worker_returns_fixed_q2_frame_from_real_workspace_owner \
    -- --ignored --nocapture --test-threads=1
