#!/usr/bin/env node
// Pull-request lane skipping for .github/workflows/ci.yml (first stage).
//
// Deny by default: a lane is skipped only when EVERY changed path is in that
// lane's neutral sets, or (trigger lanes) when NO changed path is a trigger.
// Unclassified paths, forced-all paths, an empty or incomplete diff, an unsafe
// path, an exception, and every event other than pull_request run all lanes.
// The decision is made with the head's rules and, when the base commit has the
// file, with the base commit's copy of the rules too; a lane is skipped only
// when both skip it, so a pull request cannot skip a lane by editing the rules.
//
// Only Node built-ins plus scripts/impact/core.mjs are used, so the workflow
// job needs no dependency installation. stdout carries exactly one
// `lane=true|false` line per lane and nothing else; the workflow validates it.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  collectChangedPaths,
  compileGlob,
  resolveSafeAll,
} from "./impact/core.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RULES_PATH = path.join(SCRIPT_DIR, "ci-change-scope.json");
// The same rules as the base commit has them, relative to the repository root.
export const BASE_RULES_RELATIVE_PATH = "scripts/ci-change-scope.json";
export const PULL_REQUEST_EVENT = "pull_request";
const LANE_NAME = /^[a-z][a-z0-9]*$/u;
const MAX_LISTED_PATHS = 50;

function normalizedPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error(`${label} must be a non-empty array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
}

function compileList(patterns) {
  return { patterns, matchers: patterns.map(compileGlob) };
}

function matchesList(list, candidate) {
  return list.matchers.some((matcher) => matcher.test(candidate));
}

/** A path git can never report; treated as unclassifiable (all lanes run). */
function isUnsafePath(candidate) {
  return (
    candidate === "" ||
    candidate.startsWith("/") ||
    candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

export function compileScopeRules(raw) {
  if (!isObject(raw) || raw.version !== 1) {
    throw new Error("ci-change-scope rules must be an object with version 1");
  }
  const forceAll = compileList(stringList(raw.forceAll, "forceAll"));
  if (!isObject(raw.sets) || Object.keys(raw.sets).length === 0) {
    throw new Error("sets must be a non-empty object");
  }
  const sets = {};
  for (const [name, patterns] of Object.entries(raw.sets)) {
    sets[name] = compileList(stringList(patterns, `sets.${name}`));
  }
  if (!isObject(raw.lanes) || Object.keys(raw.lanes).length === 0) {
    throw new Error("lanes must be a non-empty object");
  }
  const lanes = [];
  for (const [name, lane] of Object.entries(raw.lanes)) {
    if (!LANE_NAME.test(name)) {
      throw new Error(`lane name ${JSON.stringify(name)} is not a plain lowercase word`);
    }
    if (!isObject(lane)) throw new Error(`lanes.${name} must be an object`);
    const gatedJobs = stringList(lane.gatedJobs, `lanes.${name}.gatedJobs`);
    const cascadeJobs = lane.cascadeJobs === undefined
      ? []
      : stringList(lane.cascadeJobs, `lanes.${name}.cascadeJobs`);
    if (lane.mode === "neutral") {
      const neutral = stringList(lane.neutral, `lanes.${name}.neutral`);
      for (const setName of neutral) {
        if (!Object.hasOwn(sets, setName)) {
          throw new Error(`lanes.${name}.neutral names unknown set ${setName}`);
        }
      }
      lanes.push({
        name,
        mode: "neutral",
        neutral,
        neverNeutral: lane.neverNeutral === undefined
          ? null
          : compileList(stringList(lane.neverNeutral, `lanes.${name}.neverNeutral`)),
        gatedJobs,
        cascadeJobs,
      });
    } else if (lane.mode === "trigger") {
      lanes.push({
        name,
        mode: "trigger",
        triggers: compileList(stringList(lane.triggers, `lanes.${name}.triggers`)),
        gatedJobs,
        cascadeJobs,
      });
    } else {
      throw new Error(`lanes.${name}.mode must be neutral or trigger`);
    }
  }
  return { forceAll, sets, lanes };
}

export async function loadScopeRules(rulesPath = DEFAULT_RULES_PATH) {
  return compileScopeRules(JSON.parse(await readFile(rulesPath, "utf8")));
}

async function gitText(repoRoot, args) {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
  return result.stdout;
}

/**
 * The rules file as the base commit has it, so a pull request that edits the
 * rules cannot use its own edit to skip a lane. Resolves to null only when git
 * succeeds and the base commit has no such file. Everything else (git failing,
 * a symlink or a non-regular entry, JSON or rules that do not compile) throws,
 * and the caller then runs every lane.
 */
export async function loadBaseScopeRules({
  repoRoot = process.cwd(),
  base,
  relativePath = BASE_RULES_RELATIVE_PATH,
}) {
  if (typeof base !== "string" || base === "" || base.startsWith("-")) {
    throw new Error("base must be a commit reference");
  }
  const listing = await gitText(repoRoot, [
    "ls-tree",
    "-z",
    "--full-tree",
    `${base}^{commit}`,
    "--",
    relativePath,
  ]);
  if (listing === "") return null;
  const entry = /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)\0$/u.exec(listing);
  if (!entry || entry[3] !== relativePath) {
    throw new Error(`base commit entry for ${relativePath} is not a plain file`);
  }
  return compileScopeRules(JSON.parse(await gitText(repoRoot, ["cat-file", "blob", entry[2]])));
}

export function laneNames(rules) {
  return rules.lanes.map((lane) => lane.name);
}

function listPaths(values) {
  const shown = values.slice(0, 5).join(", ");
  return values.length > 5 ? `${shown} (+${values.length - 5} more)` : shown;
}

/** Every lane runs; the reason says why diff-based skipping was not applied. */
export function allLanesRun(rules, reasonKind, reason, extra = {}) {
  return {
    allSelected: true,
    reasonKind,
    reason,
    changedPaths: extra.changedPaths ?? [],
    forcedPaths: extra.forcedPaths ?? [],
    lanes: Object.fromEntries(
      rules.lanes.map((lane) => [lane.name, { run: true, reason }]),
    ),
  };
}

/**
 * Pure decision from an already-collected path list. `incompleteReason` marks
 * an incomplete diff (non-empty string). Never skips on doubt.
 */
export function decideScope({ rules, changedPaths, incompleteReason }) {
  const paths = [...new Set((changedPaths ?? []).map(normalizedPath))].sort();
  const forcedPaths = paths.filter((candidate) =>
    matchesList(rules.forceAll, candidate),
  );
  const safety = resolveSafeAll({
    changedPaths: paths,
    unmatchedPaths: [],
    incompleteReason,
    policyAllPaths: forcedPaths,
  });
  const base = { changedPaths: paths, forcedPaths };
  if (safety.reasonKind === "incomplete-diff") {
    return allLanesRun(
      rules,
      safety.reasonKind,
      `Git diff incomplete (${String(incompleteReason).trim() || "no reason given"}); every lane runs.`,
      base,
    );
  }
  if (safety.reasonKind === "empty-diff") {
    return allLanesRun(rules, safety.reasonKind, "Empty diff; every lane runs.", base);
  }
  const unsafe = paths.filter(isUnsafePath);
  if (unsafe.length > 0) {
    return allLanesRun(
      rules,
      "unsafe-path",
      `Unclassifiable path(s) ${listPaths(unsafe)}; every lane runs.`,
      base,
    );
  }
  if (safety.reasonKind === "policy-all") {
    return allLanesRun(
      rules,
      safety.reasonKind,
      `Forced-all path(s) ${listPaths(forcedPaths)}; every lane runs.`,
      base,
    );
  }
  const lanes = {};
  for (const lane of rules.lanes) {
    if (lane.mode === "trigger") {
      const hits = paths.filter((candidate) => matchesList(lane.triggers, candidate));
      lanes[lane.name] = hits.length > 0
        ? { run: true, reason: `Changed path(s) match the lane trigger: ${listPaths(hits)}.` }
        : {
            run: false,
            reason: `No changed path matches the lane trigger (${lane.triggers.patterns.join(", ")}).`,
          };
      continue;
    }
    const neutralLists = lane.neutral.map((name) => rules.sets[name]);
    const outside = paths.filter(
      (candidate) =>
        !neutralLists.some((list) => matchesList(list, candidate)) ||
        (lane.neverNeutral !== null && matchesList(lane.neverNeutral, candidate)),
    );
    lanes[lane.name] = outside.length === 0
      ? {
          run: false,
          reason: `All ${paths.length} changed path(s) are neutral for this lane (${lane.neutral.join(", ")}).`,
        }
      : {
          run: true,
          reason: `Path(s) not neutral for this lane: ${listPaths(outside)}.`,
        };
  }
  return {
    allSelected: false,
    reasonKind: "classified",
    reason: "Each lane was decided from the changed paths.",
    ...base,
    lanes,
  };
}

/**
 * A lane is skipped only when the head rules and the base commit's rules both
 * skip it. A lane the base rules do not know runs. `base` and `head` decisions
 * come from the same path list.
 */
export function mergeDecisions(rules, headDecision, baseDecision) {
  const lanes = {};
  for (const lane of rules.lanes) {
    const own = headDecision.lanes[lane.name];
    const prior = baseDecision.lanes[lane.name];
    if (own.run) {
      lanes[lane.name] = own;
    } else if (prior === undefined) {
      lanes[lane.name] = {
        run: true,
        reason: "The base commit's rules do not know this lane, so it runs.",
      };
    } else if (prior.run) {
      lanes[lane.name] = { run: true, reason: `Base commit rules: ${prior.reason}` };
    } else {
      lanes[lane.name] = {
        run: false,
        reason: `${own.reason} The base commit's rules agree.`,
      };
    }
  }
  const from = headDecision.allSelected || !baseDecision.allSelected ? headDecision : baseDecision;
  return {
    allSelected: headDecision.allSelected || baseDecision.allSelected,
    reasonKind: from.reasonKind,
    reason: from === baseDecision ? `Base commit rules: ${from.reason}` : from.reason,
    changedPaths: headDecision.changedPaths,
    forcedPaths: [...new Set([...headDecision.forcedPaths, ...baseDecision.forcedPaths])].sort(),
    baseRules: "combined",
    lanes,
  };
}

/**
 * Event gate. Only pull_request looks at a diff; every other event (push,
 * schedule, workflow_dispatch, workflow_call) runs all lanes without touching
 * git. Any failure while deciding also runs all lanes.
 */
export async function decideForEvent({
  rules,
  event,
  base,
  head,
  repoRoot = process.cwd(),
  collect = collectChangedPaths,
  loadBaseRules = loadBaseScopeRules,
}) {
  if (event !== PULL_REQUEST_EVENT) {
    return allLanesRun(
      rules,
      "not-pull-request",
      `Event ${JSON.stringify(String(event ?? ""))} is not pull_request; every lane runs.`,
    );
  }
  if (typeof base !== "string" || base.trim() === "" || typeof head !== "string" || head.trim() === "") {
    return allLanesRun(rules, "missing-base", "Pull request base or head SHA is missing; every lane runs.");
  }
  try {
    const changed = await collect({ repoRoot, base: base.trim(), head: head.trim() });
    const input = {
      changedPaths: changed.paths,
      incompleteReason: changed.complete ? "" : changed.reason || "diff incomplete",
    };
    const own = decideScope({ rules, ...input });
    // Nothing to combine when the head rules already run every lane.
    if (own.allSelected) return { ...own, baseRules: "not-needed" };
    const baseRules = await loadBaseRules({ repoRoot, base: base.trim() });
    if (baseRules === null) return { ...own, baseRules: "absent" };
    return mergeDecisions(rules, own, decideScope({ rules: baseRules, ...input }));
  } catch (error) {
    return allLanesRun(
      rules,
      "error",
      `Change scope failed (${error instanceof Error ? error.message : String(error)}); every lane runs.`,
    );
  }
}

/** `lane=true|false` lines, in rule order, for GITHUB_OUTPUT. */
export function formatOutputs(rules, decision) {
  return `${rules.lanes
    .map((lane) => `${lane.name}=${decision.lanes[lane.name].run ? "true" : "false"}`)
    .join("\n")}\n`;
}

export function buildRecord({ rules, decision, event, base, head }) {
  return {
    version: 1,
    event: event ?? null,
    base: base ?? null,
    head: head ?? null,
    allSelected: decision.allSelected,
    reasonKind: decision.reasonKind,
    reason: decision.reason,
    baseRules: decision.baseRules ?? "not-used",
    changedPathCount: decision.changedPaths.length,
    forcedPaths: decision.forcedPaths,
    changedPaths: decision.changedPaths,
    lanes: Object.fromEntries(
      rules.lanes.map((lane) => [
        lane.name,
        {
          run: decision.lanes[lane.name].run,
          reason: decision.lanes[lane.name].reason,
          gatedJobs: lane.gatedJobs,
          cascadeJobs: lane.cascadeJobs,
        },
      ]),
    ),
  };
}

const BASE_RULES_NOTES = {
  combined:
    "Rules: the head's `scripts/ci-change-scope.json` combined with the base commit's copy. A lane is skipped only when both skip it.",
  absent: "Rules: the base commit has no `scripts/ci-change-scope.json`, so only the head's rules applied.",
  "not-needed": "Rules: the head's rules already run every lane, so the base commit's copy was not consulted.",
  "not-used": "Rules: the base commit's copy of the rules was not used for this decision.",
};

export function formatSummary(rules, record) {
  const lines = [
    "## Change scope",
    "",
    `Event: \`${record.event ?? "unknown"}\`. Changed paths: ${record.changedPathCount}. Decision: ${record.reasonKind}.`,
    "",
    record.reason,
    "",
    BASE_RULES_NOTES[record.baseRules] ?? BASE_RULES_NOTES["not-used"],
    "",
    "| Lane | Run | Jobs | Reason |",
    "| --- | --- | --- | --- |",
  ];
  for (const lane of rules.lanes) {
    const entry = record.lanes[lane.name];
    lines.push(
      `| ${lane.name} | ${entry.run ? "run" : "skipped"} | ${[...lane.gatedJobs, ...lane.cascadeJobs].join(", ")} | ${entry.reason.replaceAll("|", "\\|")} |`,
    );
  }
  lines.push(
    "",
    "A skipped lane was not verified by this run. It is not a pass; master push and the canonical Quick and Full runs still cover it.",
  );
  if (record.changedPaths.length > 0) {
    const shown = record.changedPaths.slice(0, MAX_LISTED_PATHS);
    lines.push("", "### Changed paths", ...shown.map((candidate) => `- \`${candidate}\``));
    if (record.changedPaths.length > shown.length) {
      lines.push(`- ... and ${record.changedPaths.length - shown.length} more (see the JSON artifact)`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = {
      "--event": "event",
      "--base": "base",
      "--head": "head",
      "--json": "json",
      "--summary": "summary",
      "--rules": "rules",
      "--repo": "repo",
    }[flag];
    if (!key || index + 1 >= argv.length) {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
    args[key] = argv[(index += 1)];
  }
  return args;
}

/** Best-effort evidence; a failure here never changes the decision. */
async function writeEvidence({ rules, decision, args, event }) {
  const record = buildRecord({ rules, decision, event, base: args.base, head: args.head });
  if (args.json) {
    try {
      await mkdir(path.dirname(path.resolve(args.json)), { recursive: true });
      await writeFile(args.json, `${JSON.stringify(record, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`ci-change-scope: JSON evidence not written: ${error.message}\n`);
    }
  }
  if (args.summary) {
    try {
      await appendFile(args.summary, formatSummary(rules, record));
    } catch (error) {
      process.stderr.write(`ci-change-scope: summary not written: ${error.message}\n`);
    }
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const rules = await loadScopeRules(args.rules ?? DEFAULT_RULES_PATH);
  const event = args.event ?? env.GITHUB_EVENT_NAME ?? "";
  const decision = await decideForEvent({
    rules,
    event,
    base: args.base,
    head: args.head,
    repoRoot: args.repo ?? process.cwd(),
  });
  await writeEvidence({ rules, decision, args, event });
  process.stdout.write(formatOutputs(rules, decision));
}

// Run as a CLI only when executed directly (real paths, so a symlinked checkout
// cannot silently turn the CLI into a no-op).
function isEntryPoint() {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    process.stderr.write(`ci-change-scope: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
