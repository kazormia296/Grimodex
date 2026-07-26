import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const OUTPUT_VALIDATOR_IDS = new Set([
  "artifact-link",
  "citation",
  "failure-class",
  "json-contract",
  "localized-parity",
  "no-duplicate-retry",
  "no-side-effect",
  "no-stale-claim",
  "ordered-list",
  "revision-match",
  "schema",
  "single-question",
  "source-attribution",
  "target-match",
  "tool-result-linked",
]);

const BLOCK_CONTRACTS = {
  "route-disabled": "routing",
  "policy-missing": "precheck",
  "confirmation-missing": "precheck",
  "consent-missing": "precheck",
  "unknown-tool": "tool",
  "channel-denied": "policy",
  "stale-evidence": "quality",
  "output-invalid": "artifact",
};

const FRESHNESS_VALUES = new Set(["stable", "current-project", "volatile"]);
const CHANNEL_VALUES = new Set(["agent", "hermes", "native"]);
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fixtureFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await fixtureFiles(absolute)));
    else if (/\.ya?ml$/.test(entry.name)) files.push(absolute);
  }
  return files.sort();
}

export async function loadQualityModel({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const manifest = yaml.load(
    await readFile(path.join(repoRoot, "evals/quality-manifest.yaml"), "utf8"),
  );
  const cases = [];
  for (const file of await fixtureFiles(
    path.join(repoRoot, "evals/fixtures"),
  )) {
    const parsed = yaml.load(await readFile(file, "utf8"));
    const fromFile = Array.isArray(parsed?.cases) ? parsed.cases : [parsed];
    for (const evaluationCase of fromFile) {
      cases.push({
        ...evaluationCase,
        sourceFile: path.relative(repoRoot, file).replaceAll("\\", "/"),
      });
    }
  }
  const toolManifest = JSON.parse(
    await readFile(path.join(repoRoot, "agent-tool-manifest.json"), "utf8"),
  );
  return {
    version: manifest.version,
    failureClasses: manifest.failureClasses,
    lightSuites: manifest.lightSuites,
    requirements: manifest.requirements,
    heavyEvaluations: manifest.heavyEvaluations,
    blockedEvaluations: manifest.blockedEvaluations,
    cases,
    toolManifest,
  };
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function markdownDefinesFragment(contents, fragment) {
  return contents.split(/\r?\n/).some((line) => {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return false;
    const heading = match[1].trim();
    return (
      heading === fragment ||
      heading.startsWith(`${fragment} `) ||
      heading.startsWith(`${fragment} —`) ||
      heading.startsWith(`${fragment} –`)
    );
  });
}

function validLocale(locale) {
  try {
    const canonical = Intl.getCanonicalLocales(locale);
    return (
      canonical.length === 1 &&
      Intl.DateTimeFormat.supportedLocalesOf(canonical).length === 1
    );
  } catch {
    return false;
  }
}

function validTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function validIsoTimestamp(value) {
  if (!nonEmpty(value)) return false;
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    zone,
    offsetHour,
    offsetMinute,
  ] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const calendar = new Date(
    Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]),
  );
  if (
    calendar.getUTCFullYear() !== parts[0] ||
    calendar.getUTCMonth() + 1 !== parts[1] ||
    calendar.getUTCDate() !== parts[2] ||
    calendar.getUTCHours() !== parts[3] ||
    calendar.getUTCMinutes() !== parts[4] ||
    calendar.getUTCSeconds() !== parts[5]
  ) {
    return false;
  }
  if (fraction && fraction.length > 3) return false;
  if (zone !== "Z") {
    const offsetHours = Number(offsetHour);
    const offsetMinutes = Number(offsetMinute);
    if (
      offsetHours > 14 ||
      offsetMinutes > 59 ||
      (offsetHours === 14 && offsetMinutes !== 0)
    ) {
      return false;
    }
  }
  return true;
}

export async function validateQualityModel(
  model,
  { repoRoot = DEFAULT_REPO_ROOT } = {},
) {
  const errors = [];
  const requiredFailureClasses = [
    "routing",
    "precheck",
    "tool",
    "policy",
    "quality",
    "artifact",
  ];
  const failureClasses = asArray(model.failureClasses);
  if (model.version !== 1) errors.push("quality manifest version must be 1");
  if (
    JSON.stringify(failureClasses) !== JSON.stringify(requiredFailureClasses)
  ) {
    errors.push(`failure classes must be ${requiredFailureClasses.join(", ")}`);
  }
  if (!Array.isArray(model.requirements) || model.requirements.length === 0) {
    errors.push("requirements must be non-empty");
  }
  if (
    !Array.isArray(model.cases) ||
    model.cases.length < 20 ||
    model.cases.length > 30
  ) {
    errors.push("light evaluation corpus must contain 20-30 cases");
  }

  const requirementIds = new Set();
  const caseIds = new Set();
  const suiteIds = new Set(asArray(model.lightSuites));
  if (suiteIds.size !== asArray(model.lightSuites).length) {
    errors.push("lightSuites contains duplicates");
  }
  const coveredRequirementIds = new Set();
  const stateOwners = new Map();
  const runOwners = new Map();
  const usedFailureClasses = new Set();
  const usedSuiteIds = new Set();
  const allCaseIds = new Set(asArray(model.cases).map((entry) => entry?.id));
  const casesById = new Map(
    asArray(model.cases).map((entry) => [entry?.id, entry]),
  );
  const requirementsById = new Map(
    asArray(model.requirements).map((entry) => [entry?.id, entry]),
  );

  for (const requirement of asArray(model.requirements)) {
    if (!nonEmpty(requirement?.id)) {
      errors.push("requirement id must be non-empty");
      continue;
    }
    if (requirementIds.has(requirement.id))
      errors.push(`duplicate requirement id: ${requirement.id}`);
    requirementIds.add(requirement.id);
    if (!nonEmpty(requirement.title))
      errors.push(`${requirement.id} title is required`);
    for (const field of [
      "implementedBy",
      "lightTests",
      "heavyTests",
      "evaluatedBy",
    ]) {
      if (
        !Array.isArray(requirement[field]) ||
        requirement[field].length === 0
      ) {
        errors.push(`${requirement.id} ${field} must be a non-empty array`);
      }
    }
    for (const [field, refs] of [
      ["definedIn", [requirement.definedIn]],
      ["implementedBy", requirement.implementedBy],
      ["lightTests", requirement.lightTests],
      ["heavyTests", requirement.heavyTests],
    ]) {
      for (const reference of asArray(refs)) {
        if (!nonEmpty(reference)) {
          errors.push(`${requirement.id} ${field} contains an empty reference`);
          continue;
        }
        const [relative, fragment] = reference.split("#", 2);
        const absolute = path.join(repoRoot, relative);
        if (!(await exists(absolute))) {
          errors.push(
            `${requirement.id} ${field} reference does not exist: ${relative}`,
          );
        } else if (nonEmpty(fragment)) {
          const contents = await readFile(absolute, "utf8");
          const fragmentExists = relative.endsWith(".md")
            ? markdownDefinesFragment(contents, fragment)
            : contents.includes(fragment);
          if (!fragmentExists) {
            errors.push(
              `${requirement.id} ${field} reference has no matching fragment: ${reference}`,
            );
          }
        }
      }
    }
    for (const evaluationId of asArray(requirement.evaluatedBy)) {
      if (!allCaseIds.has(evaluationId)) {
        errors.push(
          `${requirement.id} evaluatedBy has unknown case: ${evaluationId}`,
        );
      } else if (
        !asArray(casesById.get(evaluationId)?.requirementIds).includes(
          requirement.id,
        )
      ) {
        errors.push(
          `${requirement.id} evaluatedBy case does not reference the requirement: ${evaluationId}`,
        );
      }
    }
  }

  for (const evaluationCase of asArray(model.cases)) {
    const id = evaluationCase?.id;
    if (!nonEmpty(id)) {
      errors.push("case id must be non-empty");
      continue;
    }
    if (caseIds.has(id)) errors.push(`duplicate case id: ${id}`);
    caseIds.add(id);
    if (!suiteIds.has(evaluationCase.suiteId)) {
      errors.push(`${id} has unknown suite: ${evaluationCase.suiteId}`);
    } else {
      usedSuiteIds.add(evaluationCase.suiteId);
    }
    for (const requirementId of asArray(evaluationCase.requirementIds)) {
      if (!requirementIds.has(requirementId))
        errors.push(`${id} has unknown requirement: ${requirementId}`);
      else {
        coveredRequirementIds.add(requirementId);
        if (
          !asArray(requirementsById.get(requirementId)?.evaluatedBy).includes(
            id,
          )
        ) {
          errors.push(
            `${id} references ${requirementId}, but the requirement does not link back`,
          );
        }
      }
    }
    const fixture = evaluationCase.fixture;
    if (!fixture || typeof fixture !== "object") {
      errors.push(`${id} fixture is required`);
      continue;
    }
    const input = evaluationCase.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      errors.push(`${id} input contract is required`);
    } else {
      for (const field of ["attemptedTools", "executedTools"]) {
        if (!Array.isArray(input[field])) {
          errors.push(`${id} input.${field} must be an array`);
        } else if (new Set(input[field]).size !== input[field].length) {
          errors.push(`${id} input.${field} contains duplicate tool traces`);
        }
      }
      if (evaluationCase.suiteId === "prompt-contract") {
        if (
          !Array.isArray(input.promptAssets) ||
          input.promptAssets.length === 0
        ) {
          errors.push(
            `${id} prompt-contract input.promptAssets must be non-empty`,
          );
        } else {
          for (const asset of input.promptAssets) {
            if (
              !nonEmpty(asset) ||
              !(await exists(path.join(repoRoot, asset)))
            ) {
              errors.push(`${id} prompt asset does not exist: ${asset}`);
            }
          }
        }
      } else if (!nonEmpty(input.prompt)) {
        errors.push(`${id} input.prompt is required`);
      }
    }
    for (const field of [
      "runId",
      "locale",
      "timeZone",
      "currentTime",
      "channel",
    ]) {
      if (!nonEmpty(fixture[field]))
        errors.push(`${id} fixture.${field} is required`);
    }
    if (nonEmpty(fixture.runId)) {
      const runOwner = runOwners.get(fixture.runId);
      if (runOwner)
        errors.push(
          `shared run ID ${fixture.runId} is used by ${runOwner} and ${id}`,
        );
      else runOwners.set(fixture.runId, id);
    }
    if (!validLocale(fixture.locale))
      errors.push(`${id} locale must be a valid BCP-47 locale`);
    if (!validTimeZone(fixture.timeZone))
      errors.push(`${id} timeZone must be a valid IANA time zone`);
    if (!validIsoTimestamp(fixture.currentTime))
      errors.push(`${id} currentTime must be a strict ISO timestamp`);
    if (!CHANNEL_VALUES.has(fixture.channel))
      errors.push(`${id} fixture.channel is invalid`);
    if (!Array.isArray(fixture.availableTools))
      errors.push(`${id} availableTools must be an array`);
    const declaredToolNames = asArray(fixture.availableTools).map(
      (tool) => tool?.name,
    );
    if (new Set(declaredToolNames).size !== declaredToolNames.length) {
      errors.push(`${id} availableTools contains duplicates`);
    }
    if (!Array.isArray(fixture.grantedPolicies))
      errors.push(`${id} grantedPolicies must be an array`);
    if (!fixture.state || typeof fixture.state !== "object") {
      errors.push(`${id} fixture.state is required`);
    } else {
      for (const stateName of [
        "conversationId",
        "workspaceId",
        "artifactRoot",
      ]) {
        if (!nonEmpty(fixture.state[stateName]))
          errors.push(`${id} state.${stateName} is required`);
      }
      for (const [stateName, stateValue] of Object.entries(fixture.state)) {
        if (!nonEmpty(stateValue))
          errors.push(`${id} state.${stateName} must be non-empty`);
        const owner = stateOwners.get(stateValue);
        if (owner)
          errors.push(
            `shared state ${stateValue} is used by ${owner} and ${id}`,
          );
        else stateOwners.set(stateValue, id);
        if (
          nonEmpty(fixture.runId) &&
          nonEmpty(stateValue) &&
          !stateValue.startsWith(`${fixture.runId}-`)
        ) {
          errors.push(`${id} state.${stateName} must be namespaced by runId`);
        }
      }
    }
    for (const teardownTarget of ["conversation", "workspace", "artifacts"]) {
      if (!asArray(fixture.teardown).includes(teardownTarget)) {
        errors.push(`${id} teardown must include ${teardownTarget}`);
      }
    }
    const expected = evaluationCase.expected;
    if (!expected || typeof expected !== "object") {
      errors.push(`${id} expected contract is required`);
      continue;
    }
    if (!["allowed", "blocked"].includes(expected.outcome))
      errors.push(`${id} expected.outcome is invalid`);
    if (expected.outcome === "allowed" && expected.blockedBy !== null) {
      errors.push(`${id} allowed cases must use blockedBy: null`);
    }
    if (expected.outcome === "blocked") {
      if (!Object.hasOwn(BLOCK_CONTRACTS, expected.blockedBy)) {
        errors.push(`${id} expected.blockedBy is invalid`);
      } else if (
        BLOCK_CONTRACTS[expected.blockedBy] !== expected.failureClass
      ) {
        errors.push(
          `${id} ${expected.blockedBy} must use failureClass: ${BLOCK_CONTRACTS[expected.blockedBy]}`,
        );
      }
    }
    if (
      expected.failureClass !== null &&
      !failureClasses.includes(expected.failureClass)
    ) {
      errors.push(`${id} has unknown failure class: ${expected.failureClass}`);
    }
    if (expected.failureClass !== null)
      usedFailureClasses.add(expected.failureClass);
    if (!FRESHNESS_VALUES.has(expected.freshness)) {
      errors.push(`${id} expected.freshness is invalid`);
    }
    for (const field of [
      "requiredTools",
      "forbiddenTools",
      "requiredPolicies",
      "requiredEvidence",
      "outputValidators",
    ]) {
      if (!Array.isArray(expected[field]))
        errors.push(`${id} expected.${field} must be an array`);
    }
    const requiredTools = asArray(expected.requiredTools);
    const forbiddenTools = new Set(asArray(expected.forbiddenTools));
    for (const toolName of requiredTools) {
      if (forbiddenTools.has(toolName)) {
        errors.push(
          `${id} tool cannot be both required and forbidden: ${toolName}`,
        );
      }
    }
    for (const validatorId of asArray(expected.outputValidators)) {
      if (!OUTPUT_VALIDATOR_IDS.has(validatorId)) {
        errors.push(`${id} has unknown output validator: ${validatorId}`);
      }
    }
  }

  for (const requirementId of requirementIds) {
    if (!coveredRequirementIds.has(requirementId))
      errors.push(`requirement is not covered: ${requirementId}`);
  }
  for (const failureClass of requiredFailureClasses) {
    if (!usedFailureClasses.has(failureClass))
      errors.push(`failure class has no negative case: ${failureClass}`);
  }
  for (const suiteId of suiteIds) {
    if (!usedSuiteIds.has(suiteId))
      errors.push(`light suite has no fixture contract: ${suiteId}`);
  }
  const heavyIds = new Set();
  for (const heavy of asArray(model.heavyEvaluations)) {
    if (
      !nonEmpty(heavy?.id) ||
      !nonEmpty(heavy?.command) ||
      !nonEmpty(heavy?.reason)
    ) {
      errors.push("heavy evaluation requires id, command, and reason");
    }
    if (!suiteIds.has(heavy?.suiteId))
      errors.push(`${heavy?.id ?? "heavy"} has unknown suite`);
    if (heavyIds.has(heavy?.id))
      errors.push(`duplicate heavy evaluation id: ${heavy.id}`);
    heavyIds.add(heavy?.id);
    const nodeScript = /\bnode\s+(scripts\/[^\s]+)/.exec(
      heavy?.command ?? "",
    )?.[1];
    if (nodeScript && !(await exists(path.join(repoRoot, nodeScript)))) {
      errors.push(`${heavy.id} command runner does not exist: ${nodeScript}`);
    }
  }
  if (!Array.isArray(model.blockedEvaluations)) {
    errors.push("blockedEvaluations must be an array");
  }
  for (const blocked of asArray(model.blockedEvaluations)) {
    if (
      !nonEmpty(blocked?.id) ||
      !nonEmpty(blocked?.reason) ||
      !nonEmpty(blocked?.requiredAction)
    ) {
      errors.push("blocked evaluation requires id, reason, and requiredAction");
    }
    if (!suiteIds.has(blocked?.suiteId)) {
      errors.push(`${blocked?.id ?? "blocked"} has unknown suite`);
    }
    if (heavyIds.has(blocked?.id)) {
      errors.push(`duplicate evaluation id: ${blocked.id}`);
    }
    heavyIds.add(blocked?.id);
  }

  return {
    errors,
    coveredRequirementIds: [...coveredRequirementIds].sort(),
    failureClasses,
  };
}

function finding(code, message) {
  return { code, message };
}

export function evaluateFixtureContracts(model) {
  const manifestTools = new Map(
    asArray(model.toolManifest?.tools).map((tool) => [tool.name, tool]),
  );
  const results = asArray(model.cases).map((evaluationCase) => {
    const findings = [];
    const availableTools = new Map(
      asArray(evaluationCase.fixture?.availableTools).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const attemptedToolNames = asArray(evaluationCase.input?.attemptedTools);
    const executedToolNames = asArray(evaluationCase.input?.executedTools);
    const declaredTraceTools = new Set([
      ...asArray(evaluationCase.expected?.requiredTools),
      ...asArray(evaluationCase.expected?.forbiddenTools),
    ]);
    const attemptedManifestTools = attemptedToolNames
      .map((name) => manifestTools.get(name))
      .filter(Boolean);
    for (const [traceName, toolNames] of [
      ["attempted", attemptedToolNames],
      ["executed", executedToolNames],
    ]) {
      if (new Set(toolNames).size !== toolNames.length) {
        findings.push(
          finding(
            "duplicate-tool-trace",
            `${traceName} tool trace contains a duplicate dispatch`,
          ),
        );
      }
    }
    for (const [name, declared] of availableTools) {
      if (!manifestTools.has(name))
        findings.push(
          finding(
            "unknown-tool-schema",
            `${name} is not in agent-tool-manifest.json`,
          ),
        );
      if (declared.schemaRef !== `agent-tool-manifest.json#tool:${name}`) {
        findings.push(
          finding(
            "invalid-tool-schema-ref",
            `${name} schemaRef is not canonical`,
          ),
        );
      }
    }
    for (const name of attemptedToolNames) {
      if (!declaredTraceTools.has(name)) {
        findings.push(
          finding(
            "undeclared-tool-attempt",
            `${name} was attempted but is neither required nor forbidden`,
          ),
        );
      }
    }
    for (const name of executedToolNames) {
      if (!attemptedToolNames.includes(name)) {
        findings.push(
          finding(
            "unattempted-tool-execution",
            `${name} was executed without an attempted trace`,
          ),
        );
      }
      if (!manifestTools.has(name) || !availableTools.has(name)) {
        findings.push(
          finding(
            "unavailable-tool-execution",
            `${name} was executed without a canonical available schema`,
          ),
        );
      }
      if (asArray(evaluationCase.expected?.forbiddenTools).includes(name)) {
        findings.push(
          finding(
            "forbidden-tool-execution",
            `${name} was executed despite the expected safety boundary`,
          ),
        );
      }
    }
    for (const name of asArray(evaluationCase.expected?.requiredTools)) {
      const tool = manifestTools.get(name);
      if (!tool || !availableTools.has(name)) {
        findings.push(
          finding("missing-tool-schema", `${name} is required but unavailable`),
        );
        continue;
      }
      if (!tool.allowedChannels.includes(evaluationCase.fixture.channel)) {
        findings.push(
          finding(
            "channel-not-allowed",
            `${name} is unavailable on ${evaluationCase.fixture.channel}`,
          ),
        );
      }
      if (
        tool.requiredPolicy &&
        !asArray(evaluationCase.expected.requiredPolicies).includes(
          tool.requiredPolicy,
        )
      ) {
        findings.push(
          finding(
            "missing-required-policy-declaration",
            `${name} must declare ${tool.requiredPolicy}`,
          ),
        );
      }
      if (
        evaluationCase.expected.outcome === "allowed" &&
        tool.requiredPolicy &&
        !asArray(evaluationCase.fixture.grantedPolicies).includes(
          tool.requiredPolicy,
        )
      ) {
        findings.push(
          finding("missing-policy", `${name} requires ${tool.requiredPolicy}`),
        );
      }
      if (
        evaluationCase.expected.outcome === "allowed" &&
        tool.requiresUserConfirmation &&
        evaluationCase.expected.authorization !== "granted"
      ) {
        findings.push(
          finding("missing-confirmation", `${name} requires confirmation`),
        );
      }
      if (!attemptedToolNames.includes(name)) {
        findings.push(
          finding(
            "required-tool-not-attempted",
            `${name} is required but absent from the expected trace`,
          ),
        );
      }
      if (
        evaluationCase.expected.outcome === "allowed" &&
        !executedToolNames.includes(name)
      ) {
        findings.push(
          finding(
            "required-tool-not-executed",
            `${name} is required by an allowed case but absent from the execution trace`,
          ),
        );
      }
    }
    if (
      evaluationCase.expected?.outcome === "allowed" &&
      evaluationCase.expected.failureClass !== null
    ) {
      findings.push(
        finding(
          "unexpected-failure-class",
          "allowed cases must use failureClass: null",
        ),
      );
    }
    if (evaluationCase.expected?.outcome === "blocked") {
      const blockedBy = evaluationCase.expected.blockedBy;
      if (
        [
          "route-disabled",
          "policy-missing",
          "confirmation-missing",
          "consent-missing",
          "unknown-tool",
          "channel-denied",
          "output-invalid",
        ].includes(blockedBy) &&
        executedToolNames.length > 0
      ) {
        findings.push(
          finding(
            "tool-executed-after-block",
            `${blockedBy} must stop before a tool execution is recorded`,
          ),
        );
      }
      const blockedByMatches = {
        "route-disabled": evaluationCase.input?.routeAvailable === false,
        "policy-missing": attemptedManifestTools.some(
          (tool) =>
            tool.requiredPolicy &&
            !asArray(evaluationCase.fixture?.grantedPolicies).includes(
              tool.requiredPolicy,
            ),
        ),
        "confirmation-missing": attemptedManifestTools.some(
          (tool) =>
            tool.requiresUserConfirmation &&
            evaluationCase.expected.authorization !== "granted",
        ),
        "consent-missing":
          evaluationCase.input?.consent === "missing" &&
          evaluationCase.input?.providerCalls === 0,
        "unknown-tool": attemptedToolNames.some(
          (name) => !manifestTools.has(name),
        ),
        "channel-denied": attemptedManifestTools.some(
          (tool) =>
            !asArray(tool.allowedChannels).includes(
              evaluationCase.fixture?.channel,
            ),
        ),
        "stale-evidence": evaluationCase.input?.evidenceFresh === false,
        "output-invalid": evaluationCase.input?.outputValid === false,
      }[blockedBy];
      if (!blockedByMatches) {
        findings.push(
          finding(
            "unproven-block-condition",
            `${blockedBy} is not supported by the fixture input and canonical tool manifest`,
          ),
        );
      }
      if (
        blockedBy === "consent-missing" &&
        evaluationCase.input?.providerCalls !== 0
      ) {
        findings.push(
          finding(
            "provider-called-before-consent",
            "consent-missing must record exactly zero provider calls",
          ),
        );
      }
    }
    if (
      evaluationCase.expected?.outcome === "blocked" &&
      evaluationCase.expected.failureClass === null
    ) {
      findings.push(
        finding(
          "missing-failure-class",
          "blocked cases require a failure class",
        ),
      );
    }
    if (evaluationCase.expected?.freshness === "volatile") {
      for (const evidence of ["live-verification", "citation"]) {
        if (
          !asArray(evaluationCase.expected.requiredEvidence).includes(evidence)
        ) {
          findings.push(
            finding(
              "missing-freshness-evidence",
              `volatile case requires ${evidence}`,
            ),
          );
        }
      }
    }
    if (asArray(evaluationCase.expected?.outputValidators).length === 0) {
      findings.push(
        finding(
          "missing-output-validator",
          "at least one output validator is required",
        ),
      );
    }
    return {
      id: evaluationCase.id,
      status: findings.length === 0 ? "passed" : "failed",
      findings,
    };
  });
  return {
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}

export function buildHeavyEvaluationReport(model) {
  return asArray(model.heavyEvaluations).map((entry) => ({
    ...entry,
    status: "deferred",
  }));
}

function buildBlockedEvaluationReport(model) {
  return asArray(model.blockedEvaluations).map((entry) => ({
    ...entry,
    status: "blocked",
  }));
}

async function main() {
  const model = await loadQualityModel();
  const validation = await validateQualityModel(model);
  const fixtureContracts = evaluateFixtureContracts(model);
  const heavy = buildHeavyEvaluationReport(model);
  const blocked = buildBlockedEvaluationReport(model);
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    validation,
    fixtureContracts: {
      ...fixtureContracts,
      scope:
        "Metadata, traceability, isolation declarations, and canonical tool-policy contracts only; this does not execute model behavior or teardown.",
    },
    lightSuites: {
      status: "not-run",
      suiteIds: model.lightSuites,
      command: "pnpm eval:impact -- --run",
    },
    heavy,
    blocked,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (validation.errors.length > 0 || fixtureContracts.failed > 0)
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
