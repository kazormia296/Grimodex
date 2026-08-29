import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

import {
  C2ZC_RUST_ACCEPTANCE_GATES,
  C2ZC_RUST_ACCEPTANCE_LOCAL_CI_STAGE_ID,
  C2ZC_RUST_ACCEPTANCE_RUNNER_COMMAND,
} from "../c2zc-rust-acceptance-receipt.mjs";

import {
  classifyChangedPaths,
  collectChangedPaths,
  compileGlob,
  formatImpactMarkdown,
  resolveSafeAll,
} from "../impact/core.mjs";

export {
  classifyChangedPaths,
  collectChangedPaths,
  compileGlob,
  formatImpactMarkdown,
  resolveSafeAll,
};
export { compilePathRules } from "../impact/core.mjs";

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_LOCAL_CI_REGISTRY_PATH = path.join(
  DEFAULT_REPO_ROOT,
  "scripts/local-ci-registry.json",
);

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
        "src/features/ai-audit/api.test.ts",
        "src/features/ai-audit/orderedStreamAudit.test.ts",
        "src/features/ai-audit/transportContext.test.ts",
        "src/features/ai-audit/legacyEvidence.test.ts",
        "src/features/ai-audit/reportCoverage.test.ts",
        "src/features/ai-audit/exportBundle.test.ts",
        "src/features/attribution/AttributionProjectView.ai-audit.test.tsx",
        "src/features/chat/singleShotTransport.audit.test.ts",
        "src/features/chat/chatApi.audit.test.ts",
        "src/features/chat/externalRuntimeAudit.test.ts",
        "src/features/editor/inlineAi/inlineAiStreaming.audit.test.ts",
        "src/features/ab-test/abHarness.test.ts",
        "src/lib/browser-mock.ai-audit.test.ts",
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
  "narrative-runtime": {
    failureClasses: ["policy", "quality"],
    commands: [
      ["pnpm", "test:narrative:run-kind-policy"],
      ["pnpm", "test:narrative:execution-state"],
      ["pnpm", "test:narrative:writers"],
      [
        "pnpm",
        "test:electron",
        "--run",
        "electron/main/narrativeFreshness.test.ts",
      ],
      ["pnpm", "exec", "tsc", "-p", "electron/tsconfig.json", "--noEmit"],
      [
        "pnpm",
        "test:node",
        "--run",
        "src/features/narrative-extraction/runtime",
        "src/features/narrative-extraction/maintenance",
      ],
      [
        "node",
        "--test",
        "scripts/product-journey-phase1.test.mjs",
        "scripts/c2-5b-product-journeys.test.mjs",
        "scripts/c2zc-product-journeys.test.mjs",
      ],
      [
        "cargo",
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "narrative_runtime_authority",
      ],
      [
        "cargo",
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "narrative_incremental_freshness_runtime",
      ],
      [
        "cargo",
        "check",
        "--manifest-path",
        "electron/native/grimodex-node/Cargo.toml",
      ],
    ],
  },
  "narrative-semantic-contract": {
    failureClasses: ["policy", "quality", "artifact"],
    commands: [
      ["pnpm", "test:narrative:semantic-contract"],
      [
        "pnpm",
        "test",
        "--run",
        "src/features/narrative-extraction/source/scopeAuthorityBasisV2.contract.test.ts",
        "src/features/tree/api.listProjection.test.ts",
        "src/application/narrative-extraction/projectSnapshotAdapter.test.ts",
        "src/application/narrative-extraction/extractionCoordinator.test.ts",
      ],
      ["pnpm", "test:electron", "--run", "electron/shared/ipcContract.test.ts"],
      [
        "cargo",
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-core",
        "--test",
        "narrative_scope_authority_basis",
      ],
      [
        "cargo",
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "narrative_extraction::execution_state::tests::run_transition_persists_millisecond_rfc3339_timestamps",
      ],
      [
        "cargo",
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "narrative_extraction::repository::unit_tests::every_generic_public_task_api_rejects_runtime_owned_automatic_runs",
      ],
      [
        "cargo",
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "narrative_extraction::repository::unit_tests::list_resumable_runs_orders_mixed_legacy_and_rfc3339_instants",
      ],
      [
        "cargo",
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "narrative_extraction::legacy_backfill::tests::backfill_owner_finalizer_survives_generic_cancel_phase_gap",
      ],
      [
        "cargo",
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--lib",
        "narrative_extraction::restore_rebuild::tests::rebuild_finalization_after_epoch_rotation_is_failed_and_returns_error",
      ],
      [
        "cargo",
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "narrative_terminal_failure_projection",
      ],
      [
        "cargo",
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "-p",
        "grimodex-db",
        "--test",
        "narrative_scope_authority_runtime",
      ],
    ],
  },
  "narrative-extraction": {
    failureClasses: ["quality", "artifact"],
    commands: [["pnpm", "eval:narrative"]],
  },
});

function unique(values) {
  return [...new Set(values)];
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeAcceptanceGate(gate) {
  return {
    id: gate?.id,
    argv: gate?.argv,
    contract: gate?.contract,
    source: gate?.source,
    test: gate?.test,
    fullTestName: gate?.fullTestName,
    requiresReceipt: gate?.requiresReceipt,
  };
}

function assertStructuredAcceptanceGates(rawGates, ruleId) {
  if (!Array.isArray(rawGates)) {
    throw new Error(`rule ${ruleId} acceptanceGates must be an array`);
  }
  if (rawGates.length !== C2ZC_RUST_ACCEPTANCE_GATES.length) {
    throw new Error(
      `rule ${ruleId} acceptanceGates must contain the two ordered Rust gates`,
    );
  }
  for (const [index, rawGate] of rawGates.entries()) {
    const expectedKeys = Object.keys(
      normalizeAcceptanceGate(C2ZC_RUST_ACCEPTANCE_GATES[index]),
    ).sort();
    const observedKeys = Object.keys(rawGate ?? {}).sort();
    if (canonicalJson(observedKeys) !== canonicalJson(expectedKeys)) {
      throw new Error(
        `rule ${ruleId} acceptanceGates[${index}] has an invalid structured shape`,
      );
    }
    if (
      canonicalJson(normalizeAcceptanceGate(rawGate)) !==
      canonicalJson(normalizeAcceptanceGate(C2ZC_RUST_ACCEPTANCE_GATES[index]))
    ) {
      throw new Error(
        `rule ${ruleId} acceptanceGates[${index}] does not match the exported Rust gate definition`,
      );
    }
  }
  return rawGates.map((gate) => ({
    id: gate.id,
    argv: {
      command: gate.argv.command,
      args: [...gate.argv.args],
      cwd: gate.argv.cwd,
    },
    contract: { ...gate.contract },
    source: gate.source,
    test: gate.test,
    fullTestName: gate.fullTestName,
    requiresReceipt: gate.requiresReceipt,
  }));
}

function readDefaultLocalCiRegistry() {
  return JSON.parse(readFileSync(DEFAULT_LOCAL_CI_REGISTRY_PATH, "utf8"));
}

export function validateAcceptanceGateRegistration({
  map,
  localCiRegistry = readDefaultLocalCiRegistry(),
} = {}) {
  if (!map || !Array.isArray(map.rules)) {
    throw new Error("Impact map is required for acceptance gate validation");
  }
  const acceptanceRules = map.rules.filter((rule) =>
    Object.hasOwn(rule, "acceptanceGates"),
  );
  if (acceptanceRules.length !== 1) {
    throw new Error(
      "Impact map must contain exactly one structured C2-ZC acceptance gate rule",
    );
  }
  const [rule] = acceptanceRules;
  assertStructuredAcceptanceGates(rule.acceptanceGates, rule.id);
  if (Object.hasOwn(rule, "acceptanceGate")) {
    throw new Error("Legacy free-text acceptanceGate is not allowed");
  }
  const stage =
    localCiRegistry?.stages?.[C2ZC_RUST_ACCEPTANCE_LOCAL_CI_STAGE_ID];
  if (!stage || !Array.isArray(stage.commands) || stage.commands.length !== 1) {
    throw new Error(
      "Local-CI Rust acceptance registry must expose one exact runner command",
    );
  }
  const registeredCommand = stage.commands[0];
  const normalizedRegisteredCommand = {
    command: registeredCommand.command,
    args: registeredCommand.args,
    cwd: registeredCommand.cwd ?? ".",
  };
  if (
    canonicalJson(normalizedRegisteredCommand) !==
    canonicalJson(C2ZC_RUST_ACCEPTANCE_RUNNER_COMMAND)
  ) {
    throw new Error(
      "Local-CI Rust acceptance registry runner command does not match the exported receipt runner",
    );
  }
  return true;
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
    if (Object.hasOwn(rawRule, "acceptanceGate")) {
      throw new Error(
        `rule ${id} must use structured acceptanceGates, not acceptanceGate`,
      );
    }
    const acceptanceGates = Object.hasOwn(rawRule, "acceptanceGates")
      ? assertStructuredAcceptanceGates(rawRule.acceptanceGates, id)
      : undefined;
    return {
      id,
      reason,
      paths,
      matchers,
      requirements,
      suites,
      ...(acceptanceGates ? { acceptanceGates } : {}),
    };
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
  const map = { version: 1, allSuites, rules, default: "all" };
  if (rules.some((rule) => Object.hasOwn(rule, "acceptanceGates"))) {
    validateAcceptanceGateRegistration({
      map,
      localCiRegistry: options.localCiRegistry,
    });
  }
  return map;
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
  const {
    changedPaths: paths,
    matchedRules,
    matchedRuleIds,
    unmatchedPaths,
  } = classifyChangedPaths(map.rules, changedPaths);
  const allRequirementIds = unique(
    map.rules.flatMap((rule) => rule.requirements),
  );
  const explicitAll = matchedRules.some((rule) => rule.suites.includes("all"));
  const invariantAllPaths = paths.filter(isInvariantAllPath);
  const forcedReason = options.forceAllReason?.trim();
  const { fallback, allSelected } = resolveSafeAll({
    changedPaths: paths,
    unmatchedPaths,
    incompleteReason: forcedReason,
    policyAllPaths: invariantAllPaths,
    explicitAll,
  });
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
        : invariantAllPaths.length > 0
          ? `Critical workflow paths require all suites: ${invariantAllPaths.join(", ")}`
          : explicitAll
            ? "A matched global rule selected all suites."
            : "All changed paths were classified.";

  return {
    changedPaths: paths,
    matchedRuleIds,
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
  return formatImpactMarkdown({
    title: "Grimodex quality impact gate",
    changedPaths: selection.changedPaths,
    matchedRuleIds: selection.matchedRuleIds,
    sections: [
      {
        heading: "Affected requirements",
        values: selection.requirementIds,
      },
      {
        heading: "Selected light suites",
        values: selection.suiteIds,
      },
    ],
    trailingSections:
      executionLines.length > 0
        ? [{ heading: "Execution", values: executionLines }]
        : [],
    fallback: selection.fallback,
    reason: selection.reason,
  });
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
    // Invoke the Windows package-manager shim directly; never pass frozen
    // argv through caller-controlled ComSpec/cmd.exe meta-character parsing.
    const executable =
      process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
    const commandArgs = args;
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
