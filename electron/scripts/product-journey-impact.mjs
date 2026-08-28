#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  classifyChangedPaths,
  collectChangedPaths,
  compilePathRules,
  formatImpactMarkdown,
  resolveSafeAll,
} from "../../scripts/impact/core.mjs";
import {
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_DOMAIN_RULES,
  PRODUCT_JOURNEY_CAPABILITY_ORDER,
  PRODUCT_JOURNEY_CATALOG,
  digestProductJourneyCatalog,
  PRODUCT_JOURNEY_ROLLOUT_MODE,
} from "./product-journey-catalog.mjs";
import { validateCurrentProductJourneyCoverage } from "./product-journey-coverage.mjs";

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, "../..");

export function resolveProductJourneyImpactCatalog(
  name = process.env.GRIMODEX_PRODUCT_JOURNEY_SET,
) {
  if (name === undefined || name === "") return PRODUCT_JOURNEY_CATALOG;
  if (name === "c2-5b") return NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG;
  if (name === "c2-zc") return NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG;
  throw new Error(`unknown GRIMODEX_PRODUCT_JOURNEY_SET: ${name}`);
}

function unique(values) {
  return [...new Set(values)];
}

function stableCapabilities(catalog) {
  const capabilities = new Set(
    catalog.flatMap((journey) => journey.capabilities),
  );
  return PRODUCT_JOURNEY_CAPABILITY_ORDER.filter((capability) =>
    capabilities.has(capability),
  );
}

function interactionTouchesDomains(interaction, affectedDomains) {
  const endpoints = interaction.split("->");
  return endpoints.some((endpoint) => affectedDomains.has(endpoint));
}

function policyAllPaths(rules, changedPaths) {
  return changedPaths.filter((candidate) =>
    rules.some(
      (rule) =>
        rule.forceAll === true &&
        rule.matchers.some((matcher) => matcher.test(candidate)),
    ),
  );
}

function selectionReason({
  safety,
  changedPaths,
  unmatchedPaths,
  criticalPaths,
  forceAllReason,
  journeyIds,
  affectedDomains,
  affectedContracts,
}) {
  switch (safety.reasonKind) {
    case "incomplete-diff":
      return forceAllReason || "Git diff incomplete; selected all journeys.";
    case "empty-diff":
      return "Empty diff; selected all product journeys by default.";
    case "unmatched-paths":
      return `Unclassified paths require all product journeys: ${unmatchedPaths.join(", ")}`;
    case "policy-all":
      return `Critical product journey paths require all journeys: ${criticalPaths.join(", ")}`;
    case "explicit-all":
      return "Explicit all mode selected the full product journey catalog.";
    default:
      return journeyIds.length === 0
        ? affectedDomains.length === 0 && affectedContracts.length === 0
          ? "All changed paths were classified as product-journey neutral."
          : "Changed product domains have no active journey; shadow coverage backlog remains."
        : `All ${changedPaths.length} changed path(s) were classified.`;
  }
}

/**
 * Deterministically select declared journeys. A journey is affected when a
 * changed domain appears in its domain list, on either side of one of its
 * declared interactions, or in a contract-boundary rule.
 */
export function selectProductJourneys({
  catalog,
  domainRules,
  changedPaths,
  forceAllReason,
  mode = "affected",
}) {
  if (!["affected", "all"].includes(mode)) {
    throw new Error(`Unsupported product journey selection mode: ${mode}`);
  }
  const rules = compilePathRules(domainRules);
  const classification = classifyChangedPaths(rules, changedPaths);
  const affectedDomains = unique(
    classification.matchedRules.flatMap((rule) => rule.domains ?? []),
  );
  const affectedContracts = unique(
    classification.matchedRules.flatMap((rule) => rule.contracts ?? []),
  );
  const criticalPaths = policyAllPaths(rules, classification.changedPaths);
  const safety =
    mode === "all"
      ? {
          fallback: false,
          allSelected: true,
          reasonKind: "explicit-all",
        }
      : resolveSafeAll({
          changedPaths: classification.changedPaths,
          unmatchedPaths: classification.unmatchedPaths,
          incompleteReason: forceAllReason,
          policyAllPaths: criticalPaths,
        });
  const affectedDomainSet = new Set(affectedDomains);
  const affectedContractSet = new Set(affectedContracts);
  const selected = safety.allSelected
    ? [...catalog]
    : catalog.filter(
        (journey) =>
          journey.domains.some((domain) => affectedDomainSet.has(domain)) ||
          journey.interactions.some((interaction) =>
            interactionTouchesDomains(interaction, affectedDomainSet),
          ) ||
          journey.contracts.some((contract) =>
            affectedContractSet.has(contract),
          ),
      );
  const journeyIds = selected.map((journey) => journey.id);

  return {
    changedPaths: classification.changedPaths,
    matchedRuleIds: classification.matchedRuleIds,
    unmatchedPaths: classification.unmatchedPaths,
    criticalPaths,
    affectedDomains,
    affectedContracts,
    journeyIds,
    capabilities: stableCapabilities(selected),
    fallback: safety.fallback,
    allSelected: safety.allSelected,
    reasonKind: safety.reasonKind,
    reason: selectionReason({
      safety,
      changedPaths: classification.changedPaths,
      unmatchedPaths: classification.unmatchedPaths,
      criticalPaths,
      forceAllReason,
      journeyIds,
      affectedDomains,
      affectedContracts,
    }),
  };
}

export function resolveProductJourneyExecution({ mode, catalog, selection }) {
  if (!["all", "shadow", "affected"].includes(mode)) {
    throw new Error(`Unsupported product journey mode: ${mode}`);
  }
  const executeAll = mode === "all" || mode === "shadow";
  const executionCatalog = executeAll
    ? catalog
    : catalog.filter((journey) => selection.journeyIds.includes(journey.id));
  const executionJourneyIds = executionCatalog.map((journey) => journey.id);
  return {
    catalogDigest: digestProductJourneyCatalog(catalog),
    mode,
    shadow: mode === "shadow",
    selectedJourneyIds: [...selection.journeyIds],
    selectedCapabilities: [...selection.capabilities],
    executionJourneyIds,
    executionCapabilities: stableCapabilities(executionCatalog),
    shouldRun: executionJourneyIds.length > 0,
  };
}

export function formatProductJourneyImpactSummary(
  selection,
  execution,
  coverage,
) {
  return formatImpactMarkdown({
    title: "Grimodex product journey impact",
    changedPaths: selection.changedPaths,
    matchedRuleIds: selection.matchedRuleIds,
    sections: [
      {
        heading: "Affected domains",
        values: selection.affectedDomains,
      },
      {
        heading: "Affected contracts",
        values: selection.affectedContracts,
      },
      {
        heading: "Recommended journeys",
        values: execution.selectedJourneyIds,
      },
      {
        heading: "Recommended capabilities",
        values: execution.selectedCapabilities,
      },
    ],
    fallback: selection.fallback,
    reason: selection.reason,
    trailingSections: [
      {
        heading: "Execution journeys",
        values: execution.executionJourneyIds,
      },
      {
        heading: "Execution capabilities",
        values: execution.executionCapabilities,
      },
      {
        heading: "Execution mode",
        values: [
          `Mode: ${execution.mode}`,
          `Shadow: ${execution.shadow ? "yes" : "no"}`,
          `Should run: ${execution.shouldRun ? "yes" : "no"}`,
        ],
      },
      ...(coverage
        ? [
            {
              heading: "Coverage exemptions",
              values:
                coverage.exemptedContracts.length +
                  coverage.exemptedInteractions.length >
                0
                  ? [
                      ...coverage.exemptedContracts,
                      ...coverage.exemptedInteractions,
                    ]
                  : ["No active coverage exemptions"],
            },
            {
              heading: "Coverage backlog",
              values: [
                ...(coverage.plannedJourneyIds.length > 0
                  ? coverage.plannedJourneyIds
                  : ["No planned coverage gaps"]),
                coverage.affectedReady
                  ? "Affected execution is ready"
                  : `${coverage.plannedContractIds.length} planned contract(s) and ${
                      coverage.exemptedContracts.length +
                      coverage.exemptedInteractions.length
                    } active exemption(s); affected execution remains locked`,
              ],
            },
          ]
        : []),
    ],
  });
}

function parseArgs(argv) {
  const result = {
    mode: "all",
    changedFiles: [],
    format: "markdown",
  };
  const readValue = (option, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--mode") {
      result.mode = readValue(argument, index++);
    } else if (argument === "--base") {
      result.base = readValue(argument, index++);
    } else if (argument === "--head") {
      result.head = readValue(argument, index++);
    } else if (argument === "--changed-file") {
      result.changedFiles.push(readValue(argument, index++));
    } else if (argument === "--format") {
      result.format = readValue(argument, index++);
    } else if (argument === "--report") {
      result.report = readValue(argument, index++);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!["all", "shadow", "affected"].includes(result.mode)) {
    throw new Error(`Unsupported product journey mode: ${result.mode}`);
  }
  if (!["markdown", "json"].includes(result.format)) {
    throw new Error(`Unsupported format: ${result.format}`);
  }
  return result;
}

async function appendGithubOutputs(execution) {
  if (!process.env.GITHUB_OUTPUT) return;
  const values = {
    catalog_digest: execution.catalogDigest,
    selected_journey_ids: execution.selectedJourneyIds,
    selected_capabilities: execution.selectedCapabilities,
    execution_journey_ids: execution.executionJourneyIds,
    execution_capabilities: execution.executionCapabilities,
  };
  const lines = Object.entries(values).map(
    ([key, value]) =>
      `${key}=${key === "catalog_digest" ? value : JSON.stringify(value)}`,
  );
  lines.push(`should_run=${execution.shouldRun ? "true" : "false"}`);
  lines.push(`shadow=${execution.shadow ? "true" : "false"}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = resolveProductJourneyImpactCatalog();
  if (args.mode === "affected" && PRODUCT_JOURNEY_ROLLOUT_MODE !== "affected") {
    throw new Error(
      "Affected product journey execution is locked until shadow coverage is complete.",
    );
  }
  const coverage = validateCurrentProductJourneyCoverage();
  let changed;
  if (args.changedFiles.length > 0) {
    changed = {
      paths: args.changedFiles,
      complete: true,
      reason: "Explicit changed files.",
      comparison: {
        source: "explicit-paths",
        requested: {
          base: args.base ?? null,
          head: args.head ?? null,
        },
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
  const selection = selectProductJourneys({
    catalog,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: changed.paths,
    forceAllReason: changed.complete ? undefined : changed.reason,
    mode: args.mode === "all" ? "all" : "affected",
  });
  const execution = resolveProductJourneyExecution({
    mode: args.mode,
    catalog,
    selection,
  });
  const report = {
    version: 1,
    catalogDigest: execution.catalogDigest,
    generatedAt: new Date().toISOString(),
    comparison: changed.comparison,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    coverage: {
      journeyCount: coverage.journeyIds.length,
      contractCount: coverage.contractIds.length,
      interactionCount: coverage.interactionIds.length,
      exemptionCount:
        coverage.exemptedContracts.length +
        coverage.exemptedInteractions.length,
      exemptedContractIds: coverage.exemptedContracts,
      exemptedInteractionIds: coverage.exemptedInteractions,
      plannedJourneyIds: coverage.plannedJourneyIds,
      plannedContractIds: coverage.plannedContractIds,
      affectedReady: coverage.affectedReady,
    },
    selection,
    execution,
  };
  const markdown = formatProductJourneyImpactSummary(
    selection,
    execution,
    coverage,
  );
  process.stdout.write(
    `${args.format === "json" ? JSON.stringify(report, null, 2) : markdown}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
  await appendGithubOutputs(execution);
  if (args.report) {
    const reportPath = path.resolve(DEFAULT_REPO_ROOT, args.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
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
