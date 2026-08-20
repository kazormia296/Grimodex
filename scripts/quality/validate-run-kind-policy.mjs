#!/usr/bin/env node
/**
 * Validate the Gate C2 Run Kind Policy contract
 * (`policies/narrative/narrative-run-kind-policy.json`).
 *
 * This is the Lane K/N design decision ratified after C2-T1: which of
 * Legacy Backfill, Dependency Verify, Rebuild Derived State, Incremental
 * Freshness, and Repair Durable Declarations run automatically versus require
 * a human trigger, and what each is and is not allowed to write. This
 * validator checks the contract is internally consistent, matches its JSON
 * Schema, and that
 * every `existingRunKindColumnValue` it claims actually appears in the
 * real `narrative_extraction_runs.run_kind` CHECK constraint in
 * `migrate.rs` — so this policy document cannot silently drift from the
 * SQL it describes.
 *
 * It also cross-checks each Run Kind's `implementationStatus` against the
 * real Rust call graph, in both directions: a Run Kind that declares an
 * automatic trigger as `wired` must have a production caller for its
 * `triggerSymbol`, and one that declares `unwired-blocked` must have none.
 * Incremental Freshness additionally proves that Electron main creates and
 * starts its scheduler, while its main-only N-API method remains outside both
 * renderer command allowlists.
 * That check exists because this contract previously declared
 * `dependency-backfill` as `automatic-once-after-schema-upgrade` while the
 * post-open trigger had been removed from the runtime, and the validator
 * passed anyway. A machine-readable contract describing a future state as
 * if it were live is worse than no contract, so the drift now fails the
 * gate whichever side moves.
 *
 * It still does not assert that the named API operations behave correctly,
 * only that the trigger wiring the contract claims matches reality.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import ts from "typescript";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const MIGRATE_RS_PATH = "src-tauri/crates/grimodex-db/src/migrate.rs";
const ELECTRON_MAIN_INDEX_PATH = "electron/main/index.ts";
const IPC_CONTRACT_PATH = "electron/shared/ipcContract.ts";
const FAILURE_POLICY_PATH = "policies/narrative/narrative-failure-policy.json";
const INCREMENTAL_FRESHNESS_RUNTIME_PATH =
  "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs";
const NARRATIVE_EXTRACTION_MOD_PATH =
  "src-tauri/crates/grimodex-db/src/narrative_extraction/mod.rs";
const RUN_KIND_CHECK_PATTERN = /CHECK\(run_kind IN \(([^)]*)\)\)/g;

// Rust sources scanned for automatic trigger call sites.
const RUST_SOURCE_ROOTS = [
  "src-tauri/crates",
  "electron/native/grimodex-node/src",
];

// Most calls from the N-API boundary are the manual Admin IPC surface and must
// not count as an automatic trigger. A main-process-only automatic entrypoint
// can opt in only when its exact Rust method is both declared in
// implementationStatus.productionEntryPoints and listed in the validator-owned
// main-only allowlist below. Renderer-facing Admin methods remain excluded even
// if a policy edit starts naming their snake_case Rust implementation.
const MANUAL_IPC_FILE = "electron/native/grimodex-node/src/lib.rs";
const MAIN_ONLY_NAPI_PRODUCTION_ENTRY_POINTS = new Set([
  "run_narrative_freshness_cycle",
]);

const REQUIRED_RUN_KINDS = [
  "dependency-backfill",
  "dependency-verify",
  "dependency-rebuild-derived",
  "incremental-freshness",
  "dependency-repair",
];

const INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID =
  "narrative-incremental-freshness/v1";
const INCREMENTAL_FRESHNESS_BATCH_SIZE = 32;
const INCREMENTAL_FRESHNESS_TASK_KIND = "incremental-freshness-batch";
const INCREMENTAL_FRESHNESS_FAILURE_CODES = new Map([
  ["NEX_INCREMENTAL_FRESHNESS_RETRYABLE", "retryable"],
  ["NEX_INCREMENTAL_FRESHNESS_INTERRUPTED", "retryable"],
  ["NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED", "terminal"],
]);
const MAIN_ONLY_FRESHNESS_METHOD_NAMES = new Set([
  "run_narrative_freshness_cycle",
  "runNarrativeFreshnessCycle",
]);
const INCREMENTAL_FRESHNESS_WRITES_ALLOWED = [
  "run-task-attempt-state",
  "narrative-change-set",
  "freshness-evaluator-cursor",
  "dependency-edge-state",
  "consumer-freshness",
  "finding-observation",
];
const INCREMENTAL_FRESHNESS_RESUME_SEMANTICS = [
  "reuse-sealed-change-set",
  "reclaim-expired-cursor-reservation",
  "resume-running-run-task-attempt",
];
const INCREMENTAL_FRESHNESS_COMPLETED_UNACKED_INVARIANT =
  "never-reuse-completed-run-and-reprocess-under-new-runtime-owned-run";
const INCREMENTAL_FRESHNESS_RETRY_POLICY = {
  maxAttemptsPerTask: 3,
  exhaustedFailureCode: "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED",
  exhaustedRetryDisposition: "terminal",
  failurePolicyVersion: "v1",
  taskAndRunStatusAfterExhaustion: "failed",
  cursorAfterExhaustion: "reserved-lease-free",
  schedulerAfterExhaustion: "idle-until-new-semantic-epoch",
  newEpochReservationRecovery: "release-and-reprocess-under-new-run",
  exhaustedRunAfterNewEpoch: "remains-terminal-failed",
};

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function readJson(repoRoot, relativePath, errors, label) {
  const absolute = path.join(repoRoot, relativePath);
  if (!existsSync(absolute)) {
    errors.push(`${label} is missing: ${relativePath}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    errors.push(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function readSource(repoRoot, relativePath, errors, label) {
  const absolute = path.join(repoRoot, relativePath);
  if (!existsSync(absolute)) {
    errors.push(`${label} is missing: ${relativePath}`);
    return null;
  }
  return readFileSync(absolute, "utf8");
}

function stripJavaScriptComments(source, { stripStrings = false } = {}) {
  let output = "";
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (quote !== null) {
      if (current === "\\") {
        output += stripStrings ? " " : current;
        if (next !== undefined) {
          output += stripStrings ? (next === "\n" ? "\n" : " ") : next;
          index += 1;
        }
      } else {
        output += stripStrings ? (current === "\n" ? "\n" : " ") : current;
        if (current === quote) quote = null;
      }
      continue;
    }

    if (current === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      if (index < source.length) output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) {
        output += "  ";
        index += 1;
      }
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      output += stripStrings ? " " : current;
      continue;
    }
    output += current;
  }
  return output;
}

function collectRustFiles(repoRoot) {
  const files = [];
  const walk = (absolute) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        // Build output and non-production Rust targets cannot wire a shipping
        // trigger. Integration tests are compiled as standalone binaries, so
        // treating a call there as production would let a test for an unwired
        // symbol satisfy the very gate that is meant to detect the omission.
        if (
          ["target", "node_modules", "tests", "benches", "examples"].includes(
            entry.name,
          )
        ) {
          continue;
        }
        walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".rs")) {
        files.push(child);
      }
    }
  };
  for (const root of RUST_SOURCE_ROOTS) {
    const absolute = path.join(repoRoot, root);
    if (existsSync(absolute) && statSync(absolute).isDirectory())
      walk(absolute);
  }
  return files;
}

function maskSourceRange(output, source, start, end) {
  for (let index = start; index < end; index += 1) {
    output[index] = source[index] === "\n" ? "\n" : " ";
  }
}

/**
 * A deliberately small Rust lexer for the two facts this validator needs:
 * executable tokens and literal values. It understands nested block comments,
 * escaped normal/byte/C strings, chars, and arbitrary-hash raw strings. The
 * returned `code` is position preserving, so diagnostics still name the real
 * source line while comments and literals cannot forge a call or brace.
 */
function scanRustSource(source) {
  const output = source.split("");
  const stringLiterals = [];
  const isIdentifier = (value) => /[a-zA-Z0-9_]/u.test(value ?? "");

  const rawStringAt = (index) => {
    for (const prefix of ["br", "cr", "r"]) {
      if (!source.startsWith(prefix, index)) continue;
      if (isIdentifier(source[index - 1])) continue;
      let cursor = index + prefix.length;
      let hashes = 0;
      while (source[cursor] === "#") {
        hashes += 1;
        cursor += 1;
      }
      if (source[cursor] !== '"') continue;
      const terminator = `"${"#".repeat(hashes)}`;
      const contentStart = cursor + 1;
      const close = source.indexOf(terminator, contentStart);
      const end = close < 0 ? source.length : close + terminator.length;
      return {
        start: index,
        contentStart,
        contentEnd: close < 0 ? source.length : close,
        end,
      };
    }
    return null;
  };

  const quotedLiteralAt = (index) => {
    let start = index;
    let quoteIndex = index;
    if (
      (source[index] === "b" || source[index] === "c") &&
      source[index + 1] === '"' &&
      !isIdentifier(source[index - 1])
    ) {
      quoteIndex += 1;
    } else if (source[index] !== '"') {
      return null;
    }
    let cursor = quoteIndex + 1;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor] === '"') {
        return {
          start,
          contentStart: quoteIndex + 1,
          contentEnd: cursor,
          end: cursor + 1,
        };
      }
      cursor += 1;
    }
    return {
      start,
      contentStart: quoteIndex + 1,
      contentEnd: source.length,
      end: source.length,
    };
  };

  const charLiteralEnd = (index) => {
    let quoteIndex = index;
    if (
      source[index] === "b" &&
      source[index + 1] === "'" &&
      !isIdentifier(source[index - 1])
    ) {
      quoteIndex += 1;
    } else if (source[index] !== "'") {
      return null;
    }
    let cursor = quoteIndex + 1;
    if (source[cursor] === "\\") {
      cursor += 1;
      if (source[cursor] === "u" && source[cursor + 1] === "{") {
        const closeBrace = source.indexOf("}", cursor + 2);
        if (closeBrace < 0) return null;
        cursor = closeBrace + 1;
      } else if (source[cursor] === "x") {
        cursor += 3;
      } else {
        cursor += 1;
      }
    } else {
      const codePoint = source.codePointAt(cursor);
      if (codePoint === undefined || source[cursor] === "\n") return null;
      cursor += codePoint > 0xffff ? 2 : 1;
    }
    // A lifetime such as `'a` does not close immediately after one scalar.
    return source[cursor] === "'" ? cursor + 1 : null;
  };

  for (let index = 0; index < source.length; ) {
    if (source[index] === "/" && source[index + 1] === "/") {
      let end = index + 2;
      while (end < source.length && source[end] !== "\n") end += 1;
      maskSourceRange(output, source, index, end);
      index = end;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      let end = index + 2;
      let depth = 1;
      while (end < source.length && depth > 0) {
        if (source[end] === "/" && source[end + 1] === "*") {
          depth += 1;
          end += 2;
        } else if (source[end] === "*" && source[end + 1] === "/") {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      }
      maskSourceRange(output, source, index, end);
      index = end;
      continue;
    }

    const raw = rawStringAt(index);
    if (raw) {
      stringLiterals.push({
        value: source.slice(raw.contentStart, raw.contentEnd),
        start: raw.start,
        end: raw.end,
      });
      maskSourceRange(output, source, raw.start, raw.end);
      index = raw.end;
      continue;
    }

    const quoted = quotedLiteralAt(index);
    if (quoted) {
      stringLiterals.push({
        value: source.slice(quoted.contentStart, quoted.contentEnd),
        start: quoted.start,
        end: quoted.end,
      });
      maskSourceRange(output, source, quoted.start, quoted.end);
      index = quoted.end;
      continue;
    }

    const charEnd = charLiteralEnd(index);
    if (charEnd !== null) {
      maskSourceRange(output, source, index, charEnd);
      index = charEnd;
      continue;
    }
    index += 1;
  }

  return { source, code: output.join(""), stringLiterals };
}

function skipRustWhitespace(code, start) {
  let cursor = start;
  while (/\s/u.test(code[cursor] ?? "")) cursor += 1;
  return cursor;
}

function rustBracketEnd(code, start, open, close) {
  let depth = 0;
  for (let cursor = start; cursor < code.length; cursor += 1) {
    if (code[cursor] === open) depth += 1;
    if (code[cursor] === close) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return code.length;
}

/** Return the end of the single item to which a cfg(test) attribute applies. */
function cfgTestItemEnd(code, attributeEnd) {
  let cursor = skipRustWhitespace(code, attributeEnd);
  // Other attributes between cfg(test) and the item are attached to the same
  // item and must be skipped as part of it.
  while (code[cursor] === "#") {
    const bracket = skipRustWhitespace(code, cursor + 1);
    if (code[bracket] !== "[") break;
    cursor = skipRustWhitespace(code, rustBracketEnd(code, bracket, "[", "]"));
  }
  const itemStart = cursor;
  const itemHeaderProbe = code.slice(itemStart, itemStart + 256);
  const firstItemDelimiter = itemHeaderProbe.search(/[=;{]/u);
  const tracksTypeAngles = /\b(?:fn|struct|enum|union|impl|trait)\b/u.test(
    firstItemDelimiter < 0
      ? itemHeaderProbe
      : itemHeaderProbe.slice(0, firstItemDelimiter),
  );
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  for (; cursor < code.length; cursor += 1) {
    const current = code[cursor];
    if (current === "(") parenDepth += 1;
    else if (current === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (current === "[") bracketDepth += 1;
    else if (current === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (tracksTypeAngles && current === "<") angleDepth += 1;
    else if (tracksTypeAngles && current === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (
      current === ";" &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0
    ) {
      return cursor + 1;
    } else if (
      current === "{" &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      angleDepth === 0
    ) {
      const blockEnd = rustBracketEnd(code, cursor, "{", "}");
      const itemPrefix = code.slice(itemStart, cursor);
      if (/\b(?:const|static|type|use)\b/u.test(itemPrefix)) {
        const semicolon = code.indexOf(";", blockEnd);
        return semicolon < 0 ? blockEnd : semicolon + 1;
      }
      return blockEnd;
    }
  }
  return code.length;
}

function splitRustCfgArguments(expression) {
  const argumentsList = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === "(") depth += 1;
    else if (expression[index] === ")") depth = Math.max(0, depth - 1);
    else if (expression[index] === "," && depth === 0) {
      argumentsList.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = expression.slice(start).trim();
  if (tail !== "") argumentsList.push(tail);
  return argumentsList;
}

/** Possible truth values for a cfg expression when the `test` atom is false. */
function cfgPossibilitiesWithoutTest(expression) {
  const current = expression.trim();
  if (current === "test") return { canBeTrue: false, canBeFalse: true };
  const call = current.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)$/u);
  if (!call) return { canBeTrue: true, canBeFalse: true };
  const children = splitRustCfgArguments(call[2]).map((child) =>
    cfgPossibilitiesWithoutTest(child),
  );
  if (call[1] === "all") {
    return {
      canBeTrue: children.every((child) => child.canBeTrue),
      canBeFalse: children.some((child) => child.canBeFalse),
    };
  }
  if (call[1] === "any") {
    return {
      canBeTrue: children.some((child) => child.canBeTrue),
      canBeFalse: children.every((child) => child.canBeFalse),
    };
  }
  if (call[1] === "not" && children.length === 1) {
    return {
      canBeTrue: children[0].canBeFalse,
      canBeFalse: children[0].canBeTrue,
    };
  }
  return { canBeTrue: true, canBeFalse: true };
}

function cfgTestItemRanges(code) {
  const attributePattern = /#\s*\[\s*cfg\s*\(/gu;
  const testOnlyAttributes = [];
  for (const match of code.matchAll(/#\s*\[\s*test\s*\]/gu)) {
    testOnlyAttributes.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  let coveredThrough = -1;
  for (const match of code.matchAll(attributePattern)) {
    const open = match.index + match[0].lastIndexOf("(");
    const afterCfg = rustBracketEnd(code, open, "(", ")");
    const closingBracket = skipRustWhitespace(code, afterCfg);
    if (code[closingBracket] !== "]") continue;
    const expression = code.slice(open + 1, afterCfg - 1);
    if (cfgPossibilitiesWithoutTest(expression).canBeTrue) continue;
    testOnlyAttributes.push({
      start: match.index,
      end: closingBracket + 1,
    });
  }

  const ranges = [];
  for (const attribute of testOnlyAttributes.sort(
    (left, right) => left.start - right.start,
  )) {
    if (attribute.start < coveredThrough) continue;
    const end = cfgTestItemEnd(code, attribute.end);
    ranges.push({ start: attribute.start, end });
    coveredThrough = end;
  }
  return ranges;
}

/** Mask each cfg(test) item by its actual balanced item boundary. */
function maskCfgTestItems(code) {
  const output = code.split("");
  for (const range of cfgTestItemRanges(code)) {
    maskSourceRange(output, code, range.start, range.end);
  }
  return output.join("");
}

function rustRuntimeTestOnlyBranchRanges(code) {
  const ranges = [];
  for (const match of code.matchAll(/\bif\s+cfg!\s*\(/gu)) {
    const open = match.index + match[0].lastIndexOf("(");
    const afterCfg = rustBracketEnd(code, open, "(", ")");
    const expression = code.slice(open + 1, afterCfg - 1);
    if (cfgPossibilitiesWithoutTest(expression).canBeTrue) continue;
    let bodyStart = skipRustWhitespace(code, afterCfg);
    // `cfg!(test) && predicate` is still false in every production build.
    if (code.slice(bodyStart, bodyStart + 2) === "&&") {
      bodyStart = code.indexOf("{", bodyStart + 2);
    }
    if (bodyStart < 0 || code[bodyStart] !== "{") continue;
    ranges.push({
      start: match.index,
      end: rustBracketEnd(code, bodyStart, "{", "}"),
    });
  }
  for (const match of code.matchAll(/\bif\s+false\s*\{/gu)) {
    const bodyStart = match.index + match[0].lastIndexOf("{");
    ranges.push({
      start: match.index,
      end: rustBracketEnd(code, bodyStart, "{", "}"),
    });
  }
  return ranges;
}

function rustProductionCode(source) {
  const scanned = scanRustSource(source).code;
  const withoutTestItems = maskCfgTestItems(scanned);
  const output = withoutTestItems.split("");
  for (const range of rustRuntimeTestOnlyBranchRanges(withoutTestItems)) {
    maskSourceRange(output, withoutTestItems, range.start, range.end);
  }
  return output.join("");
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

function hasNapiMethodAttribute(lines, functionLineIndex) {
  for (let index = functionLineIndex - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "") continue;
    let attribute = trimmed;
    if (!trimmed.startsWith("#[")) {
      if (!trimmed.endsWith(")]")) return false;
      let attributeStart = index - 1;
      while (
        attributeStart >= 0 &&
        !lines[attributeStart].trim().startsWith("#[")
      ) {
        attributeStart -= 1;
      }
      if (attributeStart < 0) return false;
      attribute = lines
        .slice(attributeStart, index + 1)
        .join("\n")
        .trim();
      index = attributeStart;
    }
    const napi = attribute.match(/^#\[\s*napi(?:\(([\s\S]*)\))?\s*\]$/u);
    if (!napi) continue;
    const argumentsCode = napi[1] ?? "";
    if (!/\bjs_name\b/u.test(argumentsCode)) return true;
    const jsName = argumentsCode.match(
      /\bjs_name\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/u,
    );
    const rawJsName = argumentsCode.match(/\bjs_name\s*=\s*r(#+)?"([^"]*)"\1/u);
    return (
      jsName?.[1] === "runNarrativeFreshnessCycle" ||
      rawJsName?.[2] === "runNarrativeFreshnessCycle"
    );
  }
  return false;
}

function hasExactRustQualifier(code, symbolStart, qualifier) {
  const prefix = code.slice(0, symbolStart);
  const match = prefix.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*::\s*$/u);
  if (!match || match[1] !== qualifier) return false;
  const qualifierStart = prefix.length - match[0].length;
  return !/[a-zA-Z0-9_:]/u.test(prefix[qualifierStart - 1] ?? "");
}

function findAutomaticCallSites(
  rustFiles,
  repoRoot,
  symbol,
  productionEntryPoints = [],
) {
  const callSites = [];
  const declaredEntryPoints = new Set(productionEntryPoints);
  for (const absolute of rustFiles) {
    const relative = path
      .relative(repoRoot, absolute)
      .split(path.sep)
      .join("/");
    let source;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (!source.includes(symbol)) continue;
    const sourceScan = scanRustSource(source);
    const productionCode = rustProductionCode(source);
    const productionScan = { ...sourceScan, code: productionCode };
    const functions = findRustFunctions(productionCode);
    const sourceLines = source.split("\n");
    for (const call of findRustCalls(productionScan, symbol)) {
      const lineNumber = lineNumberAt(productionCode, call.start);
      if (relative === MANUAL_IPC_FILE) {
        const enclosingFunction = enclosingRustFunction(functions, call.start);
        if (
          !enclosingFunction ||
          !declaredEntryPoints.has(enclosingFunction.name) ||
          !MAIN_ONLY_NAPI_PRODUCTION_ENTRY_POINTS.has(enclosingFunction.name) ||
          !hasNapiMethodAttribute(
            sourceLines,
            lineNumberAt(productionCode, enclosingFunction.start) - 1,
          ) ||
          !hasExactRustQualifier(
            productionCode,
            call.start,
            "narrative_extraction",
          ) ||
          rustFunctionShadowsSymbol(
            productionScan,
            enclosingFunction.name,
            "narrative_extraction",
            call.start,
          )
        ) {
          continue;
        }
      } else {
        const enclosingFunction = enclosingRustFunction(functions, call.start);
        if (
          !call.bare ||
          !enclosingFunction ||
          rustFunctionShadowsSymbol(
            productionScan,
            enclosingFunction.name,
            symbol,
            call.start,
          )
        ) {
          // A method, lookalike path, or local binding with the same terminal
          // name is not evidence that the declared production trigger is wired.
          continue;
        }
      }
      callSites.push(`${relative}:${lineNumber}`);
    }
  }
  return callSites;
}

/**
 * `state` and the blocked-* fields must agree, for every Run Kind.
 *
 * This runs before the automatic-trigger call-graph check and applies to
 * manual-only Run Kinds too. A `wired` entry that still carries a
 * `blockedOn` is the contract saying "this is live" and "this is waiting on
 * something" in the same breath — a reader has no way to tell which half is
 * current, which is exactly the drift `implementationStatus` exists to make
 * impossible.
 */
function validateStateConsistency(entry, status, errors) {
  if (status.state === "wired") {
    if (isNonEmptyString(status.blockedReason)) {
      errors.push(
        `${entry.runKind} declares implementationStatus.state 'wired' but still carries a blockedReason — a wired Run Kind is not blocked on anything; drop the field or set state to 'unwired-blocked'`,
      );
    }
    if (Array.isArray(status.blockedOn) && status.blockedOn.length > 0) {
      errors.push(
        `${entry.runKind} declares implementationStatus.state 'wired' but still carries blockedOn (${status.blockedOn.join(", ")}) — resolve the entries and drop the field, or set state to 'unwired-blocked'`,
      );
    }
    return;
  }

  if (status.state === "unwired-blocked") {
    if (!isNonEmptyString(status.blockedReason)) {
      errors.push(
        `${entry.runKind} is 'unwired-blocked' but has no blockedReason explaining why the declared trigger is not live`,
      );
    }
    if (!Array.isArray(status.blockedOn) || status.blockedOn.length === 0) {
      errors.push(
        `${entry.runKind} is 'unwired-blocked' but has no blockedOn naming what must land first`,
      );
    }
  }
}

function validateImplementationStatus(entry, rustFiles, repoRoot, errors) {
  const status = entry.implementationStatus;
  if (!isObject(status)) return;

  validateStateConsistency(entry, status, errors);

  const isAutomatic =
    typeof entry.trigger === "string" && entry.trigger.startsWith("automatic");

  if (!isAutomatic) {
    if (isNonEmptyString(status.triggerSymbol)) {
      errors.push(
        `${entry.runKind} declares implementationStatus.triggerSymbol but its trigger is '${entry.trigger}'; only automatic-* Run Kinds have an automatic trigger to wire`,
      );
    }
    return;
  }

  if (!isNonEmptyString(status.triggerSymbol)) {
    errors.push(
      `${entry.runKind} declares trigger '${entry.trigger}' but implementationStatus has no triggerSymbol, so the wiring cannot be checked`,
    );
    return;
  }

  const callSites = findAutomaticCallSites(
    rustFiles,
    repoRoot,
    status.triggerSymbol,
    status.productionEntryPoints,
  );

  if (status.state === "wired" && callSites.length === 0) {
    errors.push(
      `${entry.runKind} declares implementationStatus.state 'wired', but no production caller of '${status.triggerSymbol}' exists outside test modules (calls in ${MANUAL_IPC_FILE} count only from an exact declared productionEntryPoint) — the automatic trigger this contract promises is not actually wired`,
    );
  }

  if (status.state === "unwired-blocked" && callSites.length > 0) {
    errors.push(
      `${entry.runKind} declares implementationStatus.state 'unwired-blocked', but '${status.triggerSymbol}' now has ${callSites.length} production call site(s) (${callSites.join(", ")}) — the trigger was wired without updating this contract`,
    );
  }
}

function unwrapTypeScriptExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function isTypeScriptBindingScope(node) {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isFunctionLike(node)
  );
}

function nearestTypeScriptBindingScope(node, blockScoped) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isSourceFile(current) || ts.isFunctionLike(current)) return current;
    if (blockScoped && isTypeScriptBindingScope(current)) return current;
  }
  return null;
}

function enclosingTypeScriptImportDeclaration(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isImportDeclaration(current)) return current;
    if (ts.isSourceFile(current)) return null;
  }
  return null;
}

function createTypeScriptBindingResolver(sourceFileOrFiles) {
  const sourceFiles = Array.isArray(sourceFileOrFiles)
    ? sourceFileOrFiles
    : [sourceFileOrFiles];
  const scopeBindings = new WeakMap();
  const importBindings = [];
  const register = (scope, name, binding) => {
    if (!scope) return;
    let bindings = scopeBindings.get(scope);
    if (!bindings) {
      bindings = new Map();
      scopeBindings.set(scope, bindings);
    }
    bindings.set(name, binding);
  };
  const registerPattern = (scope, name, binding) => {
    if (ts.isIdentifier(name)) {
      register(scope, name.text, binding);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        if (element.dotDotDotToken) {
          registerPattern(scope, element.name, { initializer: null });
          continue;
        }
        const propertyName = element.propertyName ?? element.name;
        if (ts.isIdentifier(element.name)) {
          register(scope, element.name.text, {
            initializer: null,
            propertyObject: binding.initializer,
            propertyName,
            forbidden:
              (ts.isIdentifier(propertyName) ||
                ts.isStringLiteralLike(propertyName)) &&
              MAIN_ONLY_FRESHNESS_METHOD_NAMES.has(propertyName.text),
          });
        } else {
          registerPattern(scope, element.name, { initializer: null });
        }
      }
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
          registerPattern(scope, element.name, { initializer: null });
        }
      }
    }
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      const blockScoped = (node.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
      const scope = nearestTypeScriptBindingScope(node, blockScoped);
      registerPattern(scope, node.name, {
        initializer:
          (node.parent.flags & ts.NodeFlags.Const) !== 0
            ? (node.initializer ?? null)
            : null,
      });
    } else if (ts.isParameter(node)) {
      registerPattern(node.parent, node.name, { initializer: null });
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      register(nearestTypeScriptBindingScope(node, true), node.name.text, {
        initializer: ts.isFunctionDeclaration(node) ? node : null,
      });
    } else if (ts.isImportClause(node)) {
      if (node.name) {
        const declaration = enclosingTypeScriptImportDeclaration(node);
        const binding = {
          initializer: null,
          importedName: "default",
          importModule:
            declaration && ts.isStringLiteralLike(declaration.moduleSpecifier)
              ? declaration.moduleSpecifier.text
              : null,
          typeOnly: node.isTypeOnly,
          ownerFile: node.getSourceFile(),
        };
        register(node.getSourceFile(), node.name.text, binding);
        importBindings.push(binding);
      }
    } else if (ts.isImportSpecifier(node)) {
      const declaration = enclosingTypeScriptImportDeclaration(node);
      const importedName = (node.propertyName ?? node.name).text;
      const binding = {
        initializer: null,
        importedName,
        importModule:
          declaration && ts.isStringLiteralLike(declaration.moduleSpecifier)
            ? declaration.moduleSpecifier.text
            : null,
        typeOnly: node.isTypeOnly || node.parent.parent.isTypeOnly,
        forbidden: MAIN_ONLY_FRESHNESS_METHOD_NAMES.has(importedName),
        ownerFile: node.getSourceFile(),
      };
      register(node.getSourceFile(), node.name.text, binding);
      importBindings.push(binding);
    } else if (ts.isNamespaceImport(node)) {
      const declaration = enclosingTypeScriptImportDeclaration(node);
      const binding = {
        initializer: null,
        importedName: "*",
        importModule:
          declaration && ts.isStringLiteralLike(declaration.moduleSpecifier)
            ? declaration.moduleSpecifier.text
            : null,
        typeOnly: node.parent.isTypeOnly,
        ownerFile: node.getSourceFile(),
      };
      register(node.getSourceFile(), node.name.text, binding);
      importBindings.push(binding);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      registerPattern(node, node.variableDeclaration.name, {
        initializer: null,
      });
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of sourceFiles) visit(sourceFile);

  const byFileName = new Map(
    sourceFiles.map((sourceFile) => [
      path.posix.normalize(sourceFile.fileName.replaceAll(path.sep, "/")),
      sourceFile,
    ]),
  );
  const resolveRelativeModule = (ownerFile, moduleName) => {
    if (!moduleName?.startsWith(".")) return null;
    const ownerName = path.posix.normalize(
      ownerFile.fileName.replaceAll(path.sep, "/"),
    );
    const joined = path.posix.normalize(
      path.posix.join(path.posix.dirname(ownerName), moduleName),
    );
    const withoutJavaScriptExtension = joined.replace(/\.(?:c|m)?js$/u, "");
    for (const candidate of [
      joined,
      `${withoutJavaScriptExtension}.ts`,
      `${withoutJavaScriptExtension}.tsx`,
      `${withoutJavaScriptExtension}/index.ts`,
      `${withoutJavaScriptExtension}/index.tsx`,
    ]) {
      const target = byFileName.get(candidate);
      if (target) return target;
    }
    return null;
  };
  const resolveExportedValue = (sourceFile, exportedName, seen = new Set()) => {
    const key = `${sourceFile.fileName}:${exportedName}`;
    if (seen.has(key)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(key);
    const direct = exportedTopLevelConstInitializer(sourceFile, exportedName);
    if (direct) return direct;
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
      const moduleName =
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      const target = moduleName
        ? resolveRelativeModule(sourceFile, moduleName)
        : sourceFile;
      if (!target) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly || element.name.text !== exportedName)
            continue;
          return resolveExportedValue(
            target,
            (element.propertyName ?? element.name).text,
            nextSeen,
          );
        }
      } else if (!statement.exportClause && target !== sourceFile) {
        const wildcard = resolveExportedValue(target, exportedName, nextSeen);
        if (wildcard) return wildcard;
      }
    }
    return null;
  };
  for (const binding of importBindings) {
    if (binding.typeOnly) continue;
    const target = resolveRelativeModule(
      binding.ownerFile,
      binding.importModule,
    );
    if (!target) continue;
    binding.importedSourceFile = target;
    binding.resolveImportedProperty = (name) =>
      resolveExportedValue(target, name);
    if (binding.importedName !== "*" && binding.importedName !== "default") {
      binding.importedExpression = resolveExportedValue(
        target,
        binding.importedName,
      );
    }
  }

  return {
    resolve(identifier) {
      for (let current = identifier.parent; current; current = current.parent) {
        if (!isTypeScriptBindingScope(current)) continue;
        const binding = scopeBindings.get(current)?.get(identifier.text);
        if (binding) return binding;
      }
      return null;
    },
  };
}

function staticPropertyName(name, resolver, seen) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    return resolveStaticString(name.expression, resolver, seen);
  }
  return null;
}

function bindingExpression(binding, resolver, seen) {
  if (binding.initializer) return binding.initializer;
  if (binding.importedExpression) return binding.importedExpression;
  if (binding.propertyObject && binding.propertyName) {
    const key = staticPropertyName(binding.propertyName, resolver, seen);
    return key === null
      ? null
      : objectPropertyExpression(binding.propertyObject, key, resolver, seen);
  }
  return null;
}

function objectPropertyExpression(node, key, resolver, seen) {
  const current = unwrapTypeScriptExpression(node);
  if (!current) return null;
  if (ts.isIdentifier(current)) {
    const binding = resolver.resolve(current);
    if (!binding) return null;
    if (binding.resolveImportedProperty) {
      return binding.resolveImportedProperty(key);
    }
    if (seen.has(binding)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(binding);
    const expression = bindingExpression(binding, resolver, nextSeen);
    return expression
      ? objectPropertyExpression(expression, key, resolver, nextSeen)
      : null;
  }
  if (!ts.isObjectLiteralExpression(current)) return null;
  for (let index = current.properties.length - 1; index >= 0; index -= 1) {
    const property = current.properties[index];
    if (ts.isSpreadAssignment(property)) {
      const spread = objectPropertyExpression(
        property.expression,
        key,
        resolver,
        seen,
      );
      if (spread) return spread;
      continue;
    }
    if (!property.name) continue;
    const propertyName = staticPropertyName(property.name, resolver, seen);
    if (propertyName !== key) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) {
      const binding = resolver.resolve(property.name);
      return binding ? bindingExpression(binding, resolver, seen) : null;
    }
    return property;
  }
  return null;
}

function resolveStaticArrayElements(node, resolver, seen = new Set()) {
  const current = unwrapTypeScriptExpression(node);
  if (ts.isArrayLiteralExpression(current)) return [...current.elements];
  if (ts.isIdentifier(current)) {
    const binding = resolver.resolve(current);
    if (!binding || seen.has(binding)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(binding);
    const expression = bindingExpression(binding, resolver, nextSeen);
    return expression
      ? resolveStaticArrayElements(expression, resolver, nextSeen)
      : null;
  }
  return null;
}

function resolveStaticString(node, resolver, seen = new Set()) {
  const current = unwrapTypeScriptExpression(node);
  if (!current) return null;
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    for (const span of current.templateSpans) {
      const expression = resolveStaticString(span.expression, resolver, seen);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = resolveStaticString(current.left, resolver, seen);
    const right = resolveStaticString(current.right, resolver, seen);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isCallExpression(current)) {
    const callee = unwrapTypeScriptExpression(current.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "join") {
      const receiver = unwrapTypeScriptExpression(callee.expression);
      const receiverElements = resolveStaticArrayElements(
        receiver,
        resolver,
        seen,
      );
      if (!receiverElements) return null;
      const separator =
        current.arguments.length === 0
          ? ","
          : resolveStaticString(current.arguments[0], resolver, seen);
      if (separator === null) return null;
      const elements = receiverElements.map((element) =>
        resolveStaticString(element, resolver, seen),
      );
      return elements.some((element) => element === null)
        ? null
        : elements.join(separator);
    }
  }
  if (ts.isIdentifier(current)) {
    const binding = resolver.resolve(current);
    if (!binding) return null;
    if (seen.has(binding)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(binding);
    const expression = bindingExpression(binding, resolver, nextSeen);
    return expression
      ? resolveStaticString(expression, resolver, nextSeen)
      : null;
  }
  if (ts.isPropertyAccessExpression(current)) {
    const property = objectPropertyExpression(
      current.expression,
      current.name.text,
      resolver,
      seen,
    );
    return property ? resolveStaticString(property, resolver, seen) : null;
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const key = resolveStaticString(current.argumentExpression, resolver, seen);
    if (key === null) return null;
    const property = objectPropertyExpression(
      current.expression,
      key,
      resolver,
      seen,
    );
    return property ? resolveStaticString(property, resolver, seen) : null;
  }
  return null;
}

function containsMainOnlyFreshnessReference(
  node,
  resolver,
  visitedBindings = new Set(),
) {
  if (
    ts.isTypeNode(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return false;
  }
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) return false;
    if (clause.name && MAIN_ONLY_FRESHNESS_METHOD_NAMES.has(clause.name.text)) {
      return true;
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      return bindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          (MAIN_ONLY_FRESHNESS_METHOD_NAMES.has(element.name.text) ||
            MAIN_ONLY_FRESHNESS_METHOD_NAMES.has(
              (element.propertyName ?? element.name).text,
            )),
      );
    }
    return false;
  }
  const resolved = resolveStaticString(node, resolver);
  if (resolved !== null && MAIN_ONLY_FRESHNESS_METHOD_NAMES.has(resolved)) {
    return true;
  }
  if (
    ts.isIdentifier(node) &&
    MAIN_ONLY_FRESHNESS_METHOD_NAMES.has(node.text)
  ) {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    MAIN_ONLY_FRESHNESS_METHOD_NAMES.has(node.name.text)
  ) {
    return true;
  }
  if (ts.isIdentifier(node)) {
    const binding = resolver.resolve(node);
    if (binding?.forbidden) return true;
    if (binding && !visitedBindings.has(binding)) {
      visitedBindings.add(binding);
      const expression = bindingExpression(binding, resolver, visitedBindings);
      if (
        expression &&
        containsMainOnlyFreshnessReference(
          expression,
          resolver,
          visitedBindings,
        )
      ) {
        return true;
      }
    }
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (
      !found &&
      containsMainOnlyFreshnessReference(child, resolver, visitedBindings)
    ) {
      found = true;
    }
  });
  return found;
}

function parseTypeScript(source, relativePath) {
  const scriptKind = relativePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  return ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
}

function exportedTopLevelConstInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer ?? null;
      }
    }
  }
  return null;
}

function resolveTypeScriptIdentifierTarget(
  node,
  resolver,
  seenBindings = new Set(),
) {
  const current = unwrapTypeScriptExpression(node);
  if (!ts.isIdentifier(current)) return null;
  const binding = resolver.resolve(current);
  if (!binding) return current.text;
  if (
    ["ipcMain", "ipcRenderer", "contextBridge"].includes(binding.importedName)
  ) {
    return binding.importedName;
  }
  if (seenBindings.has(binding)) return null;
  const nextSeen = new Set(seenBindings);
  nextSeen.add(binding);
  const expression = bindingExpression(binding, resolver, nextSeen);
  return expression
    ? resolveTypeScriptIdentifierTarget(expression, resolver, nextSeen)
    : null;
}

function isTypeScriptIpcPrimitiveCallee(
  node,
  resolver,
  seenBindings = new Set(),
) {
  const current = unwrapTypeScriptExpression(node);
  if (!current) return false;
  if (ts.isIdentifier(current)) {
    const binding = resolver.resolve(current);
    if (!binding || seenBindings.has(binding)) return false;
    seenBindings.add(binding);
    if (binding.propertyObject && binding.propertyName) {
      const method = staticPropertyName(
        binding.propertyName,
        resolver,
        seenBindings,
      );
      const receiver = resolveTypeScriptIdentifierTarget(
        binding.propertyObject,
        resolver,
        seenBindings,
      );
      if (
        (receiver === "ipcMain" &&
          ["handle", "handleOnce", "on"].includes(method)) ||
        (receiver === "ipcRenderer" && ["invoke", "send"].includes(method)) ||
        (receiver === "contextBridge" && method === "exposeInMainWorld")
      ) {
        return true;
      }
    }
    const expression = bindingExpression(binding, resolver, seenBindings);
    return expression
      ? isTypeScriptIpcPrimitiveCallee(expression, resolver, seenBindings)
      : false;
  }
  if (ts.isCallExpression(current)) {
    const callee = unwrapTypeScriptExpression(current.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "bind") {
      return isTypeScriptIpcPrimitiveCallee(
        callee.expression,
        resolver,
        seenBindings,
      );
    }
    return false;
  }
  if (ts.isPropertyAccessExpression(current)) {
    const receiver = unwrapTypeScriptExpression(current.expression);
    const receiverName = resolveTypeScriptIdentifierTarget(
      receiver,
      resolver,
      seenBindings,
    );
    if (
      receiverName === "ipcMain" &&
      ["handle", "handleOnce", "on"].includes(current.name.text)
    ) {
      return true;
    }
    if (
      receiverName === "ipcRenderer" &&
      ["invoke", "send"].includes(current.name.text)
    ) {
      return true;
    }
    if (
      receiverName === "contextBridge" &&
      current.name.text === "exposeInMainWorld"
    ) {
      return true;
    }
    if (
      current.name.text === "invoke" &&
      ts.isPropertyAccessExpression(receiver) &&
      receiver.name.text === "grimodex"
    ) {
      return true;
    }
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const method = resolveStaticString(
      current.argumentExpression,
      resolver,
      seenBindings,
    );
    const receiver = unwrapTypeScriptExpression(current.expression);
    const receiverName = resolveTypeScriptIdentifierTarget(
      receiver,
      resolver,
      seenBindings,
    );
    return (
      (receiverName === "ipcMain" &&
        ["handle", "handleOnce", "on"].includes(method)) ||
      (receiverName === "ipcRenderer" && ["invoke", "send"].includes(method)) ||
      (receiverName === "contextBridge" && method === "exposeInMainWorld")
    );
  }
  return false;
}

function isTypeScriptIpcPrimitiveCall(call, resolver) {
  return isTypeScriptIpcPrimitiveCallee(call.expression, resolver);
}

function collectProductionTypeScriptFiles(repoRoot) {
  const files = [];
  const roots = ["electron/preload", "electron/main", "electron/shared", "src"];
  const walk = (absolute) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (
          ["node_modules", "__tests__", "dist", "target"].includes(entry.name)
        ) {
          continue;
        }
        walk(child);
      } else if (
        entry.isFile() &&
        /\.[cm]?[jt]sx?$/u.test(entry.name) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)
      ) {
        files.push(child);
      }
    }
  };
  for (const root of roots) walk(path.join(repoRoot, root));
  return files;
}

function validateMainOnlyFreshnessBoundary(repoRoot, ipcContract, errors) {
  const boundaryEntries = collectProductionTypeScriptFiles(repoRoot).map(
    (absolute) => {
      const relative = path
        .relative(repoRoot, absolute)
        .split(path.sep)
        .join("/");
      const source =
        relative === IPC_CONTRACT_PATH
          ? ipcContract
          : readFileSync(absolute, "utf8");
      return {
        absolute,
        relative,
        source,
        sourceFile: parseTypeScript(source, relative),
      };
    },
  );
  let contractEntry = boundaryEntries.find(
    (entry) => entry.relative === IPC_CONTRACT_PATH,
  );
  if (!contractEntry) {
    contractEntry = {
      absolute: path.join(repoRoot, IPC_CONTRACT_PATH),
      relative: IPC_CONTRACT_PATH,
      source: ipcContract,
      sourceFile: parseTypeScript(ipcContract, IPC_CONTRACT_PATH),
    };
    boundaryEntries.push(contractEntry);
  }
  const sourceFile = contractEntry.sourceFile;
  const resolver = createTypeScriptBindingResolver(
    boundaryEntries.map((entry) => entry.sourceFile),
  );
  const napiCommands = exportedTopLevelConstInitializer(
    sourceFile,
    "NAPI_COMMANDS",
  );
  if (!napiCommands) {
    errors.push(
      `${IPC_CONTRACT_PATH} does not expose the NAPI_COMMANDS section needed to verify the main-only Freshness boundary`,
    );
  } else if (containsMainOnlyFreshnessReference(napiCommands, resolver)) {
    errors.push(
      `incremental-freshness main-only N-API method must not be registered in ${IPC_CONTRACT_PATH}'s renderer NAPI_COMMANDS`,
    );
  }

  const shellCommands = exportedTopLevelConstInitializer(
    sourceFile,
    "SHELL_COMMAND_NAMES",
  );
  if (!shellCommands) {
    errors.push(
      `${IPC_CONTRACT_PATH} does not expose the renderer shell command allowlist needed to verify the main-only Freshness boundary`,
    );
  } else if (containsMainOnlyFreshnessReference(shellCommands, resolver)) {
    errors.push(
      `incremental-freshness main-only N-API method must not be registered in ${IPC_CONTRACT_PATH}'s renderer shell command allowlist`,
    );
  }

  if (containsMainOnlyFreshnessReference(sourceFile, resolver)) {
    errors.push(
      `incremental-freshness main-only N-API method must not appear in any executable/value surface of ${IPC_CONTRACT_PATH}`,
    );
  }

  for (const { relative, sourceFile: boundarySource } of boundaryEntries) {
    if (
      relative !== "electron/main/narrativeFreshness.ts" &&
      containsMainOnlyFreshnessReference(boundarySource, resolver)
    ) {
      errors.push(
        `incremental-freshness main-only Freshness method is exposed through renderer/preload/main IPC code in ${relative}`,
      );
      continue;
    }
    if (relative === "electron/main/narrativeFreshness.ts") {
      let exposesThroughIpc = false;
      const visit = (node) => {
        if (exposesThroughIpc) return;
        if (
          ts.isCallExpression(node) &&
          isTypeScriptIpcPrimitiveCall(node, resolver) &&
          containsMainOnlyFreshnessReference(node, resolver)
        ) {
          exposesThroughIpc = true;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(boundarySource);
      if (exposesThroughIpc) {
        errors.push(
          `incremental-freshness main-only Freshness method is exposed through renderer/preload/main IPC code in ${relative}`,
        );
      }
    }
  }
}

function nearestTypeScriptFunctionContext(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return null;
}

function isElectronReadyExecutionContext(context) {
  if (context === null) return true;
  if (!ts.isArrowFunction(context) && !ts.isFunctionExpression(context)) {
    return false;
  }
  const call = context.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(context)) {
    return false;
  }
  const then = unwrapTypeScriptExpression(call.expression);
  if (!ts.isPropertyAccessExpression(then) || then.name.text !== "then") {
    return false;
  }
  const whenReadyCall = unwrapTypeScriptExpression(then.expression);
  if (!ts.isCallExpression(whenReadyCall)) return false;
  const whenReady = unwrapTypeScriptExpression(whenReadyCall.expression);
  return (
    ts.isPropertyAccessExpression(whenReady) &&
    ts.isIdentifier(whenReady.expression) &&
    whenReady.expression.text === "app" &&
    whenReady.name.text === "whenReady" &&
    nearestTypeScriptFunctionContext(call) === null
  );
}

function staticTypeScriptBoolean(node) {
  const current = unwrapTypeScriptExpression(node);
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (
    ts.isPrefixUnaryExpression(current) &&
    current.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const operand = staticTypeScriptBoolean(current.operand);
    return operand === null ? null : !operand;
  }
  return null;
}

function isInsideStaticallyDeadTypeScriptBranch(node) {
  for (let current = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isIfStatement(parent)) {
      const condition = staticTypeScriptBoolean(parent.expression);
      if (
        (current === parent.thenStatement && condition === false) ||
        (current === parent.elseStatement && condition === true)
      ) {
        return true;
      }
    }
    if (ts.isConditionalExpression(parent)) {
      const condition = staticTypeScriptBoolean(parent.condition);
      if (
        (current === parent.whenTrue && condition === false) ||
        (current === parent.whenFalse && condition === true)
      ) {
        return true;
      }
    }
    if (
      ts.isWhileStatement(parent) &&
      current === parent.statement &&
      staticTypeScriptBoolean(parent.expression) === false
    ) {
      return true;
    }
  }
  return false;
}

function analyzeCanonicalFreshnessSchedulerWiring(source) {
  const sourceFile = parseTypeScript(source, ELECTRON_MAIN_INDEX_PATH);
  const resolver = createTypeScriptBindingResolver(sourceFile);
  const canonicalFactoryBindings = new Set();

  const collectCanonicalImports = (node) => {
    if (ts.isImportSpecifier(node)) {
      const binding = resolver.resolve(node.name);
      if (
        binding?.importedName === "createNarrativeFreshnessScheduler" &&
        binding.importModule === "./narrativeFreshness.js" &&
        !binding.typeOnly
      ) {
        canonicalFactoryBindings.add(binding);
      }
    }
    ts.forEachChild(node, collectCanonicalImports);
  };
  collectCanonicalImports(sourceFile);

  const creations = [];
  const startCalls = [];
  const invalidations = [];
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const initializer = unwrapTypeScriptExpression(node.initializer);
      if (ts.isCallExpression(initializer)) {
        const callee = unwrapTypeScriptExpression(initializer.expression);
        if (
          ts.isIdentifier(callee) &&
          canonicalFactoryBindings.has(resolver.resolve(callee))
        ) {
          creations.push({
            binding: resolver.resolve(node.name),
            declarationEnd: node.end,
            context: nearestTypeScriptFunctionContext(node),
            dead: isInsideStaticallyDeadTypeScriptBranch(node),
          });
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapTypeScriptExpression(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "start"
      ) {
        const receiver = unwrapTypeScriptExpression(callee.expression);
        if (ts.isIdentifier(receiver)) {
          startCalls.push({
            binding: resolver.resolve(receiver),
            callStart: node.getStart(sourceFile),
            context: nearestTypeScriptFunctionContext(node),
            dead: isInsideStaticallyDeadTypeScriptBranch(node),
          });
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = unwrapTypeScriptExpression(node.left);
      if (ts.isIdentifier(left)) {
        invalidations.push({
          binding: resolver.resolve(left),
          start: node.getStart(sourceFile),
        });
      } else if (
        ts.isPropertyAccessExpression(left) &&
        left.name.text === "start"
      ) {
        const receiver = unwrapTypeScriptExpression(left.expression);
        if (ts.isIdentifier(receiver)) {
          invalidations.push({
            binding: resolver.resolve(receiver),
            start: node.getStart(sourceFile),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const shippingCreations = creations.filter(
    (creation) =>
      isElectronReadyExecutionContext(creation.context) && !creation.dead,
  );

  return {
    hasCanonicalImport: canonicalFactoryBindings.size > 0,
    hasCanonicalCreation: shippingCreations.length > 0,
    hasStartedCanonicalBinding: shippingCreations.some(
      (creation) =>
        creation.binding &&
        startCalls.some(
          (start) =>
            start.binding === creation.binding &&
            start.context === creation.context &&
            isElectronReadyExecutionContext(start.context) &&
            !start.dead &&
            start.callStart > creation.declarationEnd &&
            !invalidations.some(
              (invalidation) =>
                invalidation.binding === creation.binding &&
                invalidation.start > creation.declarationEnd &&
                invalidation.start < start.callStart,
            ),
        ),
    ),
  };
}

function validateIncrementalFreshnessElectronWiring(policy, repoRoot, errors) {
  if (!isObject(policy) || !Array.isArray(policy.runKinds)) return;
  const incremental = policy.runKinds.find(
    (entry) => entry?.runKind === "incremental-freshness",
  );
  if (!isObject(incremental)) return;

  if (incremental.implementationStatus?.state === "wired") {
    const mainIndex = readSource(
      repoRoot,
      ELECTRON_MAIN_INDEX_PATH,
      errors,
      "Electron main entrypoint",
    );
    if (mainIndex !== null) {
      const wiring = analyzeCanonicalFreshnessSchedulerWiring(mainIndex);
      if (!wiring.hasCanonicalImport) {
        errors.push(
          `incremental-freshness is wired but ${ELECTRON_MAIN_INDEX_PATH} does not import createNarrativeFreshnessScheduler from './narrativeFreshness.js'`,
        );
      }
      if (!wiring.hasCanonicalCreation) {
        errors.push(
          `incremental-freshness is wired but ${ELECTRON_MAIN_INDEX_PATH} does not create the Narrative Freshness scheduler from the canonical scheduler binding`,
        );
      } else if (!wiring.hasStartedCanonicalBinding) {
        errors.push(
          `incremental-freshness is wired but ${ELECTRON_MAIN_INDEX_PATH} creates its scheduler without calling start() on that same canonical scheduler binding`,
        );
      }
    }
  }

  const ipcContract = readSource(
    repoRoot,
    IPC_CONTRACT_PATH,
    errors,
    "Electron IPC contract",
  );
  if (ipcContract === null) return;
  validateMainOnlyFreshnessBoundary(repoRoot, ipcContract, errors);
}

function rustConstExpression(scan, name) {
  const productionCode = maskCfgTestItems(scan.code);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`\\bconst\\s+${escapedName}\\b[^=;]*=`, "gu");
  const matches = [...productionCode.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const start = matches[0].index + matches[0][0].length;
  const end = productionCode.indexOf(";", start);
  if (end < 0) return null;
  return {
    start,
    end,
    code: productionCode.slice(start, end).trim(),
  };
}

function rustConstString(scan, name) {
  const expression = rustConstExpression(scan, name);
  if (!expression) return null;
  const literals = scan.stringLiterals.filter(
    (literal) =>
      literal.start >= expression.start && literal.end <= expression.end,
  );
  return literals.length === 1 ? literals[0].value : null;
}

function rustConstInteger(scan, name) {
  const expression = rustConstExpression(scan, name);
  if (!expression || !/^\d[\d_]*$/u.test(expression.code)) return null;
  return Number(expression.code.replaceAll("_", ""));
}

function findRustFunctions(code) {
  const functions = [];
  for (const match of code.matchAll(/\bfn\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gu)) {
    let parenDepth = 0;
    let bracketDepth = 0;
    let angleDepth = 0;
    let bodyStart = -1;
    for (
      let cursor = match.index + match[0].length;
      cursor < code.length;
      cursor += 1
    ) {
      const current = code[cursor];
      if (current === "(") parenDepth += 1;
      else if (current === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (current === "[") bracketDepth += 1;
      else if (current === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (current === "<") angleDepth += 1;
      else if (current === ">" && angleDepth > 0) angleDepth -= 1;
      else if (
        current === ";" &&
        parenDepth === 0 &&
        bracketDepth === 0 &&
        angleDepth === 0
      ) {
        break;
      } else if (
        current === "{" &&
        parenDepth === 0 &&
        bracketDepth === 0 &&
        angleDepth === 0
      ) {
        bodyStart = cursor;
        break;
      }
    }
    if (bodyStart < 0) continue;
    functions.push({
      name: match[1],
      start: match.index,
      bodyStart,
      end: rustBracketEnd(code, bodyStart, "{", "}"),
    });
  }
  return functions;
}

function enclosingRustFunction(functions, index) {
  return (
    functions
      .filter((item) => item.bodyStart < index && index < item.end)
      .sort((left, right) => right.bodyStart - left.bodyStart)[0] ?? null
  );
}

function findRustCalls(scan, symbol) {
  const productionCode = maskCfgTestItems(scan.code);
  const functions = findRustFunctions(productionCode);
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`\\b${escapedSymbol}\\s*\\(`, "gu");
  const calls = [];
  for (const match of productionCode.matchAll(pattern)) {
    const before = productionCode.slice(
      Math.max(0, match.index - 64),
      match.index,
    );
    if (/\bfn\s*$/u.test(before)) continue;
    const open = productionCode.indexOf("(", match.index + symbol.length);
    if (open < 0) continue;
    const ranges = [];
    let argumentStart = open + 1;
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let close = -1;
    for (let cursor = open + 1; cursor < productionCode.length; cursor += 1) {
      const current = productionCode[cursor];
      if (current === "(") parenDepth += 1;
      else if (current === ")") {
        if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
          ranges.push({ start: argumentStart, end: cursor });
          close = cursor;
          break;
        }
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (current === "[") bracketDepth += 1;
      else if (current === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (current === "{") braceDepth += 1;
      else if (current === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (
        current === "," &&
        parenDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0
      ) {
        ranges.push({ start: argumentStart, end: cursor });
        argumentStart = cursor + 1;
      }
    }
    if (close < 0) continue;
    const calleePrefix = productionCode.slice(
      Math.max(0, match.index - 256),
      match.index,
    );
    const receiver = calleePrefix.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*$/u);
    const qualified = /(?:::|\.)\s*$/u.test(calleePrefix);
    calls.push({
      start: match.index,
      bare: !qualified,
      receiverCode: receiver?.[1] ?? null,
      functionName: enclosingRustFunction(functions, match.index)?.name ?? null,
      arguments: ranges.map((range) => ({
        ...range,
        code: productionCode.slice(range.start, range.end).trim(),
        source: scan.source.slice(range.start, range.end).trim(),
        stringLiterals: scan.stringLiterals.filter(
          (literal) => literal.start >= range.start && literal.end <= range.end,
        ),
      })),
    });
  }
  return calls;
}

function rustFunctionCode(scan, name) {
  const productionCode = maskCfgTestItems(scan.code);
  const item = findRustFunctions(productionCode).find(
    (candidate) => candidate.name === name,
  );
  return item ? productionCode.slice(item.bodyStart, item.end) : null;
}

function rustFunctionShadowsSymbol(scan, functionName, symbol, beforeIndex) {
  const productionCode = maskCfgTestItems(scan.code);
  const item = findRustFunctions(productionCode).find(
    (candidate) => candidate.name === functionName,
  );
  if (!item || beforeIndex <= item.start || beforeIndex > item.end) return true;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const prefix = productionCode.slice(item.start, beforeIndex);
  const signature = productionCode.slice(item.start, item.bodyStart);
  const parameterOpen = signature.indexOf("(");
  const parameterEnd =
    parameterOpen < 0 ? -1 : rustBracketEnd(signature, parameterOpen, "(", ")");
  const parameters =
    parameterEnd < 0
      ? ""
      : signature.slice(parameterOpen + 1, parameterEnd - 1);
  const parameterPattern = new RegExp(
    `(?:^|,)\\s*(?:(?:mut|ref)\\s+)*${escaped}\\s*:`,
    "u",
  );
  const closureParameterShadow = [...prefix.matchAll(/\|([^|]*)\|/gu)].some(
    (match) => parameterPattern.test(match[1]),
  );
  return (
    parameterPattern.test(parameters) ||
    closureParameterShadow ||
    new RegExp(
      `\\b(?:let\\s+(?:mut\\s+)?|const\\s+|static\\s+|fn\\s+)${escaped}\\b`,
      "u",
    ).test(prefix) ||
    new RegExp(`\\buse\\b[^;]*\\bas\\s+${escaped}\\b`, "u").test(prefix)
  );
}

function rustArgumentString(argument) {
  return argument?.stringLiterals.length === 1
    ? argument.stringLiterals[0].value
    : null;
}

function rustTokenCount(code, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...code.matchAll(new RegExp(`\\b${escaped}\\b`, "gu"))].length;
}

function validateIncrementalFreshnessRustContract(policy, repoRoot, errors) {
  if (!isObject(policy) || !Array.isArray(policy.runKinds)) return;
  const incremental = policy.runKinds.find(
    (entry) => entry?.runKind === "incremental-freshness",
  );
  if (!isObject(incremental)) return;

  const runtimeSource = readSource(
    repoRoot,
    INCREMENTAL_FRESHNESS_RUNTIME_PATH,
    errors,
    "Incremental Freshness Rust runtime",
  );
  const moduleSource = readSource(
    repoRoot,
    NARRATIVE_EXTRACTION_MOD_PATH,
    errors,
    "Narrative extraction Rust module",
  );
  if (runtimeSource === null || moduleSource === null) return;

  const runtime = scanRustSource(runtimeSource);
  const module = scanRustSource(moduleSource);

  const batchSize = rustConstInteger(
    runtime,
    "MAX_CANONICAL_SEQUENCES_PER_BATCH",
  );
  if (batchSize !== incremental.maxCanonicalSequencesPerBatch) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} MAX_CANONICAL_SEQUENCES_PER_BATCH (${String(batchSize)}) disagrees with policy (${incremental.maxCanonicalSequencesPerBatch})`,
    );
  }
  const envelopeCalls = findRustCalls(
    runtime,
    "load_change_batch_envelope",
  ).filter((call) => call.functionName === "create_and_claim_batch_in_tx");
  if (
    envelopeCalls.length !== 1 ||
    !(
      envelopeCalls[0].arguments[0]?.code === "conn" &&
      envelopeCalls[0].bare &&
      !rustFunctionShadowsSymbol(
        runtime,
        "create_and_claim_batch_in_tx",
        "load_change_batch_envelope",
        envelopeCalls[0].start,
      ) &&
      envelopeCalls[0].arguments[1]?.code === "project_id" &&
      envelopeCalls[0].arguments[2]?.code === "acknowledged" &&
      envelopeCalls[0].arguments[3]?.code ===
        "MAX_CANONICAL_SEQUENCES_PER_BATCH"
    )
  ) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} create_and_claim_batch_in_tx must have exactly one canonical load_change_batch_envelope call with (conn, project_id, acknowledged, MAX_CANONICAL_SEQUENCES_PER_BATCH)`,
    );
  }
  const changeFeedCalls = findRustCalls(runtime, "get_changes_since").filter(
    (call) => call.functionName === "prepare_change_events",
  );
  if (
    changeFeedCalls.length !== 1 ||
    !(
      changeFeedCalls[0].arguments[0]?.code === "conn" &&
      changeFeedCalls[0].bare &&
      !rustFunctionShadowsSymbol(
        runtime,
        "prepare_change_events",
        "get_changes_since",
        changeFeedCalls[0].start,
      ) &&
      changeFeedCalls[0].arguments[1]?.code === "project_id" &&
      changeFeedCalls[0].arguments[2]?.code === "after_sequence" &&
      changeFeedCalls[0].arguments[3]?.code ===
        "MAX_CANONICAL_SEQUENCES_PER_BATCH"
    )
  ) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} prepare_change_events must have exactly one canonical get_changes_since call with (conn, project_id, after_sequence, MAX_CANONICAL_SEQUENCES_PER_BATCH)`,
    );
  }

  const maxAttempts = rustConstInteger(runtime, "MAX_ATTEMPTS_PER_BATCH");
  if (maxAttempts !== incremental.retryPolicy?.maxAttemptsPerTask) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} MAX_ATTEMPTS_PER_BATCH (${String(maxAttempts)}) disagrees with policy (${incremental.retryPolicy?.maxAttemptsPerTask})`,
    );
  }
  const requeueCode = rustFunctionCode(runtime, "requeue_after_failure");
  if (
    requeueCode === null ||
    !/\battempt_count\s*>=\s*MAX_ATTEMPTS_PER_BATCH\b/u.test(requeueCode)
  ) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} MAX_ATTEMPTS_PER_BATCH must govern the production retry decision`,
    );
  }

  const failurePolicyVersion = rustConstString(
    runtime,
    "FAILURE_POLICY_VERSION",
  );
  if (failurePolicyVersion !== incremental.retryPolicy?.failurePolicyVersion) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} FAILURE_POLICY_VERSION ('${String(failurePolicyVersion)}') disagrees with policy ('${incremental.retryPolicy?.failurePolicyVersion}')`,
    );
  }

  const exportedCursorId = rustConstString(
    module,
    "INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID",
  );
  if (exportedCursorId !== incremental.cursorConsumerId) {
    errors.push(
      `${NARRATIVE_EXTRACTION_MOD_PATH} INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID ('${String(exportedCursorId)}') disagrees with policy ('${incremental.cursorConsumerId}')`,
    );
  }
  const cursorAlias = rustConstExpression(runtime, "CURSOR_CONSUMER_ID");
  if (cursorAlias?.code !== "INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID") {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} CURSOR_CONSUMER_ID must alias INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID`,
    );
  }
  const cursorCallContracts = [
    {
      symbol: "reserve_cursor_range_in_tx",
      functionName: "create_and_claim_batch_in_tx",
      arguments: [
        "conn",
        "project_id",
        "CURSOR_CONSUMER_ID",
        "semantic_epoch_id",
        "&run_id",
        "through_sequence",
      ],
    },
    {
      symbol: "acknowledge_cursor_reservation_in_tx",
      functionName: "publish_batch_in_tx",
      arguments: [
        "conn",
        "&batch.project_id",
        "CURSOR_CONSUMER_ID",
        "&batch.run_id",
        "&batch.semantic_epoch_id",
        "batch.through_sequence_inclusive",
      ],
    },
  ];
  for (const contract of cursorCallContracts) {
    const calls = findRustCalls(runtime, contract.symbol).filter(
      (call) => call.functionName === contract.functionName,
    );
    const call = calls[0];
    const callArguments =
      call?.arguments.filter(
        (argument) =>
          argument.code !== "" || argument.stringLiterals.length > 0,
      ) ?? [];
    if (
      calls.length !== 1 ||
      !call.bare ||
      rustFunctionShadowsSymbol(
        runtime,
        contract.functionName,
        contract.symbol,
        call.start,
      ) ||
      callArguments.length !== contract.arguments.length ||
      !contract.arguments.every(
        (expected, index) => callArguments[index]?.code === expected,
      )
    ) {
      errors.push(
        `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} CURSOR_CONSUMER_ID must bind exactly one canonical ${contract.symbol} call in ${contract.functionName} with the complete reservation identity`,
      );
    }
  }
  const releaseCursorCalls = findRustCalls(
    runtime,
    "release_cursor_reservation_in_tx",
  ).filter((call) => call.functionName === "reserve_or_resume_batch_in_tx");
  if (
    releaseCursorCalls.length !== 2 ||
    !releaseCursorCalls.every(
      (call) =>
        call.bare &&
        !rustFunctionShadowsSymbol(
          runtime,
          "reserve_or_resume_batch_in_tx",
          "release_cursor_reservation_in_tx",
          call.start,
        ) &&
        call.arguments[0]?.code === "conn" &&
        call.arguments[1]?.code === "&project_id" &&
        call.arguments[2]?.code === "CURSOR_CONSUMER_ID" &&
        call.arguments[3]?.code === "&active.run_id" &&
        /^active\.semantic_epoch_id(?:\.as_deref\(\)\.ok_or_else\([\s\S]*\)\?)?$/u.test(
          call.arguments[4]?.code ?? "",
        ) &&
        call.arguments[5]?.code === "active.through_sequence",
    )
  ) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} CURSOR_CONSUMER_ID must bind exactly two canonical release_cursor_reservation_in_tx recovery calls in reserve_or_resume_batch_in_tx`,
    );
  }

  const taskKind = rustConstString(runtime, "TASK_KIND");
  if (taskKind !== INCREMENTAL_FRESHNESS_TASK_KIND) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} TASK_KIND must be '${INCREMENTAL_FRESHNESS_TASK_KIND}', got '${String(taskKind)}'`,
    );
  }
  const claimTaskCalls = findRustCalls(runtime, "claim_next_task").filter(
    (call) => call.functionName === "claim_reserved_batch_in_tx",
  );
  const claimTaskCall = claimTaskCalls[0];
  const bindsClaimedTask =
    claimTaskCalls.length === 1 &&
    claimTaskCall.bare &&
    !rustFunctionShadowsSymbol(
      runtime,
      "claim_reserved_batch_in_tx",
      "claim_next_task",
      claimTaskCall.start,
    ) &&
    claimTaskCall.arguments[0]?.code === "conn" &&
    /^&ClaimTaskPayload\s*\{[\s\S]*\btask_kinds\s*:\s*Some\s*\(\s*vec!\s*\[\s*TASK_KIND\.to_string\(\)\s*\]\s*\)[\s\S]*\}$/u.test(
      claimTaskCall.arguments[1]?.code ?? "",
    );
  if (!bindsClaimedTask) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} TASK_KIND must bind claim_next_task in claim_reserved_batch_in_tx`,
    );
  }

  const taskInsertCalls = findRustCalls(runtime, "execute").filter((call) => {
    const sql = rustArgumentString(call.arguments[0]);
    return (
      call.functionName === "ensure_batch_task_in_tx" &&
      call.receiverCode === "conn" &&
      typeof sql === "string" &&
      /\bINSERT\b[\s\S]*\bnarrative_extraction_tasks\b/iu.test(sql)
    );
  });
  const taskInsertParams =
    taskInsertCalls.length === 1
      ? rustCollectionArguments(runtime, taskInsertCalls[0].arguments[1])
      : [];
  if (
    taskInsertCalls.length !== 1 ||
    !/\(\s*id\s*,\s*run_id\s*,\s*task_kind\b[\s\S]*\)\s*VALUES\s*\(\s*\?1\s*,\s*\?2\s*,\s*\?3\b/iu.test(
      rustArgumentString(taskInsertCalls[0]?.arguments[0]) ?? "",
    ) ||
    taskInsertParams[2]?.code !== "TASK_KIND"
  ) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} TASK_KIND must bind parameter ?3 of exactly one canonical task INSERT in ensure_batch_task_in_tx`,
    );
  }

  const ensureTaskCalls = findRustCalls(
    runtime,
    "ensure_batch_task_in_tx",
  ).filter((call) => call.functionName === "create_and_claim_batch_in_tx");
  if (
    ensureTaskCalls.length !== 1 ||
    !ensureTaskCalls[0].bare ||
    ensureTaskCalls[0].arguments[0]?.code !== "conn" ||
    ensureTaskCalls[0].arguments[1]?.code !== "&run_id" ||
    ensureTaskCalls[0].arguments[2]?.code !== "&change_set_id" ||
    ensureTaskCalls[0].arguments[3]?.code !== "acknowledged" ||
    ensureTaskCalls[0].arguments[4]?.code !== "through_sequence"
  ) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} TASK_KIND task creation requires exactly one canonical ensure_batch_task_in_tx call in create_and_claim_batch_in_tx`,
    );
  }

  const expiredAttemptQueries = findRustCalls(runtime, "query_row").filter(
    (call) => call.functionName === "resume_active_batch_in_tx",
  );
  const expiredAttemptParams =
    expiredAttemptQueries.length === 1
      ? rustCollectionArguments(runtime, expiredAttemptQueries[0].arguments[1])
      : [];
  if (
    expiredAttemptQueries.length !== 1 ||
    expiredAttemptQueries[0].receiverCode !== "conn" ||
    !/\bFROM\s+narrative_extraction_tasks\b[\s\S]*\brun_id\s*=\s*\?1\b[\s\S]*\btask_kind\s*=\s*\?2\b[\s\S]*\battempt_count\s*>=\s*\?3\b/iu.test(
      rustArgumentString(expiredAttemptQueries[0]?.arguments[0]) ?? "",
    ) ||
    expiredAttemptParams[1]?.code !== "TASK_KIND" ||
    expiredAttemptParams[2]?.code !== "MAX_ATTEMPTS_PER_BATCH"
  ) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} expired-attempt terminalization must bind TASK_KIND and MAX_ATTEMPTS_PER_BATCH to the canonical resume_active_batch_in_tx comparison`,
    );
  }

  const createRunCalls = findRustCalls(runtime, "create_system_run_in_tx");
  const canonicalCreateRunCalls = createRunCalls.filter(
    (call) => call.functionName === "create_and_claim_batch_in_tx",
  );
  if (
    canonicalCreateRunCalls.length !== 1 ||
    !(
      rustArgumentString(canonicalCreateRunCalls[0].arguments[2]) ===
        incremental.existingRunKindColumnValue &&
      canonicalCreateRunCalls[0].bare &&
      !rustFunctionShadowsSymbol(
        runtime,
        "create_and_claim_batch_in_tx",
        "create_system_run_in_tx",
        canonicalCreateRunCalls[0].start,
      ) &&
      canonicalCreateRunCalls[0].arguments[7]?.code ===
        "SystemRunWorkKeyReuse::RunningOnly"
    )
  ) {
    errors.push(
      `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} create_and_claim_batch_in_tx must have exactly one canonical create_system_run_in_tx call with Run kind '${incremental.existingRunKindColumnValue}' (freshness-evaluation) and SystemRunWorkKeyReuse::RunningOnly`,
    );
  }
}

function rustStatementEnd(code, start, limit) {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let cursor = start; cursor < limit; cursor += 1) {
    const current = code[cursor];
    if (current === "(") parenDepth += 1;
    else if (current === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (current === "[") bracketDepth += 1;
    else if (current === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (current === "{") braceDepth += 1;
    else if (current === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (
      current === ";" &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return cursor + 1;
    }
  }
  return limit;
}

function rustCollectionArguments(scan, argument) {
  if (!argument) return [];
  const productionCode = maskCfgTestItems(scan.code);
  const open = productionCode.indexOf("[", argument.start);
  if (open < 0 || open >= argument.end) return [];
  const ranges = [];
  let itemStart = open + 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let cursor = open + 1; cursor < argument.end; cursor += 1) {
    const current = productionCode[cursor];
    if (current === "(") parenDepth += 1;
    else if (current === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (current === "[") bracketDepth += 1;
    else if (current === "]") {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        ranges.push({ start: itemStart, end: cursor });
        break;
      }
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (current === "{") braceDepth += 1;
    else if (current === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (
      current === "," &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      ranges.push({ start: itemStart, end: cursor });
      itemStart = cursor + 1;
    }
  }
  return ranges
    .map((range) => ({
      ...range,
      code: productionCode.slice(range.start, range.end).trim(),
      source: scan.source.slice(range.start, range.end).trim(),
      stringLiterals: scan.stringLiterals.filter(
        (literal) => literal.start >= range.start && literal.end <= range.end,
      ),
    }))
    .filter((item) => item.code !== "" || item.stringLiterals.length > 0);
}

function rustInitializerExpression(scan, expression, callStart) {
  if (!expression) return null;
  if (expression.stringLiterals.length > 0) {
    return {
      code: expression.code,
      literals: expression.stringLiterals,
      identifier: null,
      reassigned: false,
    };
  }
  const identifier = expression.code.match(
    /^&?(?:mut\s+)?([a-zA-Z_][a-zA-Z0-9_]*)$/u,
  )?.[1];
  if (!identifier) return null;

  const productionCode = maskCfgTestItems(scan.code);
  const functions = findRustFunctions(productionCode);
  const enclosing = enclosingRustFunction(functions, callStart);
  if (!enclosing) return null;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const assignmentPattern = new RegExp(
    `\\blet\\s+(?:mut\\s+)?${escaped}(?:\\s*:[^=;]+)?\\s*=`,
    "gu",
  );
  const assignments = [
    ...productionCode
      .slice(enclosing.bodyStart, callStart)
      .matchAll(assignmentPattern),
  ];
  const assignment = assignments.at(-1);
  if (!assignment) return null;
  const assignmentStart = enclosing.bodyStart + assignment.index;
  const valueStart = assignmentStart + assignment[0].length;
  const end = rustStatementEnd(productionCode, valueStart, callStart);
  const reassignmentPattern = new RegExp(
    `\\b${escaped}\\s*(?:[+\\-*/%]?=)(?!=)`,
    "u",
  );
  return {
    code: productionCode.slice(valueStart, end).trim(),
    literals: scan.stringLiterals.filter(
      (literal) => literal.start >= valueStart && literal.end <= end,
    ),
    identifier,
    reassigned: reassignmentPattern.test(productionCode.slice(end, callStart)),
  };
}

function rustInitializerLiterals(scan, expression, callStart) {
  return rustInitializerExpression(scan, expression, callStart)?.literals ?? [];
}

function rustAssignedCallResultIdentifier(scan, call) {
  const productionCode = maskCfgTestItems(scan.code);
  const functions = findRustFunctions(productionCode);
  const enclosing = enclosingRustFunction(functions, call.start);
  if (!enclosing) return null;
  const statementStart = Math.max(
    enclosing.bodyStart + 1,
    productionCode.lastIndexOf(";", call.start - 1) + 1,
  );
  const beforeCall = productionCode.slice(statementStart, call.start);
  return (
    beforeCall.match(
      /\blet\s+(?:mut\s+)?([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:[^=;]+)?\s*=\s*(?:[a-zA-Z_][a-zA-Z0-9_]*\s*\.\s*)?$/su,
    )?.[1] ?? null
  );
}

function rustSqlWriteCandidates(scan) {
  const executeCalls = findRustCalls(scan, "execute");
  const candidates = executeCalls
    .filter((call) => call.receiverCode === "conn")
    .map((call) => ({
      call,
      sqlExpression: call.arguments[0],
      paramsExpression: call.arguments[1],
    }));

  for (const call of findRustCalls(scan, "execute_batch")) {
    if (call.receiverCode !== "conn") continue;
    candidates.push({
      call,
      sqlExpression: call.arguments[0],
      paramsExpression: null,
    });
  }

  for (const prepareCall of findRustCalls(scan, "prepare")) {
    if (prepareCall.receiverCode !== "conn") continue;
    const statement = rustAssignedCallResultIdentifier(scan, prepareCall);
    if (!statement) continue;
    const execution = executeCalls.find(
      (call) =>
        call.functionName === prepareCall.functionName &&
        call.start > prepareCall.start &&
        call.receiverCode === statement,
    );
    if (!execution) continue;
    candidates.push({
      call: execution,
      sqlExpression: prepareCall.arguments[0],
      paramsExpression: execution.arguments[0],
    });
  }

  return candidates;
}

function sqlParenthesizedContent(sql, open) {
  if (sql[open] !== "(") return null;
  let depth = 0;
  let quote = null;
  for (let cursor = open; cursor < sql.length; cursor += 1) {
    const current = sql[cursor];
    if (quote !== null) {
      if (current === quote) {
        if (sql[cursor + 1] === quote) {
          cursor += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
    } else if (current === "(") {
      depth += 1;
    } else if (current === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, cursor);
    }
  }
  return null;
}

function splitSqlList(source) {
  const items = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const current = source[cursor];
    if (quote !== null) {
      if (current === quote) {
        if (source[cursor + 1] === quote) cursor += 1;
        else quote = null;
      }
      continue;
    }
    if (current === "'" || current === '"') quote = current;
    else if (current === "(") depth += 1;
    else if (current === ")") depth = Math.max(0, depth - 1);
    else if (current === "," && depth === 0) {
      items.push(source.slice(start, cursor).trim());
      start = cursor + 1;
    }
  }
  items.push(source.slice(start).trim());
  return items;
}

function sqlFailurePersistenceAssignments(sql) {
  const setClause = sql.match(
    /\bUPDATE\b[\s\S]*?\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/iu,
  )?.[1];
  if (setClause) {
    if (!/\bfailure_code\b/iu.test(setClause)) return [];
    return [
      {
        failureValue: setClause.match(/\bfailure_code\s*=\s*([^,\n]+)/iu)?.[1],
        policyVersionValue: setClause.match(
          /\bpolicy_version\s*=\s*([^,\n]+)/iu,
        )?.[1],
      },
    ];
  }

  const insert = sql.match(/\b(?:INSERT|REPLACE)\b[\s\S]*?\bINTO\b/iu);
  if (!insert) return [];
  const columnsOpen = sql.indexOf("(", insert.index + insert[0].length);
  if (columnsOpen < 0) {
    return /\bfailure_code\b/iu.test(sql)
      ? [{ failureValue: undefined, policyVersionValue: undefined }]
      : [];
  }
  const columnsSource = sqlParenthesizedContent(sql, columnsOpen);
  if (columnsSource === null) {
    return /\bfailure_code\b/iu.test(sql)
      ? [{ failureValue: undefined, policyVersionValue: undefined }]
      : [];
  }
  const columnsClose = columnsOpen + columnsSource.length + 2;
  const columns = splitSqlList(columnsSource).map((column) =>
    column
      .replaceAll(/["'`\[\]]/gu, "")
      .trim()
      .toLowerCase(),
  );
  const failureIndex = columns.indexOf("failure_code");
  const policyVersionIndex = columns.indexOf("policy_version");
  if (failureIndex < 0) return [];

  const valuesMatch = /\bVALUES\b/iu.exec(sql.slice(columnsClose));
  if (!valuesMatch) {
    // INSERT ... SELECT and other write shapes are deliberately unsupported:
    // once failure_code is a target column, ambiguity must fail closed.
    return [{ failureValue: undefined, policyVersionValue: undefined }];
  }
  let cursor = columnsClose + valuesMatch.index + valuesMatch[0].length;
  const assignments = [];
  while (cursor < sql.length) {
    cursor = skipRustWhitespace(sql, cursor);
    if (sql[cursor] === ",") {
      cursor = skipRustWhitespace(sql, cursor + 1);
    }
    if (sql[cursor] !== "(") break;
    const valuesSource = sqlParenthesizedContent(sql, cursor);
    if (valuesSource === null) {
      assignments.push({
        failureValue: undefined,
        policyVersionValue: undefined,
      });
      break;
    }
    const values = splitSqlList(valuesSource);
    assignments.push({
      failureValue: values[failureIndex],
      policyVersionValue:
        policyVersionIndex < 0 ? null : values[policyVersionIndex],
    });
    cursor += valuesSource.length + 2;
  }
  return assignments.length > 0
    ? assignments
    : [{ failureValue: undefined, policyVersionValue: undefined }];
}

function incrementalFailurePersistenceRecord(scan, candidate, assignment) {
  const failureCodePattern = /\bNEX_INCREMENTAL_FRESHNESS_[A-Z0-9_]+\b/gu;
  const { call } = candidate;
  const failureValue = assignment.failureValue;
  if (failureValue && /^NULL\b/iu.test(failureValue.trim())) return null;

  const params = rustCollectionArguments(scan, candidate.paramsExpression);
  const failureCodes = new Set(
    typeof failureValue === "string"
      ? [...failureValue.matchAll(failureCodePattern)].map((match) => match[0])
      : [],
  );
  const failurePlaceholder = failureValue?.match(/^\s*\?(\d+)\b/u);
  let interpretableFailureCode = failureCodes.size > 0;
  let canonicalRetryBranchMapping = true;
  if (failurePlaceholder) {
    const parameter = params[Number(failurePlaceholder[1]) - 1];
    const initializer = rustInitializerExpression(scan, parameter, call.start);
    const terminalInitializer = rustInitializerExpression(
      scan,
      {
        code: "terminal",
        stringLiterals: [],
      },
      call.start,
    );
    const usesCanonicalTerminalDecision =
      terminalInitializer?.identifier === "terminal" &&
      !terminalInitializer.reassigned &&
      /^attempt_count\s*>=\s*MAX_ATTEMPTS_PER_BATCH\s*;?$/u.test(
        terminalInitializer.code,
      );
    const isCanonicalRetryBranch =
      initializer?.identifier !== null &&
      !initializer?.reassigned &&
      usesCanonicalTerminalDecision &&
      /^if\s+terminal\s*\{\s*\}\s*else\s*\{\s*\}\s*;?$/su.test(
        initializer?.code ?? "",
      ) &&
      initializer.literals.length === 2;
    const isDirectFailureLiteral =
      initializer?.identifier === null && initializer.literals.length === 1;
    if (isCanonicalRetryBranch || isDirectFailureLiteral) {
      const extracted = [];
      for (const literal of initializer.literals) {
        const matches = [...literal.value.matchAll(failureCodePattern)];
        if (matches.length !== 1 || matches[0][0] !== literal.value) continue;
        extracted.push(matches[0][0]);
        failureCodes.add(matches[0][0]);
      }
      interpretableFailureCode =
        extracted.length === initializer.literals.length;
      if (isCanonicalRetryBranch && extracted.length === 2) {
        canonicalRetryBranchMapping =
          extracted[0] === "NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED" &&
          extracted[1] === "NEX_INCREMENTAL_FRESHNESS_RETRYABLE";
      }
    } else {
      interpretableFailureCode = false;
    }
  }

  const policyVersionPlaceholder =
    assignment.policyVersionValue?.match(/^\s*\?(\d+)\b/u);
  const policyVersionParameter = policyVersionPlaceholder
    ? params[Number(policyVersionPlaceholder[1]) - 1]
    : null;
  return {
    call,
    failureCodes,
    interpretableSql: true,
    interpretableFailureCode,
    canonicalRetryBranchMapping,
    bindsCanonicalPolicyVersion:
      policyVersionParameter?.code === "FAILURE_POLICY_VERSION",
  };
}

function incrementalFailurePersistence(scan) {
  const records = [];
  const failureCodePattern = /\bNEX_INCREMENTAL_FRESHNESS_[A-Z0-9_]+\b/gu;
  for (const candidate of rustSqlWriteCandidates(scan)) {
    const sqlLiterals = rustInitializerLiterals(
      scan,
      candidate.sqlExpression,
      candidate.call.start,
    );
    if (sqlLiterals.length !== 1) {
      records.push({
        call: candidate.call,
        failureCodes: new Set(
          sqlLiterals.flatMap((literal) =>
            [...literal.value.matchAll(failureCodePattern)].map(
              (match) => match[0],
            ),
          ),
        ),
        interpretableSql: false,
        interpretableFailureCode: false,
        canonicalRetryBranchMapping: false,
        bindsCanonicalPolicyVersion: false,
      });
      continue;
    }
    const assignments = sqlFailurePersistenceAssignments(sqlLiterals[0].value);
    for (const assignment of assignments) {
      const record = incrementalFailurePersistenceRecord(
        scan,
        candidate,
        assignment,
      );
      if (record) records.push(record);
    }
  }

  return records;
}

function validateIncrementalFreshnessFailurePolicy(policy, repoRoot, errors) {
  if (!isObject(policy) || !Array.isArray(policy.runKinds)) return;
  const incremental = policy.runKinds.find(
    (entry) => entry?.runKind === "incremental-freshness",
  );
  if (!isObject(incremental) || !isObject(incremental.retryPolicy)) return;

  const failurePolicy = readJson(
    repoRoot,
    FAILURE_POLICY_PATH,
    errors,
    "Narrative failure policy",
  );
  if (!isObject(failurePolicy) || !Array.isArray(failurePolicy.policies)) {
    return;
  }

  const runtimeSource = readSource(
    repoRoot,
    INCREMENTAL_FRESHNESS_RUNTIME_PATH,
    errors,
    "Incremental Freshness Rust runtime",
  );
  if (runtimeSource !== null) {
    const scan = scanRustSource(runtimeSource);
    const persistence = incrementalFailurePersistence(scan);
    const persistedCodes = new Set(
      persistence.flatMap((record) => [...record.failureCodes]),
    );

    for (const record of persistence) {
      if (!record.interpretableSql) {
        errors.push(
          `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} production SQL expression in ${record.call.functionName ?? "an unknown function"} is not one statically interpretable literal; failure persistence validation must fail closed`,
        );
      } else if (!record.interpretableFailureCode) {
        errors.push(
          `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} failure persistence in ${record.call.functionName ?? "an unknown function"} has a failure_code assignment that cannot be tied to the canonical retry branch or one exact incremental Freshness code`,
        );
      }
      if (!record.canonicalRetryBranchMapping) {
        errors.push(
          `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} failure persistence retry branch must map terminal to NEX_INCREMENTAL_FRESHNESS_RETRY_EXHAUSTED and non-terminal to NEX_INCREMENTAL_FRESHNESS_RETRYABLE`,
        );
      }
      if (!record.bindsCanonicalPolicyVersion) {
        errors.push(
          `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} failure persistence in ${record.call.functionName ?? "an unknown function"} must bind the same UPDATE's policy_version placeholder to canonical FAILURE_POLICY_VERSION`,
        );
      }
    }

    for (const failureCode of INCREMENTAL_FRESHNESS_FAILURE_CODES.keys()) {
      if (!persistedCodes.has(failureCode)) {
        errors.push(
          `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} does not persist required failure code ${failureCode}`,
        );
      }
    }

    const registeredIncrementalCodes = new Set(
      failurePolicy.policies
        .map((entry) => entry?.failureCode)
        .filter(
          (failureCode) =>
            typeof failureCode === "string" &&
            /^NEX_INCREMENTAL_FRESHNESS_[A-Z0-9_]+$/u.test(failureCode),
        ),
    );
    for (const failureCode of registeredIncrementalCodes) {
      if (!persistedCodes.has(failureCode)) {
        errors.push(
          `${failureCode} is registered in ${FAILURE_POLICY_PATH} but not persisted by runtime; the registry and production persistence sets must match exactly`,
        );
      }
    }

    for (const failureCode of persistedCodes) {
      const expectedDisposition =
        INCREMENTAL_FRESHNESS_FAILURE_CODES.get(failureCode);
      if (expectedDisposition === undefined) {
        errors.push(
          `${INCREMENTAL_FRESHNESS_RUNTIME_PATH} persists unrecognized incremental Freshness failure code ${failureCode}; the production persistence set must exactly match the three validator-owned codes`,
        );
      }
      const registration = failurePolicy.policies.find(
        (entry) => entry?.failureCode === failureCode,
      );
      if (!isObject(registration)) {
        errors.push(
          `${failureCode} persisted by ${INCREMENTAL_FRESHNESS_RUNTIME_PATH} is not registered in ${FAILURE_POLICY_PATH}`,
        );
        continue;
      }
      if (
        expectedDisposition !== undefined &&
        registration.retryDisposition !== expectedDisposition
      ) {
        errors.push(
          `${failureCode} persisted by ${INCREMENTAL_FRESHNESS_RUNTIME_PATH} must be '${expectedDisposition}' in ${FAILURE_POLICY_PATH}, got '${registration.retryDisposition}'`,
        );
      }
      if (
        registration.policyVersion !==
        incremental.retryPolicy.failurePolicyVersion
      ) {
        errors.push(
          `${failureCode} persisted by ${INCREMENTAL_FRESHNESS_RUNTIME_PATH} must use policyVersion '${incremental.retryPolicy.failurePolicyVersion}' in ${FAILURE_POLICY_PATH}, got '${registration.policyVersion}'`,
        );
      }
      if (
        registration.maxAttempts !== incremental.retryPolicy.maxAttemptsPerTask
      ) {
        errors.push(
          `${failureCode} persisted by ${INCREMENTAL_FRESHNESS_RUNTIME_PATH} must use maxAttempts ${incremental.retryPolicy.maxAttemptsPerTask} in ${FAILURE_POLICY_PATH}, got '${registration.maxAttempts}'`,
        );
      }
    }
  }

  const registered = failurePolicy.policies.find(
    (entry) =>
      entry?.failureCode === incremental.retryPolicy.exhaustedFailureCode,
  );
  if (!isObject(registered)) {
    errors.push(
      `incremental-freshness.retryPolicy.exhaustedFailureCode '${incremental.retryPolicy.exhaustedFailureCode}' is not registered in ${FAILURE_POLICY_PATH}`,
    );
    return;
  }
  if (
    registered.retryDisposition !==
    incremental.retryPolicy.exhaustedRetryDisposition
  ) {
    errors.push(
      `incremental-freshness retry exhaustion disposition '${incremental.retryPolicy.exhaustedRetryDisposition}' disagrees with ${FAILURE_POLICY_PATH} ('${registered.retryDisposition}')`,
    );
  }
  if (
    registered.policyVersion !== incremental.retryPolicy.failurePolicyVersion
  ) {
    errors.push(
      `incremental-freshness retry failure policy version '${incremental.retryPolicy.failurePolicyVersion}' disagrees with ${FAILURE_POLICY_PATH} ('${registered.policyVersion}')`,
    );
  }
  if (registered.maxAttempts !== incremental.retryPolicy.maxAttemptsPerTask) {
    errors.push(
      `incremental-freshness retry max attempts '${incremental.retryPolicy.maxAttemptsPerTask}' disagrees with ${FAILURE_POLICY_PATH} ('${registered.maxAttempts}')`,
    );
  }
}

function validateAgainstSchema(repoRoot, schemaName, contractName, errors) {
  const schema = readJson(
    repoRoot,
    `policies/narrative/schemas/${schemaName}`,
    errors,
    `policy JSON Schema ${schemaName}`,
  );
  const contract = readJson(
    repoRoot,
    `policies/narrative/${contractName}`,
    errors,
    `policy contract ${contractName}`,
  );
  if (!schema || !contract) return contract;
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (!validate(contract)) {
      errors.push(
        `${schemaName} rejects ${contractName}: ${ajv.errorsText(validate.errors)}`,
      );
    }
  } catch (error) {
    errors.push(
      `${schemaName} could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return contract;
}

function extractSqlRunKindValues(repoRoot, errors) {
  const absolute = path.join(repoRoot, MIGRATE_RS_PATH);
  if (!existsSync(absolute)) {
    errors.push(`migrate.rs is missing: ${MIGRATE_RS_PATH}`);
    return null;
  }
  const source = readFileSync(absolute, "utf8");
  const scan = scanRustSource(source);
  const testOnlyRanges = cfgTestItemRanges(scan.code);
  const productionSqlLiterals = scan.stringLiterals.filter(
    (literal) =>
      !testOnlyRanges.some(
        (range) => literal.start >= range.start && literal.end <= range.end,
      ),
  );
  const matches = productionSqlLiterals.flatMap((literal) => [
    ...literal.value.matchAll(RUN_KIND_CHECK_PATTERN),
  ]);
  if (matches.length === 0) {
    errors.push(
      `could not find a 'CHECK(run_kind IN (...))' constraint in ${MIGRATE_RS_PATH}`,
    );
    return null;
  }
  const sets = matches.map(
    (match) =>
      new Set([...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1])),
  );
  // Migration declarations are chronological. Earlier rebuild statements
  // retain their historical (possibly narrower) CHECK verbatim, while the
  // final production occurrence is the current schema authority. Choosing a
  // merely widest occurrence would let an older declaration hide accidental
  // narrowing in the current rebuild.
  const canonical = sets.at(-1);
  for (const [index, set] of sets.slice(0, -1).entries()) {
    const isSubset = [...set].every((value) => canonical.has(value));
    if (!isSubset) {
      errors.push(
        `migrate.rs historical occurrence ${index + 1} of 'CHECK(run_kind IN (...))' contains a value absent from the current production occurrence ` +
          `(${[...canonical].join(", ")}); historical CHECKs must stay subsets of the final current schema declaration`,
      );
    }
  }
  return canonical;
}

function validateRunKinds(policy, sqlRunKindValues, errors, repoRoot) {
  if (!isObject(policy) || !Array.isArray(policy.runKinds)) return;
  const rustFiles = repoRoot ? collectRustFiles(repoRoot) : [];
  const seen = new Set();
  for (const entry of policy.runKinds) {
    if (!isObject(entry) || !isNonEmptyString(entry.runKind)) continue;
    if (seen.has(entry.runKind)) {
      errors.push(`duplicate runKind: ${entry.runKind}`);
    }
    seen.add(entry.runKind);

    if (repoRoot) {
      validateImplementationStatus(entry, rustFiles, repoRoot, errors);
    }

    if (entry.existingRunKindColumnValue !== null) {
      if (
        sqlRunKindValues &&
        !sqlRunKindValues.has(entry.existingRunKindColumnValue)
      ) {
        errors.push(
          `${entry.runKind}.existingRunKindColumnValue ('${entry.existingRunKindColumnValue}') is not a value the real 'run_kind' CHECK constraint in ${MIGRATE_RS_PATH} accepts`,
        );
      }
    }

    if (entry.runKind === "incremental-freshness") {
      if (entry.existingRunKindColumnValue !== "freshness-evaluation") {
        errors.push(
          "incremental-freshness.existingRunKindColumnValue must be 'freshness-evaluation'",
        );
      }
      if (entry.cursorBound !== true) {
        errors.push("incremental-freshness.cursorBound must be true");
      }
      if (entry.cursorConsumerId !== INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID) {
        errors.push(
          `incremental-freshness.cursorConsumerId must be '${INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID}'`,
        );
      }
      if (
        entry.maxCanonicalSequencesPerBatch !== INCREMENTAL_FRESHNESS_BATCH_SIZE
      ) {
        errors.push(
          `incremental-freshness.maxCanonicalSequencesPerBatch must be ${INCREMENTAL_FRESHNESS_BATCH_SIZE}`,
        );
      }
      if (entry.executionAuthority !== "serialized-live-workspace-authority") {
        errors.push(
          "incremental-freshness.executionAuthority must be 'serialized-live-workspace-authority'",
        );
      }
      if (
        entry.missingSemanticEpochBehavior !==
        "wait-for-canonical-epoch-authority"
      ) {
        errors.push(
          "incremental-freshness.missingSemanticEpochBehavior must be 'wait-for-canonical-epoch-authority'",
        );
      }
      for (const [field, expected] of Object.entries(
        INCREMENTAL_FRESHNESS_RETRY_POLICY,
      )) {
        if (entry.retryPolicy?.[field] !== expected) {
          errors.push(
            `incremental-freshness.retryPolicy.${field} must be '${expected}'`,
          );
        }
      }
      if (entry.writes !== "rebuildable-state-only") {
        errors.push(
          "incremental-freshness.writes must be 'rebuildable-state-only'",
        );
      }
      if (entry.sameWorkKeyReuse !== "reuse-running-only") {
        errors.push(
          "incremental-freshness.sameWorkKeyReuse must be 'reuse-running-only'",
        );
      }
      if (
        !sameStringArray(
          entry.resumeSemantics,
          INCREMENTAL_FRESHNESS_RESUME_SEMANTICS,
        )
      ) {
        errors.push(
          "incremental-freshness.resumeSemantics must pin only sealed-range reclaim and running Run/Task/Attempt resume; completed replay reuse is forbidden",
        );
      }
      if (
        entry.completedWithUnackedRangeInvariant !==
        INCREMENTAL_FRESHNESS_COMPLETED_UNACKED_INVARIANT
      ) {
        errors.push(
          `incremental-freshness.completedWithUnackedRangeInvariant must be '${INCREMENTAL_FRESHNESS_COMPLETED_UNACKED_INVARIANT}'`,
        );
      }
      if (
        !sameStringArray(
          entry.writesAllowed,
          INCREMENTAL_FRESHNESS_WRITES_ALLOWED,
        )
      ) {
        errors.push(
          "incremental-freshness.writesAllowed must contain only its declared operational and rebuildable-state writes",
        );
      }
      for (const forbiddenWrite of ["domain-state", "attention"]) {
        if (!entry.forbiddenWrites?.includes(forbiddenWrite)) {
          errors.push(
            `incremental-freshness.forbiddenWrites must include '${forbiddenWrite}'`,
          );
        }
      }
      if (
        entry.implementationStatus?.triggerSymbol !==
        "run_incremental_freshness_cycle"
      ) {
        errors.push(
          "incremental-freshness.implementationStatus.triggerSymbol must be 'run_incremental_freshness_cycle'",
        );
      }
      if (
        !sameStringArray(entry.implementationStatus?.productionEntryPoints, [
          "run_narrative_freshness_cycle",
        ])
      ) {
        errors.push(
          "incremental-freshness.implementationStatus.productionEntryPoints must name only 'run_narrative_freshness_cycle'",
        );
      }
    } else if (entry.cursorBound !== false) {
      errors.push(
        `${entry.runKind}.cursorBound must be false; only incremental-freshness may bind a Run to a Change Feed cursor`,
      );
    }

    // Every automatic trigger must say when it fires; every manual-only
    // Run Kind must say so via trigger, not bury it in prose only.
    if (
      entry.trigger === "automatic-on-trigger-event" &&
      (!Array.isArray(entry.triggerEvents) || entry.triggerEvents.length === 0)
    ) {
      errors.push(
        `${entry.runKind} declares trigger 'automatic-on-trigger-event' but has no triggerEvents`,
      );
    }
    if (
      entry.trigger === "automatic-when-derived-state-absent-or-invalid" &&
      (!Array.isArray(entry.triggerEvents) || entry.triggerEvents.length === 0)
    ) {
      errors.push(
        `${entry.runKind} declares trigger 'automatic-when-derived-state-absent-or-invalid' but has no triggerEvents`,
      );
    }

    // Only the human-triggered Repair Run Kind may declare a
    // repair-shaped precondition/allow/forbid list; every other Run Kind
    // that carries one would blur the durable-declaration boundary this
    // contract exists to keep sharp.
    const repairOnlyFields = [
      "requiredPreconditions",
      "allowedRepairs",
      "forbiddenRepairs",
      "unrecoverableDisposition",
    ];
    if (entry.runKind !== "dependency-repair") {
      for (const field of repairOnlyFields) {
        if (entry[field] !== undefined) {
          errors.push(
            `${entry.runKind} must not declare '${field}'; only dependency-repair may`,
          );
        }
      }
    } else {
      for (const field of repairOnlyFields) {
        if (entry[field] === undefined) {
          errors.push(`dependency-repair is missing required field '${field}'`);
        }
      }
    }

    // Verify is diagnostics-only and must say so explicitly, plus declare
    // it never repairs as a side effect.
    if (entry.runKind === "dependency-verify") {
      if (entry.writes !== "diagnostics-only") {
        errors.push("dependency-verify.writes must be 'diagnostics-only'");
      }
      if (entry.forbidSideEffectRepair !== true) {
        errors.push(
          "dependency-verify must declare forbidSideEffectRepair: true",
        );
      }
    }

    // Rebuild Derived State must never claim it writes the durable graph
    // or Domain data.
    if (entry.runKind === "dependency-rebuild-derived") {
      if (entry.writes !== "rebuildable-state-only") {
        errors.push(
          "dependency-rebuild-derived.writes must be 'rebuildable-state-only'",
        );
      }
      if (
        !Array.isArray(entry.forbiddenWrites) ||
        entry.forbiddenWrites.length === 0
      ) {
        errors.push(
          "dependency-rebuild-derived must declare a non-empty forbiddenWrites list",
        );
      }
    }
  }

  for (const runKind of REQUIRED_RUN_KINDS) {
    if (!seen.has(runKind)) {
      errors.push(
        `narrative-run-kind-policy.json is missing runKind: ${runKind}`,
      );
    }
  }
  for (const runKind of seen) {
    if (!REQUIRED_RUN_KINDS.includes(runKind)) {
      errors.push(
        `narrative-run-kind-policy.json declares unexpected runKind: ${runKind}`,
      );
    }
  }
}

function validateApiSplitCoversAdminCommands(policy, errors) {
  if (!isObject(policy) || !isObject(policy.apiSplit)) return;
  const declaredOperations = new Set(policy.apiSplit.operations ?? []);
  for (const entry of policy.runKinds ?? []) {
    if (!isObject(entry) || !Array.isArray(entry.adminCommands)) continue;
    for (const command of entry.adminCommands) {
      if (!declaredOperations.has(command)) {
        errors.push(
          `${entry.runKind}.adminCommands references '${command}', which is not listed in apiSplit.operations`,
        );
      }
    }
  }
}

export function validateRunKindPolicy({ repoRoot = REPO_ROOT } = {}) {
  const errors = [];

  const policy = validateAgainstSchema(
    repoRoot,
    "narrative-run-kind-policy.schema.json",
    "narrative-run-kind-policy.json",
    errors,
  );
  const sqlRunKindValues = extractSqlRunKindValues(repoRoot, errors);

  validateRunKinds(policy, sqlRunKindValues, errors, repoRoot);
  validateApiSplitCoversAdminCommands(policy, errors);
  validateIncrementalFreshnessElectronWiring(policy, repoRoot, errors);
  validateIncrementalFreshnessRustContract(policy, repoRoot, errors);
  validateIncrementalFreshnessFailurePolicy(policy, repoRoot, errors);

  return { errors };
}

function main() {
  const result = validateRunKindPolicy();
  if (result.errors.length > 0) {
    console.error("Gate C2 Run Kind Policy is invalid:");
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("validate-run-kind-policy: ok");
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
