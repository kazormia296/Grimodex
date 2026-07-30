#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  PRODUCT_CHAT_SCOPES,
  PRODUCT_CONTRACT_EXEMPTIONS,
  PRODUCT_CONTRACT_REQUIREMENTS,
  PRODUCT_DOMAIN_RULES,
  PRODUCT_INTERACTION_REQUIREMENTS,
  PRODUCT_JOURNEY_CAPABILITY_ORDER,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_COVERAGE_BACKLOG,
  PRODUCT_JOURNEY_ROLLOUT_MODE,
  PRODUCT_NATIVE_PERSISTENCE_DOMAINS,
  PRODUCT_SCOPE_TRANSITIONS,
} from "./product-journey-catalog.mjs";

function unique(values) {
  return [...new Set(values)];
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new Error(`${label} must not contain surrounding whitespace`);
  }
  return value;
}

function assertStringArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${label} must be ${allowEmpty ? "an" : "a non-empty"} array`,
    );
  }
  const result = value.map((entry, index) =>
    assertString(entry, `${label}[${index}]`),
  );
  if (unique(result).length !== result.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return result;
}

function assertUniqueIds(entries, label, readId = (entry) => entry.id) {
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} ${index} must be an object`);
    }
    const id = assertString(readId(entry), `${label} ${index} id`);
    if (seen.has(id)) throw new Error(`Duplicate ${label} id: ${id}`);
    seen.add(id);
  }
  return seen;
}

function sameOrderedValues(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function parseExpiry(value, label) {
  const text = assertString(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const expiry = new Date(`${text}T23:59:59.999Z`);
  if (
    Number.isNaN(expiry.getTime()) ||
    expiry.getUTCFullYear() !== year ||
    expiry.getUTCMonth() + 1 !== month ||
    expiry.getUTCDate() !== day
  ) {
    throw new Error(`${label} is not a valid date`);
  }
  return expiry;
}

export function formatCoverageError({ kind, id, domains = [] }) {
  const noun = kind === "interaction" ? "interaction" : "contract";
  const mapping =
    kind === "interaction"
      ? "map an existing journey to this interaction"
      : "map an existing journey to this contract";
  return [
    `Uncovered product ${noun}:`,
    `  ${id}`,
    "",
    "Affected domains:",
    `  ${domains.length > 0 ? domains.join(", ") : "(not declared)"}`,
    "",
    "Required action:",
    `  - ${mapping}`,
    "  - add a new journey",
    "  - add an explicit reviewed exemption with reason, tracking issue, and expiry",
  ].join("\n");
}

function coverageExemptionKey(targetType, targetId) {
  return `${targetType}:${targetId}`;
}

/**
 * Validate the semantic coverage ratchet without importing the Electron
 * runner or Playwright. Runner parity can be supplied by contract tests after
 * dependencies are installed.
 */
export function validateProductJourneyCoverage({
  catalog,
  domainRules,
  requiredContracts,
  scopeTransitions,
  nativePersistenceDomains,
  interactions,
  exemptions = [],
  implementationIds,
  backlog = [],
  authoritativeChatScopes = [],
  rolloutMode = "shadow",
  now = new Date(),
}) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error("product journey catalog must be a non-empty array");
  }
  if (!Array.isArray(domainRules) || domainRules.length === 0) {
    throw new Error("product domain rules must be a non-empty array");
  }
  if (!Array.isArray(requiredContracts) || requiredContracts.length === 0) {
    throw new Error("required product contracts must be a non-empty array");
  }
  if (!Array.isArray(scopeTransitions)) {
    throw new Error("scope transitions must be an array");
  }
  if (!Array.isArray(nativePersistenceDomains)) {
    throw new Error("native persistence domains must be an array");
  }
  if (!Array.isArray(interactions)) {
    throw new Error("product interactions must be an array");
  }
  if (!Array.isArray(exemptions)) {
    throw new Error("product contract exemptions must be an array");
  }
  if (!Array.isArray(backlog)) {
    throw new Error("product journey coverage backlog must be an array");
  }
  if (!Array.isArray(authoritativeChatScopes)) {
    throw new Error("authoritative ChatScopes must be an array");
  }
  if (!["shadow", "affected"].includes(rolloutMode)) {
    throw new Error(`unsupported product journey rollout mode: ${rolloutMode}`);
  }

  assertUniqueIds(catalog, "journey");
  assertUniqueIds(domainRules, "domain rule");
  const contractIds = assertUniqueIds(requiredContracts, "contract");
  const interactionIds = assertUniqueIds(interactions, "interaction");
  const journeyIds = catalog.map((journey) => journey.id);
  assertUniqueIds(backlog, "planned journey");
  const plannedJourneyIds = backlog.map((journey) => journey.id);
  const duplicatePlannedJourney = plannedJourneyIds.find((id) =>
    journeyIds.includes(id),
  );
  if (duplicatePlannedJourney) {
    throw new Error(
      `planned journey is already active and must leave the backlog: ${duplicatePlannedJourney}`,
    );
  }
  const plannedContractIds = [];
  const seenPlannedContracts = new Set();
  const activeAndPlannedCoverageDomains = new Set();
  for (const journey of backlog) {
    const domains = assertStringArray(
      journey.domains,
      `planned journey ${journey.id} domains`,
    );
    const journeyInteractions = assertStringArray(
      journey.interactions,
      `planned journey ${journey.id} interactions`,
      { allowEmpty: true },
    );
    const contracts = assertStringArray(
      journey.contracts,
      `planned journey ${journey.id} contracts`,
    );
    const capabilities = assertStringArray(
      journey.capabilities,
      `planned journey ${journey.id} capabilities`,
    );
    const canonicalCapabilities = PRODUCT_JOURNEY_CAPABILITY_ORDER.filter(
      (capability) => capabilities.includes(capability),
    );
    if (!sameOrderedValues(capabilities, canonicalCapabilities)) {
      throw new Error(
        `planned journey ${journey.id} capabilities must follow the canonical order`,
      );
    }
    for (const capability of capabilities) {
      if (!PRODUCT_JOURNEY_CAPABILITY_ORDER.includes(capability)) {
        throw new Error(
          `planned journey ${journey.id} has unknown capability: ${capability}`,
        );
      }
    }
    const temporaryMetadataFields = ["reason", "trackingIssue", "expiresOn"];
    const declaredTemporaryMetadataFields = temporaryMetadataFields.filter(
      (field) => Object.hasOwn(journey, field),
    );
    if (
      declaredTemporaryMetadataFields.length > 0 &&
      declaredTemporaryMetadataFields.length !== temporaryMetadataFields.length
    ) {
      throw new Error(
        `planned journey ${journey.id} temporary metadata must include reason, trackingIssue, and expiresOn together`,
      );
    }
    if (declaredTemporaryMetadataFields.length > 0) {
      assertString(journey.reason, `planned journey ${journey.id} reason`);
      assertString(
        journey.trackingIssue,
        `planned journey ${journey.id} trackingIssue`,
      );
      const expiry = parseExpiry(
        journey.expiresOn,
        `planned journey ${journey.id} expiresOn`,
      );
      if (expiry.getTime() < now.getTime()) {
        throw new Error(
          `Expired planned journey: ${journey.id} (${journey.expiresOn})`,
        );
      }
    }
    for (const contractId of contracts) {
      if (contractIds.has(contractId)) {
        throw new Error(
          `planned contract is already required and must leave the backlog: ${contractId}`,
        );
      }
      if (seenPlannedContracts.has(contractId)) {
        throw new Error(`duplicate planned contract: ${contractId}`);
      }
      seenPlannedContracts.add(contractId);
      plannedContractIds.push(contractId);
    }
    for (const domain of domains) {
      activeAndPlannedCoverageDomains.add(domain);
    }
    for (const interactionId of journeyInteractions) {
      const endpoints = interactionId.split("->");
      if (
        endpoints.length !== 2 ||
        endpoints.some((endpoint) => endpoint.length === 0)
      ) {
        throw new Error(
          `planned journey ${journey.id} interaction must have two domains joined by ->: ${interactionId}`,
        );
      }
      for (const endpoint of endpoints) {
        activeAndPlannedCoverageDomains.add(endpoint);
      }
    }
  }
  if (implementationIds !== undefined) {
    const normalizedImplementationIds = assertStringArray(
      implementationIds,
      "runner implementation IDs",
    );
    if (!sameOrderedValues(journeyIds, normalizedImplementationIds)) {
      const missing = journeyIds.filter(
        (id) => !normalizedImplementationIds.includes(id),
      );
      const unexpected = normalizedImplementationIds.filter(
        (id) => !journeyIds.includes(id),
      );
      throw new Error(
        [
          "Catalog and runner journey IDs differ.",
          `Catalog: ${journeyIds.join(", ")}`,
          `Runner: ${normalizedImplementationIds.join(", ")}`,
          `Missing implementations: ${missing.join(", ") || "(none)"}`,
          `Unexpected implementations: ${unexpected.join(", ") || "(none)"}`,
        ].join(" "),
      );
    }
  }

  const normalizedDomainRules = [];
  for (const rule of domainRules) {
    assertStringArray(rule.paths, `domain rule ${rule.id} paths`);
    const domains = assertStringArray(
      rule.domains,
      `domain rule ${rule.id} domains`,
      { allowEmpty: true },
    );
    if (
      domains.length === 0 &&
      rule.neutral !== true &&
      rule.forceAll !== true
    ) {
      throw new Error(
        `domain rule ${rule.id} with no domains must be neutral or forceAll`,
      );
    }
    let contracts = [];
    if (rule.contracts !== undefined) {
      contracts = assertStringArray(
        rule.contracts,
        `domain rule ${rule.id} contracts`,
      );
      for (const contractId of contracts) {
        if (
          !contractIds.has(contractId) &&
          !seenPlannedContracts.has(contractId)
        ) {
          throw new Error(
            `domain rule ${rule.id} references unknown contract: ${contractId}`,
          );
        }
      }
    }
    normalizedDomainRules.push({
      id: rule.id,
      domains,
      contracts,
      neutral: rule.neutral === true,
      forceAll: rule.forceAll === true,
    });
  }

  const contractDomainsById = new Map();
  for (const requirement of requiredContracts) {
    const domains = assertStringArray(
      requirement.domains,
      `contract ${requirement.id} domains`,
    );
    contractDomainsById.set(requirement.id, domains);
  }

  const interactionDomainsById = new Map();
  for (const interaction of interactions) {
    const domains = assertStringArray(
      interaction.domains,
      `interaction ${interaction.id} domains`,
    );
    const ambiguousDomainIndex = domains.findIndex((domain) =>
      domain.includes("->"),
    );
    if (ambiguousDomainIndex >= 0) {
      throw new Error(
        `interaction ${interaction.id} domain ${ambiguousDomainIndex} must not contain ->`,
      );
    }
    if (domains.length !== 2 || interaction.id !== domains.join("->")) {
      throw new Error(
        `interaction ${interaction.id} must equal its two domains joined by ->`,
      );
    }
    interactionDomainsById.set(interaction.id, domains);
  }

  const coveredContracts = new Set();
  const coveredInteractions = new Set();
  for (const journey of catalog) {
    const journeyDomains = assertStringArray(
      journey.domains,
      `journey ${journey.id} domains`,
    );
    const journeyInteractions = assertStringArray(
      journey.interactions,
      `journey ${journey.id} interactions`,
      { allowEmpty: true },
    );
    const journeyContracts = assertStringArray(
      journey.contracts,
      `journey ${journey.id} contracts`,
      { allowEmpty: true },
    );
    const capabilities = assertStringArray(
      journey.capabilities,
      `journey ${journey.id} capabilities`,
    );

    for (const capability of capabilities) {
      if (!PRODUCT_JOURNEY_CAPABILITY_ORDER.includes(capability)) {
        throw new Error(
          `journey ${journey.id} has unknown capability: ${capability}`,
        );
      }
    }
    const canonicalCapabilities = PRODUCT_JOURNEY_CAPABILITY_ORDER.filter(
      (capability) => capabilities.includes(capability),
    );
    if (!sameOrderedValues(capabilities, canonicalCapabilities)) {
      throw new Error(
        `journey ${journey.id} capabilities must follow the canonical order`,
      );
    }
    const journeyCoverageDomains = new Set(journeyDomains);
    for (const domain of journeyDomains) {
      activeAndPlannedCoverageDomains.add(domain);
    }
    for (const interactionId of journeyInteractions) {
      if (!interactionIds.has(interactionId)) {
        throw new Error(
          `journey ${journey.id} references unknown interaction: ${interactionId}`,
        );
      }
      for (const domain of interactionDomainsById.get(interactionId)) {
        journeyCoverageDomains.add(domain);
        activeAndPlannedCoverageDomains.add(domain);
      }
      coveredInteractions.add(interactionId);
    }
    for (const contractId of journeyContracts) {
      if (!contractIds.has(contractId)) {
        throw new Error(
          `journey ${journey.id} references unknown contract: ${contractId}`,
        );
      }
      const missingDomains = contractDomainsById
        .get(contractId)
        .filter((domain) => !journeyCoverageDomains.has(domain));
      if (missingDomains.length > 0) {
        throw new Error(
          `journey ${journey.id} cannot cover contract ${contractId}; missing affected domains: ${missingDomains.join(", ")}`,
        );
      }
      coveredContracts.add(contractId);
    }
  }

  const authoritativeScopeIds = assertStringArray(
    authoritativeChatScopes,
    "authoritative ChatScopes",
    { allowEmpty: true },
  );
  const declaredChatScopeIds = [];
  const seenScopeTransitions = new Set();
  for (const [index, transition] of scopeTransitions.entries()) {
    if (
      !transition ||
      typeof transition !== "object" ||
      Array.isArray(transition)
    ) {
      throw new Error(`scope transition ${index} must be an object`);
    }
    const operation = assertString(
      transition.operation,
      `scope transition ${index} operation`,
    );
    const scope = assertString(
      transition.scope,
      `scope transition ${index} scope`,
    );
    const authority = assertString(
      transition.authority,
      `scope transition ${index} authority`,
    );
    if (!["chat-scope", "lifecycle"].includes(authority)) {
      throw new Error(
        `scope transition ${index} authority must be chat-scope or lifecycle`,
      );
    }
    const transitionKey = `${operation}:${scope}`;
    if (seenScopeTransitions.has(transitionKey)) {
      throw new Error(`Duplicate scope transition: ${transitionKey}`);
    }
    seenScopeTransitions.add(transitionKey);
    const canonical = `scope-transition:${operation}:${scope}`;
    if (transition.contractId !== canonical) {
      throw new Error(
        `Scope transition ${operation}/${scope} must declare canonical contract ${canonical}`,
      );
    }
    if (!contractIds.has(canonical)) {
      throw new Error(
        `Scope transition ${operation}/${scope} is missing required contract ${canonical}`,
      );
    }
    if (authority === "chat-scope" && operation === "chat-stream") {
      declaredChatScopeIds.push(scope);
    }
  }
  const missingChatScopes = authoritativeScopeIds.filter(
    (scope) => !declaredChatScopeIds.includes(scope),
  );
  const staleChatScopes = declaredChatScopeIds.filter(
    (scope) => !authoritativeScopeIds.includes(scope),
  );
  if (missingChatScopes.length > 0 || staleChatScopes.length > 0) {
    throw new Error(
      [
        "Product journey chat-stream transitions must exactly match the authoritative ChatScope registry.",
        `Missing ChatScope transitions: ${missingChatScopes.join(", ") || "(none)"}`,
        `Stale ChatScope transitions: ${staleChatScopes.join(", ") || "(none)"}`,
      ].join(" "),
    );
  }

  const activeNativePersistenceContracts = new Set();
  for (const [index, persistence] of nativePersistenceDomains.entries()) {
    if (
      !persistence ||
      typeof persistence !== "object" ||
      Array.isArray(persistence)
    ) {
      throw new Error(`native persistence domain ${index} must be an object`);
    }
    const domain = assertString(
      persistence.domain,
      `native persistence domain ${index} domain`,
    );
    const canonical = `native-command-roundtrip:${domain}`;
    if (persistence.contractId !== canonical) {
      throw new Error(
        `Native persistence domain ${domain} must declare canonical contract ${canonical}`,
      );
    }
    if (!contractIds.has(canonical)) {
      throw new Error(
        `Native persistence domain ${domain} is missing required contract ${canonical}`,
      );
    }
    activeNativePersistenceContracts.add(canonical);
  }

  for (const rule of normalizedDomainRules) {
    if (rule.domains.includes("native-persistence")) {
      const persistenceDomains = rule.domains.filter(
        (candidate) => candidate !== "native-persistence",
      );
      if (persistenceDomains.length === 0) {
        throw new Error(
          `Domain rule ${rule.id} uses native-persistence without a concrete domain`,
        );
      }
      for (const domain of persistenceDomains) {
        const canonical = `native-command-roundtrip:${domain}`;
        if (
          !activeNativePersistenceContracts.has(canonical) &&
          !seenPlannedContracts.has(canonical)
        ) {
          throw new Error(
            `Domain rule ${rule.id} introduces native persistence domain ${domain} without active or planned contract ${canonical}`,
          );
        }
      }
    }
  }

  const exemptionKeys = new Set();
  const activeExemptions = new Map();
  const expiredExemptions = [];
  const structuralErrors = [];
  for (const [index, exemption] of exemptions.entries()) {
    if (
      !exemption ||
      typeof exemption !== "object" ||
      Array.isArray(exemption)
    ) {
      structuralErrors.push(`exemption ${index} must be an object`);
      continue;
    }
    try {
      const targetType = assertString(
        exemption.targetType,
        `exemption ${index} targetType`,
      );
      if (!["contract", "interaction"].includes(targetType)) {
        throw new Error(
          `exemption ${index} targetType must be contract or interaction`,
        );
      }
      const targetId = assertString(
        exemption.targetId,
        `exemption ${index} targetId`,
      );
      const knownTargets =
        targetType === "contract" ? contractIds : interactionIds;
      if (!knownTargets.has(targetId)) {
        throw new Error(
          `exemption ${index} references unknown ${targetType}: ${targetId}`,
        );
      }
      assertString(exemption.reason, `exemption ${index} reason`);
      assertString(exemption.trackingIssue, `exemption ${index} trackingIssue`);
      if (
        exemption.journeyId !== undefined &&
        !journeyIds.includes(exemption.journeyId)
      ) {
        throw new Error(
          `exemption ${index} references unknown journey: ${exemption.journeyId}`,
        );
      }
      const key = coverageExemptionKey(targetType, targetId);
      if (exemptionKeys.has(key)) {
        throw new Error(`Duplicate exemption target: ${targetId}`);
      }
      exemptionKeys.add(key);
      const expiry = parseExpiry(
        exemption.expiresOn,
        `exemption ${index} expiresOn`,
      );
      if (expiry.getTime() < now.getTime()) {
        expiredExemptions.push(targetId);
      } else {
        activeExemptions.set(key, exemption);
      }
    } catch (error) {
      structuralErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (expiredExemptions.length > 0) {
    structuralErrors.push(
      `Expired exemption targets: ${expiredExemptions.join(", ")}`,
    );
  }
  if (structuralErrors.length > 0) {
    throw new Error(structuralErrors.join("\n"));
  }

  const exemptedContracts = [];
  const exemptedInteractions = [];
  const uncoveredContracts = [];
  const uncoveredInteractions = [];
  const coverageErrors = [];

  for (const requirement of requiredContracts) {
    if (coveredContracts.has(requirement.id)) continue;
    if (
      activeExemptions.has(coverageExemptionKey("contract", requirement.id))
    ) {
      exemptedContracts.push(requirement.id);
      continue;
    }
    uncoveredContracts.push(requirement.id);
    coverageErrors.push(
      formatCoverageError({
        kind: "contract",
        id: requirement.id,
        domains: requirement.domains,
      }),
    );
  }

  for (const interaction of interactions) {
    if (coveredInteractions.has(interaction.id)) continue;
    if (
      activeExemptions.has(coverageExemptionKey("interaction", interaction.id))
    ) {
      exemptedInteractions.push(interaction.id);
      continue;
    }
    uncoveredInteractions.push(interaction.id);
    coverageErrors.push(
      formatCoverageError({
        kind: "interaction",
        id: interaction.id,
        domains: interaction.domains,
      }),
    );
  }

  if (coverageErrors.length > 0) {
    throw new Error(coverageErrors.join("\n\n"));
  }

  const affectedReady =
    backlog.length === 0 &&
    exemptedContracts.length === 0 &&
    exemptedInteractions.length === 0;
  if (rolloutMode === "affected" && !affectedReady) {
    throw new Error(
      `Affected product journey execution is blocked: ${backlog.length} planned journeys, ${plannedContractIds.length} planned contracts, and ${
        exemptedContracts.length + exemptedInteractions.length
      } active exemptions remain.`,
    );
  }

  for (const rule of normalizedDomainRules) {
    if (rule.neutral || rule.contracts.length > 0) continue;
    const unconnectedDomains = rule.domains.filter(
      (domain) =>
        domain !== "native-persistence" &&
        !activeAndPlannedCoverageDomains.has(domain),
    );
    if (unconnectedDomains.length > 0) {
      throw new Error(
        `Domain rule ${rule.id} domain ${unconnectedDomains.join(", ")} is not connected to an active or planned journey`,
      );
    }
  }

  return {
    journeyIds,
    contractIds: requiredContracts.map((contract) => contract.id),
    interactionIds: interactions.map((interaction) => interaction.id),
    coveredContracts: [...coveredContracts],
    coveredInteractions: [...coveredInteractions],
    exemptedContracts,
    exemptedInteractions,
    uncoveredContracts,
    uncoveredInteractions,
    expiredExemptions,
    plannedJourneyIds,
    plannedContractIds,
    affectedReady,
  };
}

export function validateCurrentProductJourneyCoverage(options = {}) {
  return validateProductJourneyCoverage({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    requiredContracts: PRODUCT_CONTRACT_REQUIREMENTS,
    scopeTransitions: PRODUCT_SCOPE_TRANSITIONS,
    nativePersistenceDomains: PRODUCT_NATIVE_PERSISTENCE_DOMAINS,
    interactions: PRODUCT_INTERACTION_REQUIREMENTS,
    exemptions: PRODUCT_CONTRACT_EXEMPTIONS,
    backlog: PRODUCT_JOURNEY_COVERAGE_BACKLOG,
    authoritativeChatScopes: PRODUCT_CHAT_SCOPES,
    rolloutMode: PRODUCT_JOURNEY_ROLLOUT_MODE,
    ...options,
  });
}

function formatCoverageSummary(result) {
  return [
    "## Grimodex product journey coverage ratchet",
    "",
    `- journeys: ${result.journeyIds.length}`,
    `- required contracts: ${result.contractIds.length}`,
    `- declared interactions: ${result.interactionIds.length}`,
    `- exemptions: ${
      result.exemptedContracts.length + result.exemptedInteractions.length
    }`,
    `- planned journeys: ${result.plannedJourneyIds.length}`,
    `- planned contracts: ${result.plannedContractIds.length}`,
    `- affected execution ready: ${result.affectedReady ? "yes" : "no"}`,
    `- status: ${result.affectedReady ? "complete" : "shadow"}`,
  ].join("\n");
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const result = validateCurrentProductJourneyCoverage();
    process.stdout.write(`${formatCoverageSummary(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
