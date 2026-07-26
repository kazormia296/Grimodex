import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const FIXTURE_DEFINITIONS = Object.freeze({
  "codex-recall-ja.jsonl": {
    kind: "recall",
    seed: "src-tauri/resources/sample_project/v1.json",
  },
  "codex-recall-en.jsonl": {
    kind: "recall",
    seed: "src-tauri/resources/sample_project/v1_en.json",
  },
  "ja-calibration.jsonl": { kind: "calibration" },
  "en-calibration.jsonl": { kind: "calibration" },
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function parseJsonLines(source, sourceFile, { allowComments }) {
  const records = [];
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    if (allowComments && line.startsWith("//")) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("record must be a JSON object");
      }
      records.push(parsed);
    } catch (error) {
      throw new Error(
        `${sourceFile}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return records;
}

function assertUniqueQueries(records, sourceFile) {
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.query)) {
      throw new Error(`${sourceFile}: duplicate query: ${record.query}`);
    }
    seen.add(record.query);
  }
}

function resolveTarget(target, names) {
  const exact = names.filter((name) => name === target);
  return exact.length === 1 ? exact[0] : null;
}

function targetTokens(target) {
  const stopwords = new Set(["the", "and"]);
  const tokens = new Set();
  for (const rawToken of target.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ??
    []) {
    const characters = [...rawToken];
    if (characters.length < 3 || stopwords.has(rawToken)) continue;
    if (/^[a-z0-9]+$/i.test(rawToken)) {
      tokens.add(rawToken);
      continue;
    }
    for (let index = 0; index + 3 <= characters.length; index += 1) {
      tokens.add(characters.slice(index, index + 3).join(""));
    }
  }
  return [...tokens];
}

async function validateRecallFixture(repoRoot, sourceFile, records, seed) {
  assertUniqueQueries(records, sourceFile);
  const seedData = JSON.parse(
    await readFile(path.join(repoRoot, seed), "utf8"),
  );
  const names = Array.isArray(seedData.codex_entries)
    ? seedData.codex_entries.map((entry) => entry?.name).filter(nonEmpty)
    : [];
  if (names.length === 0) throw new Error(`${seed}: no codex entry names`);
  if (records.length < names.length * 2) {
    throw new Error(
      `${sourceFile}: recall corpus must cover every seed entry in both categories`,
    );
  }
  for (const [index, record] of records.entries()) {
    if (!nonEmpty(record.query) || !nonEmpty(record.target)) {
      throw new Error(
        `${sourceFile}:${index + 1}: recall cases require query and target`,
      );
    }
    if (!["control-name", "descriptive-hard"].includes(record.kind)) {
      throw new Error(`${sourceFile}:${index + 1}: invalid kind`);
    }
    const resolvedTarget = resolveTarget(record.target, names);
    if (!resolvedTarget) {
      throw new Error(
        `${sourceFile}:${index + 1}: unresolved or ambiguous target: ${record.target}`,
      );
    }
    const query = record.query.toLocaleLowerCase();
    const containsNameToken = targetTokens(resolvedTarget).some((token) =>
      query.includes(token),
    );
    if (record.kind === "control-name" && !containsNameToken) {
      throw new Error(
        `${sourceFile}:${index + 1}: control-name query must contain a target name token`,
      );
    }
    if (record.kind === "descriptive-hard" && containsNameToken) {
      throw new Error(
        `${sourceFile}:${index + 1}: descriptive-hard query must not contain a target name token`,
      );
    }
  }
  for (const name of names) {
    for (const kind of ["control-name", "descriptive-hard"]) {
      if (
        !records.some(
          (record) =>
            record.kind === kind &&
            resolveTarget(record.target, names) === name,
        )
      ) {
        throw new Error(`${sourceFile}: ${name} has no ${kind} case`);
      }
    }
  }
}

function validateCalibrationFixture(sourceFile, records) {
  if (records.length < 4) {
    throw new Error(`${sourceFile}: calibration requires at least four pairs`);
  }
  assertUniqueQueries(records, sourceFile);
  const documents = records.map((record) => record.doc);
  if (new Set(documents).size !== documents.length) {
    throw new Error(`${sourceFile}: calibration documents must be unique`);
  }
  for (const [index, record] of records.entries()) {
    if (!nonEmpty(record.query) || !nonEmpty(record.doc)) {
      throw new Error(
        `${sourceFile}:${index + 1}: calibration pairs require query and doc`,
      );
    }
  }
}

export async function validateRetrievalFixtures({
  repoRoot = DEFAULT_REPO_ROOT,
} = {}) {
  const directory = path.join(repoRoot, "scripts/fixtures");
  const actualFiles = (await readdir(directory))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  const expectedFiles = Object.keys(FIXTURE_DEFINITIONS).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `scripts/fixtures JSONL inventory changed; update the validator: ${actualFiles.join(", ")}`,
    );
  }

  const results = [];
  for (const sourceFile of actualFiles) {
    const definition = FIXTURE_DEFINITIONS[sourceFile];
    const records = parseJsonLines(
      await readFile(path.join(directory, sourceFile), "utf8"),
      `scripts/fixtures/${sourceFile}`,
      { allowComments: definition.kind === "recall" },
    );
    if (definition.kind === "recall") {
      await validateRecallFixture(
        repoRoot,
        `scripts/fixtures/${sourceFile}`,
        records,
        definition.seed,
      );
    } else {
      validateCalibrationFixture(`scripts/fixtures/${sourceFile}`, records);
    }
    results.push({ sourceFile, kind: definition.kind, cases: records.length });
  }
  return results;
}

async function main() {
  const results = await validateRetrievalFixtures();
  process.stdout.write(
    `${JSON.stringify({ status: "passed", fixtures: results }, null, 2)}\n`,
  );
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
