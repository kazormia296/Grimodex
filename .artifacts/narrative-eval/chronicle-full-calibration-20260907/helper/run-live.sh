#!/usr/bin/env bash
set -euo pipefail
umask 077

helper_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="/home/grimodex/Grimodex/.artifacts/chronicle-source-support-v2-worktree"
receipt_root="/home/grimodex/Grimodex/.artifacts/narrative-eval/chronicle-full-calibration-20260907"
cd -- "$source_root"
if [[ ! -t 0 || ! -t 2 ]]; then
  printf '%s\n' 'live diagnostic requires a TTY on stdin and stderr' >&2
  exit 2
fi

run_id="$(/usr/bin/node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
run_output="$receipt_root/runs/$run_id"
scratch_root=""
if [[ -e "$run_output" ]]; then
  printf '%s\n' 'fresh run directory already exists' >&2
  exit 2
fi
scratch_root="$(mktemp -d -- "$receipt_root/.scratch-$run_id.XXXXXX")"
chmod 700 "$scratch_root"
mkdir -m 700 "$scratch_root/tmp"
cleanup() {
  local exit_status=$?
  trap - EXIT HUP INT TERM
  unset api_key
  if [[ -n "$scratch_root" && "$scratch_root" == "$receipt_root"/.scratch-* && -d "$scratch_root" ]]; then
    rm -rf -- "$scratch_root" 2>/dev/null || exit_status=1
  fi
  exit "$exit_status"
}
terminate() { exit 143; }
trap cleanup EXIT
trap terminate HUP INT TERM

set +e
env -i PATH="${PATH:-/usr/bin:/bin}" TMPDIR="$scratch_root/tmp" \
  /usr/bin/node "$source_root/node_modules/vitest/vitest.mjs" run \
  --config "$helper_root/vitest.config.ts" \
  --pool=threads --maxWorkers=1 --no-file-parallelism --testTimeout=3600000 \
  "$helper_root/binding-preflight.test.ts" \
  > /dev/null 2>&1
preflight_status=$?
set -e
if [[ "$preflight_status" -ne 0 ]]; then
  printf '{"status":"failed","terminalCode":"binding-failure","runId":"%s"}\n' "$run_id" >&2
  exit 1
fi

printf '{"status":"ready","runId":"%s","outputRoot":"%s/runs"}\n' \
  "$run_id" "$receipt_root" >&2
IFS= read -r -s -p 'OpenRouter API key: ' api_key < /dev/tty
printf '\n' >&2
if [[ -z "$api_key" ]]; then
  printf '%s\n' 'empty API key' >&2
  exit 2
fi

set +e
printf '%s\0' "$api_key" | timeout --foreground --signal=TERM --kill-after=15s 3600s env -i \
  PATH="${PATH:-/usr/bin:/bin}" \
  TMPDIR="$scratch_root/tmp" \
  CHRONICLE_RUN_ID="$run_id" \
  CHRONICLE_LIVE_SCRATCH="$scratch_root" \
  /usr/bin/node "$source_root/node_modules/vitest/vitest.mjs" run \
  --config "$helper_root/vitest.config.ts" \
  --pool=threads --maxWorkers=1 --no-file-parallelism --testTimeout=3600000 \
  "$helper_root/live-runner.test.ts" \
  > /dev/null 2>&1
child_status=$?
set -e
unset api_key

summary_status=1
summary=""
if [[ -f "$run_output/diagnostic-envelope.json" && -f "$scratch_root/fetch-progress.json" ]]; then
  set +e
  summary="$(env -i PATH="${PATH:-/usr/bin:/bin}" RUN_ID="$run_id" RUN_OUTPUT="$run_output/diagnostic-envelope.json" PROGRESS_PATH="$scratch_root/fetch-progress.json" CHILD_STATUS="$child_status" \
    /usr/bin/node --input-type=module -e '
      import { readFile } from "node:fs/promises";
      import { FAILURE_CODES } from "/home/grimodex/Grimodex/.artifacts/narrative-eval/chronicle-full-calibration-20260907/helper/live-driver.mjs";
      const value = JSON.parse(await readFile(process.env.RUN_OUTPUT, "utf8"));
      const progress = JSON.parse(await readFile(process.env.PROGRESS_PATH, "utf8"));
      const progressKeys = ["admittedRequests", "httpStatus", "maxRequests", "schemaVersion", "status"];
      const progressStatuses = new Set(["ready", "request-rejected", "request-budget-exceeded", "request-body-invalid", "request-input-limit-exceeded", "request-budget-overflow", "request-started", "transport-failure", "request-aborted", "request-timeout", "response-too-large", "response-read-failure", "invalid-http-status", "http-failure", "response-accepted"]);
      const progressShape = progress && typeof progress === "object" && !Array.isArray(progress) && Object.keys(progress).sort().join(",") === progressKeys.join(",") && progress.schemaVersion === 1 && progressStatuses.has(progress.status) && progress.maxRequests === 18 && Number.isSafeInteger(progress.admittedRequests) && progress.admittedRequests >= 0 && progress.admittedRequests <= 18 && (progress.httpStatus === null || (Number.isSafeInteger(progress.httpStatus) && progress.httpStatus >= 100 && progress.httpStatus <= 599));
      const envelopeShape = value && typeof value === "object" && !Array.isArray(value) && value.schemaVersion === 1 && value.kind === "chronicle-llm-judge-live-diagnostic" && value.runId === process.env.RUN_ID && value.terminal && ["complete", "failed"].includes(value.terminal.status) && (value.terminal.status === "complete" ? value.terminal.code === null : FAILURE_CODES.includes(value.terminal.code)) && Number.isSafeInteger(value.dispatchCount) && value.dispatchCount >= 0 && value.dispatchCount <= 18 && Array.isArray(value.dispatches) && value.dispatches.length === value.dispatchCount;
      if (!progressShape || !envelopeShape || progress.admittedRequests !== value.dispatchCount) process.exit(1);
      const code = value.terminal.code;
      process.stdout.write(JSON.stringify({ status: value.terminal.status, terminalCode: code, runId: value.runId, dispatchCount: value.dispatchCount, progressStatus: progress.status, admittedRequests: progress.admittedRequests }));
      process.exit(0);
    ')"
  summary_status=$?
  set -e
fi
if [[ "$summary_status" -ne 0 ]]; then
  printf '{"status":"failed","terminalCode":"runtime-failure","runId":"%s"}\n' "$run_id" >&2
  exit 1
fi
printf '%s\n' "$summary" >&2
set +e
launcher_exit_status="$(env -i PATH="${PATH:-/usr/bin:/bin}" \
  LAUNCHER_CHILD_STATUS="$child_status" \
  LAUNCHER_SUMMARY="$summary" \
  /usr/bin/node --input-type=module -e 'import { resolveLauncherExitCode } from "/home/grimodex/Grimodex/.artifacts/narrative-eval/chronicle-full-calibration-20260907/helper/live-driver.mjs"; const summary = JSON.parse(process.env.LAUNCHER_SUMMARY); process.stdout.write(String(resolveLauncherExitCode(Number(process.env.LAUNCHER_CHILD_STATUS), summary.status)));')"
decision_status=$?
set -e
if [[ "$decision_status" -ne 0 || ! "$launcher_exit_status" =~ ^[0-9]+$ ]]; then
  printf '{"status":"failed","terminalCode":"runtime-failure","runId":"%s"}\n' "$run_id" >&2
  exit 1
fi
exit "$launcher_exit_status"
