import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  collectChangedPaths,
  formatImpactSummary,
  parseImpactMap,
  selectImpact,
} from "./impact-map.mjs";

const execFileAsync = promisify(execFile);
const ALLOWED_SUITES = ["quality-workflow", "ai-routing", "tool-policy"];

const VALID_MAP = `
version: 1
allSuites:
  - quality-workflow
  - ai-routing
  - tool-policy
rules:
  - id: global-workflow
    reason: Global workflow rules affect every AI behavior surface.
    paths:
      - AGENTS.md
      - .agents/skills/**
    requirements:
      - GDX-TRACE-001
    suites:
      - all
  - id: prompts
    reason: Prompt changes affect routing and output contracts.
    paths:
      - src/prompts/**
    requirements:
      - GDX-ROUTE-001
    suites:
      - ai-routing
  - id: source-policy
    reason: Source policy changes require the policy lane.
    paths:
      - src/**
    requirements:
      - GDX-POLICY-001
    suites:
      - tool-policy
default: all
`;

test("matching rules are unioned and normalized deterministically", () => {
  const map = parseImpactMap(VALID_MAP, { allowedSuites: ALLOWED_SUITES });
  const selection = selectImpact(map, [
    "src\\prompts\\ja\\chatSystem.ts",
    "src/prompts/ja/chatSystem.ts",
  ]);

  assert.deepEqual(selection.changedPaths, ["src/prompts/ja/chatSystem.ts"]);
  assert.deepEqual(selection.matchedRuleIds, ["prompts", "source-policy"]);
  assert.deepEqual(selection.requirementIds, [
    "GDX-ROUTE-001",
    "GDX-POLICY-001",
  ]);
  assert.deepEqual(selection.suiteIds, ["ai-routing", "tool-policy"]);
  assert.equal(selection.fallback, false);
});

test("a global rule expands all suites", () => {
  const map = parseImpactMap(VALID_MAP, { allowedSuites: ALLOWED_SUITES });
  const selection = selectImpact(map, ["AGENTS.md"]);

  assert.deepEqual(selection.suiteIds, ALLOWED_SUITES);
  assert.equal(selection.fallback, false);
  assert.equal(selection.allSelected, true);
});

test("any unclassified path forces the safe all-suite fallback", () => {
  const map = parseImpactMap(VALID_MAP, { allowedSuites: ALLOWED_SUITES });
  const selection = selectImpact(map, [
    "src/prompts/en/chatSystem.ts",
    "docs/unclassified-note.md",
  ]);

  assert.deepEqual(selection.suiteIds, ALLOWED_SUITES);
  assert.equal(selection.fallback, true);
  assert.deepEqual(selection.unmatchedPaths, ["docs/unclassified-note.md"]);
  assert.match(selection.reason, /unclassified/i);
});

test("an empty or unavailable diff also fails safe to all suites", () => {
  const map = parseImpactMap(VALID_MAP, { allowedSuites: ALLOWED_SUITES });

  const empty = selectImpact(map, []);
  assert.deepEqual(empty.suiteIds, ALLOWED_SUITES);
  assert.equal(empty.fallback, true);

  const unavailable = selectImpact(map, ["src/prompts/en/chatSystem.ts"], {
    forceAllReason: "git diff unavailable",
  });
  assert.deepEqual(unavailable.suiteIds, ALLOWED_SUITES);
  assert.equal(unavailable.fallback, true);
  assert.match(unavailable.reason, /git diff unavailable/);
});

test("map parsing rejects ambiguous rules and unsupported glob syntax", () => {
  assert.throws(
    () =>
      parseImpactMap(
        VALID_MAP.replace("src/prompts/**", "src/prompts/[a-z]/**"),
        { allowedSuites: ALLOWED_SUITES },
      ),
    /unsupported glob/i,
  );

  assert.throws(
    () =>
      parseImpactMap(
        VALID_MAP.replace("  - id: source-policy", "  - id: prompts"),
        { allowedSuites: ALLOWED_SUITES },
      ),
    /duplicate rule id/i,
  );

  assert.throws(
    () =>
      parseImpactMap(VALID_MAP.replace("tool-policy", "unknown-suite"), {
        allowedSuites: ALLOWED_SUITES,
      }),
    /unknown suite/i,
  );
});

test("the Markdown summary exposes change, requirement, suite, and fallback evidence", () => {
  const map = parseImpactMap(VALID_MAP, { allowedSuites: ALLOWED_SUITES });
  const summary = formatImpactSummary(
    selectImpact(map, ["docs/unclassified-note.md"]),
  );

  assert.match(summary, /Changed files/);
  assert.match(summary, /Affected requirements/);
  assert.match(summary, /Selected light suites/);
  assert.match(summary, /Fallback/);
  assert.match(summary, /docs\/unclassified-note\.md/);
});

test("working-tree collection includes rename endpoints, unstaged edits, and untracked files", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "grimodex-impact-"));
  await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "Quality Test"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["config", "user.email", "quality@example.test"], {
    cwd: repoRoot,
  });
  await writeFile(path.join(repoRoot, "old.txt"), "old\n");
  await writeFile(path.join(repoRoot, "tracked.txt"), "before\n");
  await execFileAsync("git", ["add", "old.txt", "tracked.txt"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: repoRoot });
  const { stdout: baseStdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoRoot },
  );
  const base = baseStdout.trim();

  await execFileAsync("git", ["mv", "old.txt", "new.txt"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "tracked.txt"), "after\n");
  await writeFile(path.join(repoRoot, "untracked.txt"), "new\n");

  const changed = await collectChangedPaths({
    repoRoot,
    base,
    head: "HEAD",
  });

  assert.equal(changed.complete, true);
  assert.deepEqual(changed.paths, [
    "new.txt",
    "old.txt",
    "tracked.txt",
    "untracked.txt",
  ]);
});

test("an invalid comparison base is reported instead of silently trusting a partial diff", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "grimodex-impact-"));
  await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });

  const changed = await collectChangedPaths({
    repoRoot,
    base: "missing-base",
    head: "HEAD",
  });

  assert.equal(changed.complete, false);
  assert.match(changed.reason, /diff/i);
});
