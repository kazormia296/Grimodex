import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  classifyChangedPaths,
  collectChangedPaths,
  compileGlob,
  compilePathRules,
  formatImpactMarkdown,
  resolveSafeAll,
} from "./core.mjs";

const execFileAsync = promisify(execFile);

async function initializeRepository(t) {
  const repoRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-impact-core-"),
  );
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "Impact Core Test"], {
    cwd: repoRoot,
  });
  await execFileAsync(
    "git",
    ["config", "user.email", "impact-core@example.test"],
    { cwd: repoRoot },
  );
  return repoRoot;
}

async function git(repoRoot, args) {
  return execFileAsync("git", args, { cwd: repoRoot });
}

test("the shared core has no package dependency imports", async () => {
  const source = await readFile(new URL("./core.mjs", import.meta.url), "utf8");
  const importSpecifiers = [
    ...source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g),
  ].map((match) => match[1]);

  assert.ok(importSpecifiers.length > 0);
  assert.ok(
    importSpecifiers.every((specifier) => specifier.startsWith("node:")),
    `non-Node dependency import found: ${importSpecifiers.join(", ")}`,
  );
});

test("compileGlob supports the selector glob subset without prefix leakage", () => {
  const descendants = compileGlob("src/features/editor/**");
  assert.match("src/features/editor/EditorPane.tsx", descendants);
  assert.match("src/features/editor/nested/document.ts", descendants);
  assert.doesNotMatch("src/features/editorial/panel.ts", descendants);

  const basenameWildcard = compileGlob("public/TERMS_*.md");
  assert.match("public/TERMS_en.md", basenameWildcard);
  assert.doesNotMatch("public/legal/TERMS_en.md", basenameWildcard);

  const middleGlobstar = compileGlob("src/**/document/*.ts");
  assert.match("src/document/save.ts", middleGlobstar);
  assert.match("src/features/editor/document/save.ts", middleGlobstar);
  assert.doesNotMatch(
    "src/features/editor/document/nested/save.ts",
    middleGlobstar,
  );
});

test("compileGlob rejects ambiguous or unsupported syntax", () => {
  for (const pattern of [
    "src/[a-z]/**",
    "src/{editor,chat}/**",
    "src/***/file.ts",
    "src/editor**/file.ts",
    "src/**/**/file.ts",
    "!src/editor/**",
  ]) {
    assert.throws(() => compileGlob(pattern), /unsupported glob/i);
  }
});

test("classification normalizes, deduplicates, sorts, and preserves rule order", () => {
  const rules = compilePathRules([
    {
      id: "editor",
      paths: ["src/features/editor/**"],
      domains: ["editor"],
    },
    {
      id: "all-source",
      paths: ["src/**"],
      domains: ["source"],
    },
  ]);
  const classification = classifyChangedPaths(rules, [
    "src\\features\\editor\\EditorPane.tsx",
    "./src/features/editor/EditorPane.tsx",
    "docs/unclassified.md",
  ]);

  assert.deepEqual(classification.changedPaths, [
    "docs/unclassified.md",
    "src/features/editor/EditorPane.tsx",
  ]);
  assert.deepEqual(classification.matchedRuleIds, ["editor", "all-source"]);
  assert.deepEqual(
    classification.matchedRules.map((rule) => rule.id),
    ["editor", "all-source"],
  );
  assert.deepEqual(classification.unmatchedPaths, ["docs/unclassified.md"]);
});

test("safe-all resolution distinguishes fallback from policy-driven all", () => {
  const cases = [
    {
      name: "incomplete diff",
      input: {
        changedPaths: ["src/editor.ts"],
        unmatchedPaths: [],
        incompleteReason: "Git diff incomplete",
      },
      expected: {
        fallback: true,
        allSelected: true,
        reasonKind: "incomplete-diff",
      },
    },
    {
      name: "empty diff",
      input: { changedPaths: [], unmatchedPaths: [] },
      expected: {
        fallback: true,
        allSelected: true,
        reasonKind: "empty-diff",
      },
    },
    {
      name: "unmatched path",
      input: {
        changedPaths: ["unknown.txt"],
        unmatchedPaths: ["unknown.txt"],
      },
      expected: {
        fallback: true,
        allSelected: true,
        reasonKind: "unmatched-paths",
      },
    },
    {
      name: "critical policy path",
      input: {
        changedPaths: [".github/workflows/ci.yml"],
        unmatchedPaths: [],
        policyAllPaths: [".github/workflows/ci.yml"],
      },
      expected: {
        fallback: false,
        allSelected: true,
        reasonKind: "policy-all",
      },
    },
    {
      name: "explicit all",
      input: {
        changedPaths: ["src/editor.ts"],
        unmatchedPaths: [],
        explicitAll: true,
      },
      expected: {
        fallback: false,
        allSelected: true,
        reasonKind: "explicit-all",
      },
    },
    {
      name: "classified affected selection",
      input: {
        changedPaths: ["src/editor.ts"],
        unmatchedPaths: [],
      },
      expected: {
        fallback: false,
        allSelected: false,
        reasonKind: "classified",
      },
    },
  ];

  for (const entry of cases) {
    assert.deepEqual(resolveSafeAll(entry.input), entry.expected, entry.name);
  }
});

test("Markdown formatting exposes generic deterministic selection evidence", () => {
  const summary = formatImpactMarkdown({
    title: "Grimodex product journey impact",
    changedPaths: ["src/features/editor/EditorPane.tsx"],
    matchedRuleIds: ["editor"],
    sections: [
      { heading: "Affected domains", values: ["editor"] },
      {
        heading: "Selected journeys",
        values: ["cross-feature-authoring"],
      },
      { heading: "Capabilities", values: [] },
    ],
    fallback: false,
    reason: "All changed paths were classified.",
  });

  assert.equal(
    summary,
    [
      "## Grimodex product journey impact",
      "",
      "### Changed files",
      "- src/features/editor/EditorPane.tsx",
      "",
      "### Matched rules",
      "- editor",
      "",
      "### Affected domains",
      "- editor",
      "",
      "### Selected journeys",
      "- cross-feature-authoring",
      "",
      "### Capabilities",
      "- (none)",
      "",
      "### Fallback: no",
      "All changed paths were classified.",
    ].join("\n"),
  );
});

test("working-tree collection includes rename endpoints, edits, and untracked files", async (t) => {
  const repoRoot = await initializeRepository(t);
  await writeFile(path.join(repoRoot, "old.txt"), "old\n");
  await writeFile(path.join(repoRoot, "tracked.txt"), "before\n");
  await git(repoRoot, ["add", "old.txt", "tracked.txt"]);
  await git(repoRoot, ["commit", "-qm", "base"]);
  const { stdout } = await git(repoRoot, ["rev-parse", "HEAD"]);
  const base = stdout.trim();

  await git(repoRoot, ["mv", "old.txt", "new.txt"]);
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

test("committed comparison includes both rename endpoints", async (t) => {
  const repoRoot = await initializeRepository(t);
  await writeFile(path.join(repoRoot, "old-domain.txt"), "same content\n");
  await git(repoRoot, ["add", "old-domain.txt"]);
  await git(repoRoot, ["commit", "-qm", "base"]);
  const { stdout: baseStdout } = await git(repoRoot, ["rev-parse", "HEAD"]);
  const base = baseStdout.trim();

  await git(repoRoot, ["mv", "old-domain.txt", "new-domain.txt"]);
  await git(repoRoot, ["commit", "-qm", "rename"]);
  const { stdout: headStdout } = await git(repoRoot, ["rev-parse", "HEAD"]);
  const head = headStdout.trim();

  const changed = await collectChangedPaths({ repoRoot, base, head });

  assert.equal(changed.complete, true);
  assert.deepEqual(changed.paths, ["new-domain.txt", "old-domain.txt"]);
  assert.equal(changed.comparison.resolved.base, base);
  assert.equal(changed.comparison.resolved.head, head);
  assert.equal(changed.comparison.resolved.mergeBase, base);
});

test("invalid comparison refs make partial path collection explicitly incomplete", async (t) => {
  const repoRoot = await initializeRepository(t);
  await writeFile(path.join(repoRoot, "tracked.txt"), "base\n");
  await git(repoRoot, ["add", "tracked.txt"]);
  await git(repoRoot, ["commit", "-qm", "base"]);

  const changed = await collectChangedPaths({
    repoRoot,
    base: "missing-base",
    head: "HEAD",
  });

  assert.equal(changed.complete, false);
  assert.match(changed.reason, /base ref unavailable/i);
  assert.equal(changed.comparison.resolved.base, null);
  assert.match(changed.comparison.resolved.head, /^[0-9a-f]{40}$/);
});
