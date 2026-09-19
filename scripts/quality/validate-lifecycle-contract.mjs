#!/usr/bin/env node
/* eslint-disable no-undef */

/**
 * Reproducible focused gate for the PR #600 lifecycle slice.
 *
 * This command is intentionally a contract/Layer-A+Layer-B gate. It does not
 * claim the complete Layer-C Electron journey matrix; those journeys remain
 * separate evidence in C5. Keeping the contract assertions here prevents a
 * later implementation from silently dropping one of the T01-T36 labels or
 * one of the five C0 distinctions.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(new URL("../..", import.meta.url).pathname);
const contractPath = resolve(root, "docs/plans/pr600-lifecycle-replacement.md");
const contract = readFileSync(contractPath, "utf8");

const requiredMarkers = [
  "pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle",
  "NotAdmitted",
  "Unchanged",
  "CreationUnknown",
  "CreationNotCommitted",
  "Full ordinary delivery rejects submit",
  "Freshness",
  "I7-P",
  "I7-L",
  "shutdown",
];
for (const marker of requiredMarkers) {
  if (!contract.includes(marker)) {
    throw new Error(`lifecycle contract is missing required marker: ${marker}`);
  }
}
for (let index = 1; index <= 36; index += 1) {
  const id = `T${String(index).padStart(2, "0")}`;
  if (!new RegExp(`\\b${id}\\b`).test(contract)) {
    throw new Error(`lifecycle contract is missing acceptance case ${id}`);
  }
}

const run = (args) => {
  execFileSync("cargo", args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
};

run([
  "test",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "-p",
  "grimodex-db",
  "--lib",
  "workspace_lifecycle",
]);
run([
  "test",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "-p",
  "grimodex-db",
  "--lib",
  "lifecycle_control_stops_before_reservation_and_valid_control_progresses",
]);

if (process.env.GDX_LIFECYCLE_SKIP_NATIVE !== "1") {
  run([
    "test",
    "--manifest-path",
    "electron/native/grimodex-node/Cargo.toml",
    "workspace_lifecycle_view",
  ]);
  run([
    "test",
    "--manifest-path",
    "electron/native/grimodex-node/Cargo.toml",
    "native_open_restore_only_tests",
  ]);
}

console.log(
  "Lifecycle contract gate passed (contract markers, Layer A, and focused Layer B; Layer C is separate evidence).",
);
