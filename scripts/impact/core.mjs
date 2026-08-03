import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function unique(values) {
  return [...new Set(values)];
}

function normalizedPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function compileGlob(pattern) {
  const normalizedPattern = normalizedPath(
    assertString(pattern, "path pattern"),
  );
  if (
    ["?", "[", "]", "{", "}", "!"].some((token) =>
      normalizedPattern.includes(token),
    ) ||
    normalizedPattern.includes("***")
  ) {
    throw new Error(`Unsupported glob syntax: ${pattern}`);
  }
  const segments = normalizedPattern.split("/");
  if (segments.some((segment) => segment.includes("**") && segment !== "**")) {
    throw new Error(`Unsupported glob syntax: ${pattern}`);
  }
  if (
    segments.some(
      (segment, index) => segment === "**" && segments[index - 1] === "**",
    )
  ) {
    throw new Error(`Unsupported glob syntax: ${pattern}`);
  }

  let source = "^";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "**") {
      if (segments.length === 1) {
        source += ".*";
      } else if (index === segments.length - 1) {
        source += index === 0 ? ".*" : "(?:/.*)?";
      } else {
        source += index === 0 ? "(?:[^/]+/)*" : "(?:/[^/]+)*";
      }
      continue;
    }
    if (index > 0 && !(index === 1 && segments[0] === "**")) source += "/";
    source += segment
      .split("*")
      .map((part) => part.replace(/[\\^$.*+()|]/g, "\\$&"))
      .join("[^/]*");
  }
  return new RegExp(`${source}$`);
}

export function compilePathRules(rules) {
  if (!Array.isArray(rules)) {
    throw new Error("path rules must be an array");
  }
  return rules.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`path rule ${index} must be an object`);
    }
    if (!Array.isArray(rule.paths) || rule.paths.length === 0) {
      throw new Error(`path rule ${index} paths must be non-empty`);
    }
    const paths = rule.paths.map((pattern) =>
      assertString(pattern, `path rule ${index} path`),
    );
    return {
      ...rule,
      paths,
      matchers: paths.map(compileGlob),
    };
  });
}

export function classifyChangedPaths(rules, changedPaths) {
  const paths = unique(changedPaths.map(normalizedPath).filter(Boolean)).sort();
  const matchedRules = rules.filter((rule) =>
    paths.some((candidate) =>
      rule.matchers.some((matcher) => matcher.test(candidate)),
    ),
  );
  const unmatchedPaths = paths.filter(
    (candidate) =>
      !rules.some((rule) =>
        rule.matchers.some((matcher) => matcher.test(candidate)),
      ),
  );
  return {
    changedPaths: paths,
    matchedRules,
    matchedRuleIds: matchedRules.map((rule) => rule.id),
    unmatchedPaths,
  };
}

export function resolveSafeAll({
  changedPaths,
  unmatchedPaths,
  incompleteReason,
  policyAllPaths = [],
  explicitAll = false,
}) {
  const incomplete =
    typeof incompleteReason === "string"
      ? incompleteReason.trim() !== ""
      : Boolean(incompleteReason);
  if (incomplete) {
    return {
      fallback: true,
      allSelected: true,
      reasonKind: "incomplete-diff",
    };
  }
  if (changedPaths.length === 0) {
    return {
      fallback: true,
      allSelected: true,
      reasonKind: "empty-diff",
    };
  }
  if (unmatchedPaths.length > 0) {
    return {
      fallback: true,
      allSelected: true,
      reasonKind: "unmatched-paths",
    };
  }
  if (policyAllPaths.length > 0) {
    return {
      fallback: false,
      allSelected: true,
      reasonKind: "policy-all",
    };
  }
  if (explicitAll) {
    return {
      fallback: false,
      allSelected: true,
      reasonKind: "explicit-all",
    };
  }
  return {
    fallback: false,
    allSelected: false,
    reasonKind: "classified",
  };
}

function markdownList(values) {
  return values.length > 0
    ? values.map((value) => `- ${value}`).join("\n")
    : "- (none)";
}

export function formatImpactMarkdown({
  title,
  changedPaths,
  matchedRuleIds,
  sections = [],
  trailingSections = [],
  fallback,
  reason,
}) {
  const output = [
    `## ${assertString(title, "impact summary title")}`,
    "",
    "### Changed files",
    markdownList(changedPaths),
    "",
    "### Matched rules",
    markdownList(matchedRuleIds),
  ];
  for (const section of sections) {
    output.push(
      "",
      `### ${assertString(section.heading, "impact summary section heading")}`,
      markdownList(section.values),
    );
  }
  output.push(
    "",
    `### Fallback: ${fallback ? "yes" : "no"}`,
    assertString(reason, "impact summary reason"),
  );
  for (const section of trailingSections) {
    output.push(
      "",
      `### ${assertString(section.heading, "impact summary section heading")}`,
      markdownList(section.values),
    );
  }
  return output.join("\n");
}

function parseNameStatus(output) {
  const tokens = output.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    for (
      let count = 0;
      count < pathCount && index < tokens.length;
      count += 1
    ) {
      paths.push(normalizedPath(tokens[index++]));
    }
  }
  return paths;
}

async function gitOutput(repoRoot, args) {
  const result = await execFileAsync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

async function resolveGitCommit(repoRoot, reference) {
  return (
    await gitOutput(repoRoot, [
      "rev-parse",
      "--verify",
      `${reference}^{commit}`,
    ])
  ).trim();
}

export async function collectChangedPaths({
  repoRoot = DEFAULT_REPO_ROOT,
  base,
  head = "HEAD",
}) {
  const paths = [];
  const errors = [];
  const comparison = {
    source: "git",
    requested: { base: base ?? null, head },
    resolved: { base: null, head: null, mergeBase: null },
    includesWorkingTree: true,
  };
  if (base) {
    try {
      comparison.resolved.base = await resolveGitCommit(repoRoot, base);
    } catch (error) {
      errors.push(`Base ref unavailable: ${error.message}`);
    }
  }
  try {
    comparison.resolved.head = await resolveGitCommit(repoRoot, head);
  } catch (error) {
    errors.push(`Head ref unavailable: ${error.message}`);
  }
  if (comparison.resolved.base && comparison.resolved.head) {
    try {
      comparison.resolved.mergeBase = (
        await gitOutput(repoRoot, [
          "merge-base",
          comparison.resolved.base,
          comparison.resolved.head,
        ])
      ).trim();
    } catch (error) {
      errors.push(`Merge base unavailable: ${error.message}`);
    }
  }
  if (base) {
    if (comparison.resolved.base && comparison.resolved.head) {
      try {
        paths.push(
          ...parseNameStatus(
            await gitOutput(repoRoot, [
              "diff",
              "--name-status",
              "-z",
              "--find-renames",
              `${comparison.resolved.base}...${comparison.resolved.head}`,
            ]),
          ),
        );
      } catch (error) {
        errors.push(`Committed diff unavailable: ${error.message}`);
      }
    } else {
      errors.push("Committed diff unavailable: unresolved comparison ref");
    }
  }
  for (const args of [
    ["diff", "--name-status", "-z", "--find-renames"],
    ["diff", "--cached", "--name-status", "-z", "--find-renames"],
  ]) {
    try {
      paths.push(...parseNameStatus(await gitOutput(repoRoot, args)));
    } catch (error) {
      errors.push(`Working-tree diff unavailable: ${error.message}`);
    }
  }
  try {
    paths.push(
      ...(
        await gitOutput(repoRoot, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter(Boolean)
        .map(normalizedPath),
    );
  } catch (error) {
    errors.push(`Untracked-file scan unavailable: ${error.message}`);
  }
  return {
    paths: unique(paths).sort(),
    complete: errors.length === 0,
    reason:
      errors.length === 0
        ? "Complete Git diff."
        : `Git diff incomplete: ${errors.join("; ")}`,
    comparison,
  };
}
