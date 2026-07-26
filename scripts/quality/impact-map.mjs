import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import yaml from "js-yaml";

const execFileAsync = promisify(execFile);
const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, "../..");

export const LIGHT_SUITE_DEFINITIONS = Object.freeze({
  "quality-workflow": {
    failureClasses: ["quality"],
    commands: [["pnpm", "test:quality"]],
  },
  "ai-routing": {
    failureClasses: ["routing", "precheck"],
    commands: [
      [
        "pnpm",
        "test:node",
        "--run",
        "src/features/ai-verification/aiPathRegistry.test.ts",
        "src/features/ai-verification/aiPathRegistry.webEditor.test.ts",
        "src/lib/browser-ai.test.ts",
        "src/lib/browser-mock.ai-runtime.test.ts",
        "src/lib/browserRuntime.test.ts",
        "src/features/chat/browserProviderPolicy.test.ts",
        "src/features/chat/chatApi.test.ts",
        "src/features/chat/chatStore.test.ts",
        "src/features/ab-test/abConfig.test.ts",
        "src/features/chat/modelRouting.test.ts",
        "src/features/chat/turn/renderAgentPayload.test.ts",
        "src/features/chat/turn/resolveTurnRoute.test.ts",
      ],
      ["pnpm", "test:cloudflare-editor-deploy"],
    ],
  },
  "tool-policy": {
    failureClasses: ["precheck", "tool", "policy"],
    commands: [
      [
        "pnpm",
        "test:node",
        "--run",
        "src/features/ai-policy",
        "src/features/chat/agent/agentLoop.test.ts",
        "src/features/chat/agent/agentPrivacy.test.ts",
        "src/features/chat/agent/agentTextBatcher.test.ts",
        "src/features/chat/agent/aiLiveHarness.test.ts",
        "src/features/chat/agent/askUser.test.ts",
        "src/features/chat/agent/chronicleReadTools.test.ts",
        "src/features/chat/agent/chronicleToolCache.test.ts",
        "src/features/chat/agent/chronicleWriteTools.test.ts",
        "src/features/chat/agent/codexHybridSearch.test.ts",
        "src/features/chat/agent/dynamicModelCaps.test.ts",
        "src/features/chat/agent/modelLimits.test.ts",
        "src/features/chat/agent/toolDefinitions.test.ts",
        "src/features/chat/agent/toolExecutors.test.ts",
        "src/features/chat/agent/toolTurnCache.test.ts",
        "src/features/chat/toolProtocolParse.test.ts",
      ],
      [
        "cargo",
        "check",
        "--manifest-path",
        "src-tauri/crates/grimodex-ai/Cargo.toml",
      ],
    ],
  },
  "prompt-contract": {
    failureClasses: ["routing", "quality", "artifact"],
    commands: [
      ["pnpm", "test:node", "--run", "src/prompts", "src/features/post-effect"],
    ],
  },
  "retrieval-grounding": {
    failureClasses: ["quality"],
    commands: [
      [
        "pnpm",
        "test:node",
        "--run",
        "src/features/chat/chatRecall.test.ts",
        "src/features/chat/chatRecallPromote.test.ts",
        "src/features/chat/citationVerify.test.ts",
        "src/features/chat/context/chatContextPlanner.test.ts",
        "src/features/chat/context/legacyPromptAdapter.test.ts",
        "src/features/chat/context/nonSceneContextPlanner.test.ts",
        "src/features/chat/context/sources/nonSceneContextSource.test.ts",
        "src/features/chat/context/sources/sceneContextSource.test.ts",
        "src/features/chat/context/turnContextRequest.test.ts",
        "src/features/chat/context/types.test.ts",
        "src/features/chat/contextBuilder.chatRecall.test.ts",
        "src/features/related-scenes/RelatedScenesSection.test.tsx",
        "src/features/related-scenes/fetchRelatedScenes.test.ts",
        "src/features/related-scenes/seedTerms.test.ts",
        "src/features/related-scenes/selectRelatedScenes.test.ts",
      ],
      ["node", "scripts/quality/validate-retrieval-fixtures.mjs"],
    ],
  },
});

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

function compileGlob(pattern) {
  assertString(pattern, "path pattern");
  if (
    ["?", "[", "]", "{", "}", "!"].some((token) => pattern.includes(token)) ||
    pattern.includes("***")
  ) {
    throw new Error(`Unsupported glob syntax: ${pattern}`);
  }
  const segments = normalizedPath(pattern).split("/");
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

export function parseImpactMap(source, options = {}) {
  const allowedSuites =
    options.allowedSuites ?? Object.keys(LIGHT_SUITE_DEFINITIONS);
  const allowedSet = new Set(allowedSuites);
  const allowedRequirements = options.allowedRequirements ?? null;
  const allowedRequirementSet = allowedRequirements
    ? new Set(allowedRequirements)
    : null;
  const parsed = yaml.load(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Impact map must be a YAML object");
  }
  if (parsed.version !== 1) throw new Error("Impact map version must be 1");
  if (!Array.isArray(parsed.allSuites) || parsed.allSuites.length === 0) {
    throw new Error("allSuites must be a non-empty array");
  }
  const allSuites = parsed.allSuites.map((suite) =>
    assertString(suite, "suite"),
  );
  for (const suite of allSuites) {
    if (!allowedSet.has(suite)) throw new Error(`Unknown suite: ${suite}`);
  }
  if (unique(allSuites).length !== allSuites.length) {
    throw new Error("allSuites contains duplicates");
  }
  const missingSuites = allowedSuites.filter(
    (suite) => !allSuites.includes(suite),
  );
  if (missingSuites.length > 0) {
    throw new Error(
      `allSuites is missing allowed suites: ${missingSuites.join(", ")}`,
    );
  }
  if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
    throw new Error("rules must be a non-empty array");
  }

  const seenRuleIds = new Set();
  const rules = parsed.rules.map((rawRule, index) => {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      throw new Error(`rule ${index} must be an object`);
    }
    const id = assertString(rawRule.id, `rule ${index} id`);
    if (seenRuleIds.has(id)) throw new Error(`Duplicate rule id: ${id}`);
    seenRuleIds.add(id);
    const reason = assertString(rawRule.reason, `rule ${id} reason`);
    if (!Array.isArray(rawRule.paths) || rawRule.paths.length === 0) {
      throw new Error(`rule ${id} paths must be non-empty`);
    }
    const paths = rawRule.paths.map((entry) =>
      assertString(entry, `rule ${id} path`),
    );
    const matchers = paths.map(compileGlob);
    if (
      !Array.isArray(rawRule.requirements) ||
      rawRule.requirements.length === 0
    ) {
      throw new Error(`rule ${id} requirements must be non-empty`);
    }
    const requirements = rawRule.requirements.map((entry) =>
      assertString(entry, `rule ${id} requirement`),
    );
    if (unique(requirements).length !== requirements.length) {
      throw new Error(`rule ${id} requirements contain duplicates`);
    }
    if (allowedRequirementSet) {
      for (const requirement of requirements) {
        if (!allowedRequirementSet.has(requirement)) {
          throw new Error(`Unknown requirement: ${requirement}`);
        }
      }
    }
    if (!Array.isArray(rawRule.suites) || rawRule.suites.length === 0) {
      throw new Error(`rule ${id} suites must be non-empty`);
    }
    const suites = rawRule.suites.map((entry) =>
      assertString(entry, `rule ${id} suite`),
    );
    for (const suite of suites) {
      if (suite !== "all" && !allowedSet.has(suite)) {
        throw new Error(`Unknown suite: ${suite}`);
      }
    }
    return { id, reason, paths, matchers, requirements, suites };
  });
  if (allowedRequirements) {
    const mappedRequirements = new Set(
      rules.flatMap((rule) => rule.requirements),
    );
    const missingRequirements = allowedRequirements.filter(
      (requirement) => !mappedRequirements.has(requirement),
    );
    if (missingRequirements.length > 0) {
      throw new Error(
        `Impact map is missing requirements: ${missingRequirements.join(", ")}`,
      );
    }
  }
  if (parsed.default !== "all") throw new Error('default must be "all"');
  return { version: 1, allSuites, rules, default: "all" };
}

function isInvariantAllPath(candidate) {
  return (
    candidate === "AGENTS.md" ||
    candidate === "package.json" ||
    candidate === "pnpm-lock.yaml" ||
    candidate.startsWith(".agents/skills/") ||
    candidate.startsWith(".github/workflows/") ||
    candidate.startsWith("policies/quality/") ||
    candidate.startsWith("evals/") ||
    candidate.startsWith("scripts/quality/")
  );
}

export function selectImpact(map, changedPaths, options = {}) {
  const paths = unique(changedPaths.map(normalizedPath).filter(Boolean)).sort();
  const allRequirementIds = unique(
    map.rules.flatMap((rule) => rule.requirements),
  );
  const matchedRules = map.rules.filter((rule) =>
    paths.some((candidate) =>
      rule.matchers.some((matcher) => matcher.test(candidate)),
    ),
  );
  const unmatchedPaths = paths.filter(
    (candidate) =>
      !map.rules.some((rule) =>
        rule.matchers.some((matcher) => matcher.test(candidate)),
      ),
  );
  const explicitAll = matchedRules.some((rule) => rule.suites.includes("all"));
  const invariantAllPaths = paths.filter(isInvariantAllPath);
  const invariantAll = invariantAllPaths.length > 0;
  const forcedReason = options.forceAllReason?.trim();
  const fallback =
    Boolean(forcedReason) || paths.length === 0 || unmatchedPaths.length > 0;
  const allSelected = fallback || explicitAll || invariantAll;
  const suiteIds = allSelected
    ? [...map.allSuites]
    : unique(
        matchedRules.flatMap((rule) =>
          rule.suites.filter((suite) => suite !== "all"),
        ),
      );
  const requirementIds = allSelected
    ? allRequirementIds
    : unique(matchedRules.flatMap((rule) => rule.requirements));
  const reason = forcedReason
    ? forcedReason
    : paths.length === 0
      ? "Empty diff; selected all suites by default."
      : unmatchedPaths.length > 0
        ? `Unclassified paths require all suites: ${unmatchedPaths.join(", ")}`
        : invariantAll
          ? `Critical workflow paths require all suites: ${invariantAllPaths.join(", ")}`
          : explicitAll
            ? "A matched global rule selected all suites."
            : "All changed paths were classified.";

  return {
    changedPaths: paths,
    matchedRuleIds: matchedRules.map((rule) => rule.id),
    matchedReasons: matchedRules.map((rule) => ({
      id: rule.id,
      reason: rule.reason,
    })),
    unmatchedPaths,
    invariantAllPaths,
    requirementIds,
    suiteIds,
    fallback,
    allSelected,
    reason,
  };
}

function markdownList(values) {
  return values.length > 0
    ? values.map((value) => `- ${value}`).join("\n")
    : "- (none)";
}

export function formatImpactSummary(selection, execution = []) {
  const executionLines = execution.map((entry) => {
    const timing = entry.durationMs == null ? "" : ` (${entry.durationMs}ms)`;
    const classification = (() => {
      if (entry.status === "failed") {
        return `; classification=${entry.classificationStatus}; failure=${entry.failureClass ?? `pending (${entry.candidateFailureClasses.join(", ")})`}`;
      }
      if (entry.status === "not-run") {
        return `; classification=not-run; candidates=${entry.candidateFailureClasses.join(", ")}; reason=${entry.reason}`;
      }
      return "";
    })();
    return `${entry.suiteId}: ${entry.status}${timing}${classification}`;
  });
  return [
    "## Grimodex quality impact gate",
    "",
    "### Changed files",
    markdownList(selection.changedPaths),
    "",
    "### Matched rules",
    markdownList(selection.matchedRuleIds),
    "",
    "### Affected requirements",
    markdownList(selection.requirementIds),
    "",
    "### Selected light suites",
    markdownList(selection.suiteIds),
    "",
    `### Fallback: ${selection.fallback ? "yes" : "no"}`,
    selection.reason,
    ...(executionLines.length > 0
      ? ["", "### Execution", markdownList(executionLines)]
      : []),
  ].join("\n");
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

function deferredHeavy(selection, heavyEvaluations) {
  return heavyEvaluations
    .filter((entry) => selection.suiteIds.includes(entry.suiteId))
    .map((entry) => ({ ...entry, status: "deferred" }));
}

function parseHeavyEvaluations(manifest) {
  if (!Array.isArray(manifest?.heavyEvaluations)) {
    throw new Error("quality manifest heavyEvaluations must be an array");
  }
  const seenIds = new Set();
  return manifest.heavyEvaluations.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`heavy evaluation ${index} must be an object`);
    }
    const id = assertString(entry.id, `heavy evaluation ${index} id`);
    if (seenIds.has(id))
      throw new Error(`Duplicate heavy evaluation id: ${id}`);
    seenIds.add(id);
    const suiteId = assertString(
      entry.suiteId,
      `heavy evaluation ${id} suiteId`,
    );
    if (!Object.hasOwn(LIGHT_SUITE_DEFINITIONS, suiteId)) {
      throw new Error(`heavy evaluation ${id} has unknown suite: ${suiteId}`);
    }
    return {
      id,
      suiteId,
      command: assertString(entry.command, `heavy evaluation ${id} command`),
      reason: assertString(entry.reason, `heavy evaluation ${id} reason`),
    };
  });
}

function parseQualityManifestMetadata(manifest) {
  if (manifest?.version !== 1) {
    throw new Error("quality manifest version must be 1");
  }
  if (!Array.isArray(manifest.lightSuites)) {
    throw new Error("quality manifest lightSuites must be an array");
  }
  const staticSuites = Object.keys(LIGHT_SUITE_DEFINITIONS);
  const manifestSuites = manifest.lightSuites.map((suite) =>
    assertString(suite, "quality manifest suite"),
  );
  if (
    manifestSuites.length !== staticSuites.length ||
    staticSuites.some((suite) => !manifestSuites.includes(suite))
  ) {
    throw new Error(
      "quality manifest lightSuites must match the static Light suite registry",
    );
  }
  if (
    !Array.isArray(manifest.requirements) ||
    manifest.requirements.length === 0
  ) {
    throw new Error("quality manifest requirements must be a non-empty array");
  }
  const requirementIds = manifest.requirements.map((requirement, index) =>
    assertString(requirement?.id, `quality requirement ${index} id`),
  );
  if (unique(requirementIds).length !== requirementIds.length) {
    throw new Error("quality manifest contains duplicate requirement IDs");
  }
  return { requirementIds };
}

function parseBlockedEvaluations(manifest, heavyEvaluations) {
  if (!Array.isArray(manifest?.blockedEvaluations)) {
    throw new Error("quality manifest blockedEvaluations must be an array");
  }
  const seenIds = new Set(heavyEvaluations.map((entry) => entry.id));
  return manifest.blockedEvaluations.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`blocked evaluation ${index} must be an object`);
    }
    const id = assertString(entry.id, `blocked evaluation ${index} id`);
    if (seenIds.has(id)) throw new Error(`Duplicate evaluation id: ${id}`);
    seenIds.add(id);
    const suiteId = assertString(
      entry.suiteId,
      `blocked evaluation ${id} suiteId`,
    );
    if (!Object.hasOwn(LIGHT_SUITE_DEFINITIONS, suiteId)) {
      throw new Error(`blocked evaluation ${id} has unknown suite: ${suiteId}`);
    }
    return {
      id,
      suiteId,
      reason: assertString(entry.reason, `blocked evaluation ${id} reason`),
      requiredAction: assertString(
        entry.requiredAction,
        `blocked evaluation ${id} requiredAction`,
      ),
    };
  });
}

function selectedBlockedEvaluations(selection, blockedEvaluations) {
  return blockedEvaluations
    .filter((entry) => selection.suiteIds.includes(entry.suiteId))
    .map((entry) => ({ ...entry, status: "blocked" }));
}

function formatHeavyEvaluations(entries) {
  return [
    "### Heavy evaluations",
    markdownList(
      entries.map(
        (entry) =>
          `${entry.suiteId}: deferred — ${entry.command} (${entry.reason})`,
      ),
    ),
  ].join("\n");
}

function formatBlockedEvaluations(entries) {
  return [
    "### Blocked evaluations",
    markdownList(
      entries.map(
        (entry) =>
          `${entry.suiteId}: blocked — ${entry.reason} (required: ${entry.requiredAction})`,
      ),
    ),
  ].join("\n");
}

function formatRunContext(comparison, environment) {
  return [
    "### Comparison and runtime",
    `- source: ${comparison.source}`,
    `- requested base: ${comparison.requested.base ?? "(none)"}`,
    `- requested head: ${comparison.requested.head ?? "(none)"}`,
    `- resolved base: ${comparison.resolved.base ?? "(none)"}`,
    `- resolved head: ${comparison.resolved.head ?? "(none)"}`,
    `- merge base: ${comparison.resolved.mergeBase ?? "(none)"}`,
    `- working tree included: ${comparison.includesWorkingTree ? "yes" : "no"}`,
    `- runtime: Node ${environment.node} on ${environment.platform}/${environment.arch}`,
  ].join("\n");
}

function runCommand(command, args, cwd, { routeStdoutToStderr = false } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const usesWindowsCommandShell =
      process.platform === "win32" && command === "pnpm";
    const executable = usesWindowsCommandShell
      ? (process.env.ComSpec ?? "cmd.exe")
      : command;
    const commandArgs = usesWindowsCommandShell
      ? ["/d", "/s", "/c", command, ...args]
      : args;
    const child = spawn(executable, commandArgs, {
      cwd,
      stdio: routeStdoutToStderr ? ["inherit", "pipe", "inherit"] : "inherit",
      shell: false,
    });
    if (routeStdoutToStderr) {
      child.stdout?.on("data", (chunk) => process.stderr.write(chunk));
    }
    child.on("error", (error) =>
      resolve({
        status: "failed",
        exitCode: null,
        error: error.message,
        durationMs: Math.round(performance.now() - started),
      }),
    );
    child.on("exit", (exitCode, signal) =>
      resolve({
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        ...(signal ? { signal } : {}),
        durationMs: Math.round(performance.now() - started),
      }),
    );
  });
}

export async function runSelectedSuites(
  selection,
  { repoRoot = DEFAULT_REPO_ROOT, routeStdoutToStderr = false } = {},
) {
  const results = [];
  let previousFailure = null;
  for (const suiteId of selection.suiteIds) {
    const definition = LIGHT_SUITE_DEFINITIONS[suiteId];
    if (!definition) throw new Error(`No static command for suite ${suiteId}`);
    if (previousFailure) {
      results.push({
        suiteId,
        failureClass: null,
        candidateFailureClasses: definition.failureClasses,
        classificationStatus: "not-run",
        commands: definition.commands,
        steps: [],
        status: "not-run",
        exitCode: null,
        reason: `Fail-fast after ${previousFailure}.`,
        durationMs: 0,
      });
      continue;
    }
    const started = performance.now();
    const steps = [];
    let failedCommand = null;
    for (const staticCommand of definition.commands) {
      if (failedCommand) {
        steps.push({
          command: staticCommand,
          status: "not-run",
          exitCode: null,
          reason: `Fail-fast after ${failedCommand.join(" ")}.`,
          durationMs: 0,
        });
        continue;
      }
      const [command, ...args] = staticCommand;
      const step = await runCommand(command, args, repoRoot, {
        routeStdoutToStderr,
      });
      steps.push({ command: staticCommand, ...step });
      if (step.status !== "passed") failedCommand = staticCommand;
    }
    const failedStep = steps.find((step) => step.status !== "passed");
    results.push({
      suiteId,
      failureClass:
        failedStep && definition.failureClasses.length === 1
          ? definition.failureClasses[0]
          : null,
      candidateFailureClasses: definition.failureClasses,
      classificationStatus: failedStep
        ? definition.failureClasses.length === 1
          ? "classified"
          : "pending-triage"
        : "not-applicable",
      commands: definition.commands,
      steps,
      status: failedStep ? "failed" : "passed",
      exitCode: failedStep ? failedStep.exitCode : 0,
      ...(failedStep?.signal ? { signal: failedStep.signal } : {}),
      ...(failedStep?.error ? { error: failedStep.error } : {}),
      durationMs: Math.round(performance.now() - started),
    });
    if (failedStep) previousFailure = suiteId;
  }
  return results;
}

function parseArgs(argv) {
  const result = { changedFiles: [], format: "markdown", run: false };
  const readValue = (option, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--run") result.run = true;
    else if (arg === "--base") result.base = readValue(arg, index++);
    else if (arg === "--head") result.head = readValue(arg, index++);
    else if (arg === "--changed-file")
      result.changedFiles.push(readValue(arg, index++));
    else if (arg === "--format") result.format = readValue(arg, index++);
    else if (arg === "--report") result.report = readValue(arg, index++);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["markdown", "json"].includes(result.format))
    throw new Error(`Unsupported format: ${result.format}`);
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const qualityManifest = yaml.load(
    await readFile(
      path.join(DEFAULT_REPO_ROOT, "evals/quality-manifest.yaml"),
      "utf8",
    ),
  );
  const qualityMetadata = parseQualityManifestMetadata(qualityManifest);
  const heavyEvaluations = parseHeavyEvaluations(qualityManifest);
  const blockedEvaluations = parseBlockedEvaluations(
    qualityManifest,
    heavyEvaluations,
  );
  const map = parseImpactMap(
    await readFile(
      path.join(DEFAULT_REPO_ROOT, "evals/impact-map.yaml"),
      "utf8",
    ),
    { allowedRequirements: qualityMetadata.requirementIds },
  );
  let changed;
  if (args.changedFiles.length > 0) {
    changed = {
      paths: args.changedFiles,
      complete: true,
      reason: "Explicit changed files.",
      comparison: {
        source: "explicit-paths",
        requested: { base: args.base ?? null, head: args.head ?? null },
        resolved: { base: null, head: null, mergeBase: null },
        includesWorkingTree: false,
      },
    };
  } else {
    changed = await collectChangedPaths({
      repoRoot: DEFAULT_REPO_ROOT,
      base: args.base || undefined,
      head: args.head || "HEAD",
    });
  }
  const selection = selectImpact(map, changed.paths, {
    forceAllReason: changed.complete ? undefined : changed.reason,
  });
  const execution = args.run
    ? await runSelectedSuites(selection, {
        routeStdoutToStderr: args.format === "json",
      })
    : [];
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    comparison: changed.comparison,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    selection,
    execution,
    heavy: deferredHeavy(selection, heavyEvaluations),
    blocked: selectedBlockedEvaluations(selection, blockedEvaluations),
  };
  const markdown = [
    formatImpactSummary(selection, execution),
    formatRunContext(report.comparison, report.environment),
    formatHeavyEvaluations(report.heavy),
    formatBlockedEvaluations(report.blocked),
  ].join("\n\n");
  const output =
    args.format === "json" ? JSON.stringify(report, null, 2) : markdown;
  process.stdout.write(`${output}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
  if (args.report) {
    await writeFile(
      path.resolve(DEFAULT_REPO_ROOT, args.report),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  if (execution.some((entry) => entry.status !== "passed"))
    process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
