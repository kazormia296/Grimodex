// Part assignment for the hosted Quick split. A part is a subset of the
// already-selected Light commands, run in selection order on its own VM; the
// union of all parts is exactly the unsplit selection. This module only decides
// which part runs a command; the selection rules live in impact-map.mjs.
import { createHash } from "node:crypto";

export const IMPACT_PART_COUNT = 3;

// Part 1: src-tauri cargo without extra features (grimodex-db/core/ai default).
// Part 2: src-tauri cargo with extra features (recompiles grimodex-db per set).
// Part 3: the N-API crate (own Cargo.lock / target directory).
// Non-cargo commands (pnpm / node) carry no shared build output, so they are
// dealt out in selection order over this pattern. Part 3 has the lightest
// cargo load and takes every other command; parts 1 and 2 split the rest.
const NON_CARGO_DEAL = Object.freeze([3, 1, 3, 2]);
const NATIVE_MANIFEST = "electron/native/grimodex-node";

export function parseImpactPart(value, count = IMPACT_PART_COUNT) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(String(value ?? ""));
  if (!match) throw new Error("--part requires <index>/<count>, for example 1/3");
  const part = { index: Number(match[1]), count: Number(match[2]) };
  if (part.count !== count || part.index > part.count) {
    throw new Error(`--part must name one of ${count} parts, as <index>/${count}`);
  }
  return part;
}

// ordinal counts only the non-cargo commands seen so far in selection order.
export function impactCommandPart(command, ordinal) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("Impact command must be a non-empty argv array");
  }
  if (command[0] !== "cargo") return NON_CARGO_DEAL[ordinal % NON_CARGO_DEAL.length];
  const manifestIndex = command.indexOf("--manifest-path");
  const manifest = manifestIndex === -1 ? "" : String(command[manifestIndex + 1] ?? "");
  if (manifest.includes(NATIVE_MANIFEST)) return 3;
  return command.includes("--features") || command.includes("--all-features") ? 2 : 1;
}

// Every (suite, step) of the selection, in selection order, with its part.
export function planImpactCommands(selection, definitions) {
  const entries = [];
  let ordinal = 0;
  for (const suiteId of selection.suiteIds) {
    const definition = definitions[suiteId];
    if (!definition) throw new Error(`No static command for suite ${suiteId}`);
    definition.commands.forEach((command, stepIndex) => {
      const nonCargo = command[0] !== "cargo";
      entries.push({ suiteId, stepIndex, command, part: impactCommandPart(command, ordinal) });
      if (nonCargo) ordinal += 1;
    });
  }
  return entries;
}

export function impactCommandKey({ suiteId, stepIndex }) {
  return `${suiteId}#${stepIndex}`;
}

export function partitionImpactCommands(selection, definitions, count = IMPACT_PART_COUNT) {
  const parts = Array.from({ length: count }, () => []);
  for (const entry of planImpactCommands(selection, definitions)) parts[entry.part - 1].push(entry);
  return parts;
}

export function impactSelectionDigest(selection) {
  return `sha256:${createHash("sha256").update(JSON.stringify(selection)).digest("hex")}`;
}
