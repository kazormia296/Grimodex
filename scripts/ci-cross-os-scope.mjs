#!/usr/bin/env node
// Whether a master push runs the C-query worker on macOS and Windows
// (.github/workflows/ci.yml, job `nir1-c-query-worker`).
//
// Deny by default, in the direction of running: the two legs are skipped only
// when the event is a push to master, `before` and `after` are real commits,
// the diff between them is complete, non-empty and safe, and NO changed path is
// a trigger in the rules. Everything else (another event, an unresolvable or
// all-zero `before` after a force push, an empty or incomplete diff, an unsafe
// path, an exception) runs them. The decision is made with the head's rules and
// with the `before` commit's copy of the rules; either one matching a path
// runs the legs, so a push cannot skip them by editing the trigger list.
//
// Only Node built-ins plus scripts/impact/core.mjs are used, so the workflow
// job needs no dependency installation. stdout carries exactly one
// `cquery_cross_os=true|false` line and nothing else; the workflow validates it.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileGlob } from "./impact/core.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RULES_PATH = path.join(SCRIPT_DIR, "ci-cross-os-scope.json");
// The same rules as the `before` commit has them, relative to the repository root.
export const BASE_RULES_RELATIVE_PATH = "scripts/ci-cross-os-scope.json";
export const OUTPUT_NAME = "cquery_cross_os";
export const PUSH_EVENT = "push";
export const MASTER_REF = "refs/heads/master";
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_LISTED_PATHS = 50;

function normalizedPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A path git can never report; treated as unclassifiable (the legs run). */
function isUnsafePath(candidate) {
  return (
    candidate === "" ||
    candidate.startsWith("/") ||
    candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

export function compileCrossOsRules(raw) {
  if (!isObject(raw) || raw.version !== 1) {
    throw new Error("ci-cross-os-scope rules must be an object with version 1");
  }
  if (
    !Array.isArray(raw.triggers) ||
    raw.triggers.length === 0 ||
    raw.triggers.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error("triggers must be a non-empty array of non-empty strings");
  }
  const patterns = raw.triggers.map((entry) => entry.trim());
  return { triggers: { patterns, matchers: patterns.map(compileGlob) } };
}

export async function loadCrossOsRules(rulesPath = DEFAULT_RULES_PATH) {
  return compileCrossOsRules(JSON.parse(await readFile(rulesPath, "utf8")));
}

async function gitText(repoRoot, args) {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  return result.stdout;
}

/**
 * The rules file as the `before` commit has it. Resolves to null only when git
 * succeeds and that commit has no such file (the push that introduces it).
 * Everything else (git failing, a symlink or non-regular entry, JSON or rules
 * that do not compile) throws, and the caller then runs the legs.
 */
export async function loadBaseCrossOsRules({
  repoRoot = process.cwd(),
  before,
  relativePath = BASE_RULES_RELATIVE_PATH,
}) {
  if (!COMMIT_ID.test(String(before))) throw new Error("before must be a full commit id");
  const listing = await gitText(repoRoot, [
    "ls-tree",
    "-z",
    "--full-tree",
    `${before}^{commit}`,
    "--",
    relativePath,
  ]);
  if (listing === "") return null;
  const entry = /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)\0$/u.exec(listing);
  if (!entry || entry[3] !== relativePath) {
    throw new Error(`before commit entry for ${relativePath} is not a plain file`);
  }
  return compileCrossOsRules(JSON.parse(await gitText(repoRoot, ["cat-file", "blob", entry[2]])));
}

/**
 * Paths changed between two commits: a two-point (tree against tree) diff with
 * renames split, so both sides of a move are listed. Throws on any git failure.
 */
export async function collectPushPaths({ repoRoot = process.cwd(), before, after }) {
  for (const commit of [before, after]) {
    await gitText(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`]);
  }
  const output = await gitText(repoRoot, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    before,
    after,
    "--",
  ]);
  return output.split("\0").filter((entry) => entry !== "");
}

function listPaths(values) {
  const shown = values.slice(0, 5).join(", ");
  return values.length > 5 ? `${shown} (+${values.length - 5} more)` : shown;
}

function decision(run, reasonKind, reason, extra = {}) {
  return {
    run,
    reasonKind,
    reason,
    changedPaths: extra.changedPaths ?? [],
    hits: extra.hits ?? [],
    baseRules: extra.baseRules ?? "not-used",
  };
}

/**
 * The decision for one event. `run: false` is returned only when every
 * condition for skipping holds; every doubt is `run: true` with a reason.
 */
export async function decideForPush({
  rules,
  event,
  ref,
  before,
  after,
  repoRoot = process.cwd(),
  collect = collectPushPaths,
  loadBaseRules = loadBaseCrossOsRules,
}) {
  if (event !== PUSH_EVENT) {
    return decision(true, "not-push", `Event ${JSON.stringify(String(event ?? ""))} is not push; the macOS and Windows legs run.`);
  }
  if (ref !== MASTER_REF) {
    return decision(true, "not-master", `Ref ${JSON.stringify(String(ref ?? ""))} is not ${MASTER_REF}; the macOS and Windows legs run.`);
  }
  const beforeId = typeof before === "string" ? before.trim() : "";
  const afterId = typeof after === "string" ? after.trim() : "";
  if (!COMMIT_ID.test(beforeId) || !COMMIT_ID.test(afterId)) {
    return decision(true, "bad-commit-id", "The push before or after commit id is missing or malformed; the macOS and Windows legs run.");
  }
  if (/^0+$/u.test(beforeId)) {
    return decision(true, "no-before", "The push has no before commit (a new branch); the macOS and Windows legs run.");
  }
  try {
    const paths = [...new Set((await collect({ repoRoot, before: beforeId, after: afterId })).map(normalizedPath))].sort();
    if (paths.length === 0) {
      return decision(true, "empty-diff", "Empty diff; the macOS and Windows legs run.");
    }
    const unsafe = paths.filter(isUnsafePath);
    if (unsafe.length > 0) {
      return decision(true, "unsafe-path", `Unclassifiable path(s) ${listPaths(unsafe)}; the macOS and Windows legs run.`, { changedPaths: paths });
    }
    const hitsOf = (ruleSet) =>
      paths.filter((candidate) => ruleSet.triggers.matchers.some((matcher) => matcher.test(candidate)));
    const own = hitsOf(rules);
    if (own.length > 0) {
      return decision(true, "trigger", `Changed path(s) match a worker trigger: ${listPaths(own)}; the macOS and Windows legs run.`, {
        changedPaths: paths,
        hits: own,
        baseRules: "not-needed",
      });
    }
    const baseRules = await loadBaseRules({ repoRoot, before: beforeId });
    if (baseRules === null) {
      return decision(true, "no-base-rules", "The before commit has no copy of the rules (this push introduces them); the macOS and Windows legs run.", {
        changedPaths: paths,
        baseRules: "absent",
      });
    }
    const prior = hitsOf(baseRules);
    if (prior.length > 0) {
      return decision(true, "trigger", `Changed path(s) match a trigger of the before commit's rules: ${listPaths(prior)}; the macOS and Windows legs run.`, {
        changedPaths: paths,
        hits: prior,
        baseRules: "combined",
      });
    }
    return decision(
      false,
      "no-trigger",
      `None of the ${paths.length} changed path(s) matches a worker trigger in the head's rules or the before commit's rules; the macOS and Windows legs are skipped.`,
      { changedPaths: paths, baseRules: "combined" },
    );
  } catch (error) {
    return decision(
      true,
      "error",
      `The push diff could not be decided (${error instanceof Error ? error.message : String(error)}); the macOS and Windows legs run.`,
    );
  }
}

/** The single stdout line, for GITHUB_OUTPUT. */
export function formatOutput(result) {
  return `${OUTPUT_NAME}=${result.run ? "true" : "false"}\n`;
}

export function formatSummary(result, { event, ref, before, after } = {}) {
  const lines = [
    "## C-query worker on macOS and Windows",
    "",
    `Event: \`${event ?? "unknown"}\`, ref: \`${ref ?? "unknown"}\`, before: \`${before ?? ""}\`, after: \`${after ?? ""}\`. Changed paths: ${result.changedPaths.length}. Decision: ${result.reasonKind}.`,
    "",
    result.reason,
    "",
    result.run
      ? "The macOS and Windows legs run in this push."
      : "The macOS and Windows legs were not run by this push, so macOS and Windows are not verified by it. This is not a pass for them: the nightly run and the release call cover them.",
  ];
  if (result.changedPaths.length > 0) {
    const shown = result.changedPaths.slice(0, MAX_LISTED_PATHS);
    lines.push("", "### Changed paths", ...shown.map((candidate) => `- \`${candidate}\``));
    if (result.changedPaths.length > shown.length) {
      lines.push(`- ... and ${result.changedPaths.length - shown.length} more`);
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
      "--ref": "ref",
      "--before": "before",
      "--after": "after",
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

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const rules = await loadCrossOsRules(args.rules ?? DEFAULT_RULES_PATH);
  const event = args.event ?? env.GITHUB_EVENT_NAME ?? "";
  const result = await decideForPush({
    rules,
    event,
    ref: args.ref ?? env.GITHUB_REF ?? "",
    before: args.before,
    after: args.after,
    repoRoot: args.repo ?? process.cwd(),
  });
  if (args.summary) {
    // Best-effort evidence; a failure here never changes the decision.
    try {
      await appendFile(args.summary, formatSummary(result, { event, ref: args.ref, before: args.before, after: args.after }));
    } catch (error) {
      process.stderr.write(`ci-cross-os-scope: summary not written: ${error.message}\n`);
    }
  }
  process.stdout.write(formatOutput(result));
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
    process.stderr.write(`ci-cross-os-scope: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
