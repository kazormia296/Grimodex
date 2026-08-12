#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CHECKLIST_RELATIVE = "policies/narrative/gate-b2-adr-checklist.json";
const CLASSIFICATION_RELATIVE =
  "policies/narrative/gate-b2-classification.json";
const VALID_STATUSES = new Set(["PASS", "FAIL", "OUT-OF-SCOPE"]);
const VALID_SECTIONS = new Set([
  "cross-cutting",
  "chronicle",
  "codex",
  "phase",
  "temporal",
  "plot",
  "foreshadow",
  "import-maintenance",
]);
const VALID_CLASSIFICATIONS = new Set([
  "invariant",
  "strategy",
  "signal",
  "mixed",
]);
const REQUIRED_DOMAINS = [
  "chronicle",
  "codex",
  "phase",
  "temporal",
  "plot",
  "foreshadow",
];
const REQUIRED_DOMAIN_CLASSIFICATIONS = ["invariant", "strategy", "signal"];
const VALID_MODES = new Set(["validate-format", "require-certifiable"]);
const CERTIFIABLE_OUT_OF_SCOPE_IDS = new Set(["B2-X07", "B2-IM-S"]);
export const REQUIRED_CHECKLIST_IDS = [
  "B2-X01",
  "B2-X02",
  "B2-X03",
  "B2-X04",
  "B2-X05",
  "B2-X06",
  "B2-X07",
  "B2-X08",
  "B2-CH-I",
  "B2-CH-S",
  "B2-CH-G",
  "B2-CX-I",
  "B2-CX-S",
  "B2-CX-G",
  "B2-PH-I",
  "B2-PH-S",
  "B2-PH-G",
  "B2-TM-I",
  "B2-TM-S",
  "B2-TM-G",
  "B2-PL-I",
  "B2-PL-S",
  "B2-PL-G",
  "B2-FS-I",
  "B2-FS-S",
  "B2-FS-G",
  "B2-IM-I",
  "B2-IM-C",
  "B2-IM-R",
  "B2-IM-P",
  "B2-IM-F",
  "B2-IM-S",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function loadJson(repoRoot, relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
}

async function validateChecklist(checklist, repoRoot, mode) {
  const errors = [];
  if (!isRecord(checklist)) return ["checklist must be an object"];
  if (checklist.schemaVersion !== 1) {
    errors.push("checklist schemaVersion must be 1");
  }
  if (checklist.gateId !== "gate-b2") {
    errors.push("checklist gateId must be gate-b2");
  }
  if (!Array.isArray(checklist.items)) {
    return [...errors, "checklist items must be an array"];
  }

  const ids = new Set();
  for (const [index, item] of checklist.items.entries()) {
    const id =
      isRecord(item) && isNonEmptyString(item.id) ? item.id : `item[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${id}: item must be an object`);
      continue;
    }
    if (!isNonEmptyString(item.id)) {
      errors.push(`${id}: missing id`);
    } else if (ids.has(item.id)) {
      errors.push(`${id}: duplicate id`);
    } else {
      ids.add(item.id);
    }
    if (!isNonEmptyString(item.section)) {
      errors.push(`${id}: missing section`);
    } else if (!VALID_SECTIONS.has(item.section)) {
      errors.push(`${id}: invalid section '${item.section}'`);
    }
    if (!isNonEmptyString(item.text)) {
      errors.push(`${id}: missing text`);
    }
    if (!Object.hasOwn(item, "status")) {
      errors.push(`${id}: missing status`);
    } else if (!VALID_STATUSES.has(item.status)) {
      errors.push(`${id}: invalid status '${String(item.status)}'`);
    }

    if (
      (item.status === "FAIL" || item.status === "OUT-OF-SCOPE") &&
      !isNonEmptyString(item.reason)
    ) {
      errors.push(`${id}: ${item.status} requires reason`);
    }
    if (item.status === "OUT-OF-SCOPE" && !isNonEmptyString(item.deferredTo)) {
      errors.push(`${id}: OUT-OF-SCOPE requires deferredTo`);
    }
    if (mode === "require-certifiable" && item.status === "FAIL") {
      errors.push(`${id}: FAIL is not certifiable`);
    }
    if (
      mode === "require-certifiable" &&
      item.status === "OUT-OF-SCOPE" &&
      !CERTIFIABLE_OUT_OF_SCOPE_IDS.has(item.id)
    ) {
      errors.push(`${id}: OUT-OF-SCOPE is not allowlisted for certification`);
    }

    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    if (item.status === "PASS" && evidence.length === 0) {
      errors.push(`${id}: PASS requires evidence`);
    }
    if (item.status === "PASS") {
      for (const entry of evidence) {
        if (!isRecord(entry) || !isNonEmptyString(entry.path)) {
          errors.push(`${id}: PASS evidence requires path`);
          continue;
        }
        if (!(await pathExists(path.resolve(repoRoot, entry.path)))) {
          errors.push(`${id}: evidence path does not exist: ${entry.path}`);
        }
      }
    }
  }
  const requiredIds = new Set(REQUIRED_CHECKLIST_IDS);
  for (const requiredId of REQUIRED_CHECKLIST_IDS) {
    if (!ids.has(requiredId)) {
      errors.push(`checklist missing item: ${requiredId}`);
    }
  }
  for (const id of ids) {
    if (!requiredIds.has(id)) {
      errors.push(`checklist has unknown item: ${id}`);
    }
  }
  return errors;
}

async function validateClassification(classification, repoRoot, mode) {
  const errors = [];
  if (!isRecord(classification)) {
    return ["classification must be an object"];
  }
  if (classification.schemaVersion !== 1) {
    errors.push("classification schemaVersion must be 1");
  }
  if (classification.gateId !== "gate-b2") {
    errors.push("classification gateId must be gate-b2");
  }
  if (!Array.isArray(classification.entries)) {
    return [...errors, "classification entries must be an array"];
  }
  if (classification.entries.length === 0) {
    errors.push("classification entries must not be empty");
  }

  const ids = new Set();
  for (const [index, entry] of classification.entries.entries()) {
    const id =
      isRecord(entry) && isNonEmptyString(entry.id)
        ? entry.id
        : `entry[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${id}: classification entry must be an object`);
      continue;
    }
    if (!isNonEmptyString(entry.id)) {
      errors.push(`${id}: missing id`);
    } else if (ids.has(entry.id)) {
      errors.push(`${id}: duplicate id`);
    } else {
      ids.add(entry.id);
    }
    if (!REQUIRED_DOMAINS.includes(entry.domain)) {
      errors.push(`${id}: invalid domain '${String(entry.domain)}'`);
    }
    if (!VALID_CLASSIFICATIONS.has(entry.classification)) {
      errors.push(
        `${id}: invalid classification '${String(entry.classification)}'`,
      );
    }
    if (
      mode === "require-certifiable" &&
      typeof entry.classification === "string" &&
      entry.classification.toLocaleLowerCase("und") === "mixed"
    ) {
      errors.push(`${id}: mixed classification is not certifiable`);
    }
    if (!isNonEmptyString(entry.implementation)) {
      errors.push(`${id}: missing implementation`);
    } else if (
      !(await pathExists(path.resolve(repoRoot, entry.implementation)))
    ) {
      errors.push(
        `${id}: implementation path does not exist: ${entry.implementation}`,
      );
    }
    if (!isNonEmptyString(entry.symbol)) {
      errors.push(`${id}: missing symbol`);
    }
    if (!Array.isArray(entry.tests)) {
      errors.push(`${id}: tests must be an array`);
    } else {
      for (const testPath of entry.tests) {
        if (!isNonEmptyString(testPath)) {
          errors.push(`${id}: invalid test path`);
        } else if (!(await pathExists(path.resolve(repoRoot, testPath)))) {
          errors.push(`${id}: test path does not exist: ${testPath}`);
        }
      }
    }
  }

  for (const domain of REQUIRED_DOMAINS) {
    const domainEntries = classification.entries.filter(
      (entry) => isRecord(entry) && entry.domain === domain,
    );
    if (domainEntries.length === 0) {
      errors.push(`classification missing domain: ${domain}`);
      continue;
    }
    for (const required of REQUIRED_DOMAIN_CLASSIFICATIONS) {
      if (!domainEntries.some((entry) => entry.classification === required)) {
        errors.push(`classification missing ${domain} ${required}`);
      }
    }
  }
  return errors;
}

export async function validateGateB2Adr({
  repoRoot = DEFAULT_REPO_ROOT,
  checklistPath = CHECKLIST_RELATIVE,
  classificationPath = CLASSIFICATION_RELATIVE,
  mode = "validate-format",
} = {}) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unsupported Gate B2 ADR validation mode: ${mode}`);
  }
  const [checklist, classification] = await Promise.all([
    loadJson(repoRoot, checklistPath),
    loadJson(repoRoot, classificationPath),
  ]);
  return [
    ...(await validateChecklist(checklist, repoRoot, mode)),
    ...(await validateClassification(classification, repoRoot, mode)),
  ];
}

export function parseValidationMode(argv) {
  const args = argv.filter((argument) => argument !== "--");
  if (args.length === 0) return "validate-format";
  if (args.length === 1 && args[0] === "--validate-format") {
    return "validate-format";
  }
  if (args.length === 1 && args[0] === "--require-certifiable") {
    return "require-certifiable";
  }
  throw new Error(
    "Usage: validate-gate-b2-adr.mjs [--validate-format|--require-certifiable]",
  );
}

async function main() {
  const mode = parseValidationMode(process.argv.slice(2));
  const errors = await validateGateB2Adr({ mode });
  if (errors.length > 0) {
    process.stderr.write(
      `Gate B2 ADR ${mode} failed:\n- ${errors.join("\n- ")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    mode === "require-certifiable"
      ? "Gate B2 ADR checklist and classification are certifiable.\n"
      : "Gate B2 ADR checklist and classification format is valid.\n",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
