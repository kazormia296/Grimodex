#!/usr/bin/env bash
set -euo pipefail
umask 077

helper_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="/home/grimodex/Grimodex/.artifacts/chronicle-source-support-v2-worktree"
cd -- "$source_root"
vitest=(
  /usr/bin/node "$source_root/node_modules/vitest/vitest.mjs" run
  --config "$helper_root/vitest.config.ts"
  --pool=threads --maxWorkers=1 --no-file-parallelism --testTimeout=3600000
)
for test_file in \
  "$helper_root/binding-preflight.test.ts" \
  "$helper_root/calibration-driver.test.ts" \
  "$helper_root/controls.test.ts" \
  "$helper_root/key-reader.test.ts" \
  "$helper_root/launcher-summary.test.ts" \
  "$helper_root/openrouter-fetch-guard.test.ts" \
  "$helper_root/north-gate-driver.test.ts"
do
  env -i PATH="${PATH:-/usr/bin:/bin}" TMPDIR="${TMPDIR:-/tmp}" \
    "${vitest[@]}" "$test_file"
done
