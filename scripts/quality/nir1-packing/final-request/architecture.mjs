// Architecture checks for the evaluation-only final-request packing hooks
// (DP-H, K6/2 nir1-final-request-packing-eval, "評価専用の呼び出し口" 1 and 9).
//
// The checks are read-only text checks over the repository's Rust, Cargo and
// TypeScript sources:
//
//   eval-feature-allowlist     every use of the evaluation feature or of the
//                              evaluation modules sits in a fixed place;
//   observation-calls          the two observation calls (c-1) and (c-2) are
//                              single shared-reference statements at a fixed
//                              position of a fixed function;
//   cargo-features             the feature is defined only in the two
//                              Cargo.toml files, enables nothing else, is not
//                              in `default` and is not enabled by another
//                              feature, dependency or release script;
//   not-reachable              the evaluation modules are not referenced from
//                              the N-API surface, the IPC contract, the
//                              preload, the main process or the renderer;
//   ts-packer                  the product TypeScript does not import the TS
//                              packer (`nir1Packing`);
//   build-capabilities         `get_native_build_capabilities` reports the
//                              feature and the release check expects `false`;
//   harness                    the DPH-4 harness is a `cfg(test)` module, its
//                              setup runs product writers only (no SQL write,
//                              no direct connection use, no seed helper of the
//                              D-final unit tests) and its only child process
//                              is `git`.
//
// The functions are pure over a `{ path -> text }` map so each rule has a
// negative test with a synthetic source. `loadRepositorySources` reads the
// real files.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const EVAL_FEATURE = "nir1-final-request-eval";
export const NODE_CAPABILITY_FLAG = "nir1FinalRequestEval";

export const PATHS = Object.freeze({
  dbCargo: "src-tauri/crates/grimodex-db/Cargo.toml",
  nodeCargo: "electron/native/grimodex-node/Cargo.toml",
  dbPacking:
    "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_packing.rs",
  dbNarrativeMod:
    "src-tauri/crates/grimodex-db/src/narrative_extraction/mod.rs",
  dbEvalDir:
    "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_packing/",
  nodePrepared: "electron/native/grimodex-node/src/nir1_prepared_request.rs",
  nodeLib: "electron/native/grimodex-node/src/lib.rs",
  nodeEvalDir: "electron/native/grimodex-node/src/nir1_final_request_eval/",
  nodeEvalMod:
    "electron/native/grimodex-node/src/nir1_final_request_eval/mod.rs",
  nodeHarnessDir:
    "electron/native/grimodex-node/src/nir1_final_request_eval/harness/",
  verifyRelease: "electron/scripts/verify-release-native.mjs",
});

/** Files whose whole content is the evaluation module. */
function isEvalModuleFile(file) {
  return (
    file.startsWith(PATHS.nodeEvalDir) ||
    file === `${PATHS.dbEvalDir}final_request_eval.rs` ||
    file.startsWith(`${PATHS.dbEvalDir}final_request_eval/`)
  );
}

const EVAL_IDENTIFIERS = Object.freeze([
  EVAL_FEATURE,
  "nir1_final_request_eval",
  "final_request_eval",
  NODE_CAPABILITY_FLAG,
]);

// ------------------------------------------------------------- Rust masking

/**
 * Same-length copy of a Rust source with comments (and, when `maskStrings`,
 * string and char literal contents) replaced by spaces. Newlines are kept so
 * offsets and line numbers stay valid.
 */
export function maskRust(source, { maskStrings }) {
  const out = source.split("");
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== "\n") out[index] = " ";
    }
  };
  let index = 0;
  while (index < source.length) {
    const rest = source[index] + (source[index + 1] ?? "");
    if (rest === "//") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
    } else if (rest === "/*") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      blank(index, cursor);
      index = cursor;
    } else if (
      source[index] === "r" &&
      (source[index + 1] === '"' || source[index + 1] === "#") &&
      /^r#*"/.test(source.slice(index, index + 80))
    ) {
      const hashes = /^r(#*)"/.exec(source.slice(index, index + 80))[1];
      const close = `"${hashes}`;
      const start = index + 2 + hashes.length;
      const end = source.indexOf(close, start);
      const stop = end === -1 ? source.length : end + close.length;
      if (maskStrings) blank(start, stop - close.length);
      index = stop;
    } else if (source[index] === '"') {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== '"') {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      if (maskStrings) blank(index + 1, cursor);
      index = cursor + 1;
    } else if (
      source[index] === "'" &&
      /^'(\\.[^']*|[^\\'])'/.test(source.slice(index, index + 12))
    ) {
      const length = /^'(\\.[^']*|[^\\'])'/.exec(
        source.slice(index, index + 12),
      )[0].length;
      if (maskStrings) blank(index + 1, index + length - 1);
      index += length;
    } else {
      index += 1;
    }
  }
  return out.join("");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regex matching `snippet` with any whitespace between its tokens. */
function snippetPattern(snippet, flags = "g") {
  const tokens = snippet.match(/[A-Za-z0-9_]+|"[^"]*"|[^\sA-Za-z0-9_"]/g);
  // rustfmt may add a trailing comma before a closing parenthesis.
  const parts = tokens.map((token) =>
    token === ")" ? ",?\\s*\\)" : escapeRegExp(token),
  );
  return new RegExp(parts.join("\\s*"), flags);
}

// --------------------------------------------------------------- the sites

/** The fixed observation statements (rustfmt may wrap them; tokens are fixed). */
export const SITES = Object.freeze({
  dbModDeclaration: {
    file: PATHS.dbPacking,
    snippet: `#[cfg(feature = "${EVAL_FEATURE}")] pub mod final_request_eval;`,
  },
  dbReExport: {
    file: PATHS.dbNarrativeMod,
    snippet: `#[cfg(feature = "${EVAL_FEATURE}")] pub use nir1_packing::final_request_eval;`,
  },
  c1: {
    file: PATHS.dbPacking,
    fn: "read_and_pack_native_a2_context_in_tx_with_raw_charge",
    before: "checkpoint()?;",
    statement: `#[cfg(feature = "${EVAL_FEATURE}")] final_request_eval::observe_candidate_set(&request, &items, &candidate_owners, &bindings, &raw_budget_charge);`,
    after: "let packed = pack_candidate_context(CandidatePackingRequest {",
    callee: "final_request_eval::observe_candidate_set",
    bareArguments: [],
  },
  nodeModDeclaration: {
    file: PATHS.nodePrepared,
    snippet: `#[cfg(feature = "${EVAL_FEATURE}")] #[path = "nir1_final_request_eval/mod.rs"] mod nir1_final_request_eval;`,
  },
  c2: {
    file: PATHS.nodePrepared,
    fn: "prepare_local_chat_request_inner",
    before: "checkpoint()?;",
    statement: `#[cfg(feature = "${EVAL_FEATURE}")] nir1_final_request_eval::observe_rendered(message_version_id, &projection, &route, &packing_context_budget_tokens, &rendered);`,
    after:
      "ensure!(rendered.canonical_payload.len() <= MAX_PREPARED_PAYLOAD_BYTES,",
    callee: "nir1_final_request_eval::observe_rendered",
    // `message_version_id` is already a `&NativeAcceptedChatSubmission`.
    bareArguments: ["message_version_id"],
  },
  buildCapability: {
    file: PATHS.nodeLib,
    snippet: `"${NODE_CAPABILITY_FLAG}": cfg!(feature = "${EVAL_FEATURE}"),`,
  },
});

const ALLOWED_SNIPPETS = Object.freeze({
  [PATHS.dbPacking]: [SITES.dbModDeclaration.snippet, SITES.c1.statement],
  [PATHS.dbNarrativeMod]: [SITES.dbReExport.snippet],
  [PATHS.nodePrepared]: [SITES.nodeModDeclaration.snippet, SITES.c2.statement],
  [PATHS.nodeLib]: [SITES.buildCapability.snippet],
});

const FEATURE_CFG = new RegExp(
  `(#\\s*\\[\\s*cfg(_attr)?\\b|\\bcfg!\\s*\\()[^\\n;{]*?${escapeRegExp(EVAL_FEATURE)}`,
);

/**
 * Every mention of the evaluation feature or modules outside the evaluation
 * module files must be one of the fixed snippets. Returns violations.
 */
export function checkEvalFeatureAllowlist(sources) {
  const violations = [];
  for (const [file, source] of Object.entries(sources)) {
    if (!file.endsWith(".rs") || isEvalModuleFile(file)) continue;
    // Most files never mention the feature or the modules: skip the masking.
    if (
      !EVAL_IDENTIFIERS.some((identifier) => source.includes(identifier)) &&
      !(file in ALLOWED_SNIPPETS)
    ) {
      continue;
    }
    let masked = maskRust(source, { maskStrings: false });
    for (const snippet of ALLOWED_SNIPPETS[file] ?? []) {
      masked = masked.replace(snippetPattern(snippet), (match) =>
        " ".repeat(match.length),
      );
    }
    for (const identifier of EVAL_IDENTIFIERS) {
      let from = 0;
      for (;;) {
        const index = masked.indexOf(identifier, from);
        if (index === -1) break;
        const line = masked.slice(0, index).split("\n").length;
        violations.push({
          rule: "eval-feature-allowlist",
          file,
          line,
          message: `\`${identifier}\` appears outside the allowlist`,
        });
        from = index + identifier.length;
      }
    }
    if (FEATURE_CFG.test(masked)) {
      violations.push({
        rule: "eval-feature-allowlist",
        file,
        message:
          "a #[cfg], cfg! or cfg_attr conditioned on the evaluation feature is outside the allowlist",
      });
    }
  }
  // Each allowlisted snippet must be present exactly once.
  for (const [file, snippets] of Object.entries(ALLOWED_SNIPPETS)) {
    const source = sources[file];
    if (source === undefined) {
      violations.push({
        rule: "eval-feature-allowlist",
        file,
        message: "an allowlisted file is missing",
      });
      continue;
    }
    const masked = maskRust(source, { maskStrings: false });
    for (const snippet of snippets) {
      const count = (masked.match(snippetPattern(snippet)) ?? []).length;
      if (count !== 1) {
        violations.push({
          rule: "eval-feature-allowlist",
          file,
          message: `the allowlisted site must appear exactly once (found ${count}): ${snippet.slice(0, 80)}`,
        });
      }
    }
  }
  return violations;
}

// ------------------------------------------------------ observation calls

/** The text of the body of `fn name` (between its braces), or `null`. */
export function functionBody(source, name) {
  const masked = maskRust(source, { maskStrings: true });
  const start = masked.search(new RegExp(`\\bfn\\s+${escapeRegExp(name)}\\b`));
  if (start === -1) return null;
  let cursor = masked.indexOf("(", start);
  let depth = 0;
  for (; cursor < masked.length; cursor += 1) {
    if (masked[cursor] === "(") depth += 1;
    if (masked[cursor] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const open = masked.indexOf("{", cursor);
  if (open === -1) return null;
  depth = 0;
  for (let end = open; end < masked.length; end += 1) {
    if (masked[end] === "{") depth += 1;
    if (masked[end] === "}") {
      depth -= 1;
      if (depth === 0) {
        return maskRust(source, { maskStrings: false }).slice(open + 1, end);
      }
    }
  }
  return null;
}

const squash = (text) => text.replace(/\s+/g, "").replace(/,\)/g, ")");

/**
 * One observation site: the function holds exactly the fixed attribute and
 * statement between the fixed previous and next statements, and the
 * statement is one call whose arguments are shared references.
 */
export function checkObservationSite(source, site, label) {
  const violations = [];
  const fail = (message) =>
    violations.push({
      rule: "observation-calls-are-single-shared-ref-statements",
      file: site.file,
      message: `${label}: ${message}`,
    });
  const body = functionBody(source, site.fn);
  if (body === null) {
    fail(`function \`${site.fn}\` was not found`);
    return violations;
  }
  const flat = squash(body);
  const expected = squash(`${site.before} ${site.statement} ${site.after}`);
  const occurrences = flat.split(expected).length - 1;
  if (occurrences !== 1) {
    fail(
      `the fixed sequence (previous statement, attribute, call, next statement) must appear exactly once in \`${site.fn}\` (found ${occurrences})`,
    );
  }
  const callCount = flat.split(squash(site.callee)).length - 1;
  if (callCount !== 1) {
    fail(`\`${site.callee}\` must be called exactly once (found ${callCount})`);
  }
  // The statement itself: `callee(arg, ...);` with shared-reference arguments.
  const statement = squash(site.statement).replace(/^#\[[^\]]*\]/, "");
  const shape = new RegExp(
    `^${escapeRegExp(squash(site.callee))}\\((.*)\\);$`,
  ).exec(statement);
  if (!shape) {
    fail("the statement is not one function call ending in `;`");
    return violations;
  }
  for (const argument of shape[1].split(",")) {
    const ok =
      /^&[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(argument) ||
      site.bareArguments.includes(argument);
    if (!ok || /^&mut/.test(argument)) {
      fail(`argument \`${argument}\` is not a shared reference`);
    }
  }
  if (/[?]|\.await|\bmove\b|=[^=]|\bif\b|\bmatch\b|\breturn\b/.test(shape[1])) {
    fail("the arguments contain a control-flow or assignment token");
  }
  return violations;
}

export function checkObservationCalls(sources) {
  const violations = [];
  for (const [label, site] of [
    ["(c-1)", SITES.c1],
    ["(c-2)", SITES.c2],
  ]) {
    const source = sources[site.file];
    if (source === undefined) {
      violations.push({
        rule: "observation-calls-are-single-shared-ref-statements",
        file: site.file,
        message: `${label}: the file is missing`,
      });
      continue;
    }
    violations.push(...checkObservationSite(source, site, label));
  }
  return violations;
}

// ------------------------------------------------------------ Cargo files

/** `{ section -> { key -> raw value text } }` of a Cargo.toml (no dependency). */
export function parseCargoSections(text) {
  const sections = {};
  let section = "";
  let pending = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (pending) {
      pending.value += ` ${line}`;
      if (line.includes("]") && !line.includes("[")) {
        sections[section][pending.key] = pending.value.trim();
        pending = null;
      }
      continue;
    }
    if (line === "") continue;
    const header = /^\[\[?([^\]]+)\]?\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      sections[section] ??= {};
      continue;
    }
    const pair = /^([A-Za-z0-9_."-]+)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    sections[section] ??= {};
    const open = (pair[2].match(/\[/g) ?? []).length;
    const close = (pair[2].match(/\]/g) ?? []).length;
    if (open > close) pending = { key: pair[1], value: pair[2] };
    else sections[section][pair[1]] = pair[2].trim();
  }
  return sections;
}

function listItems(value) {
  return [...(value ?? "").matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

export function checkCargoFeatures(sources) {
  const violations = [];
  const fail = (file, message) =>
    violations.push({ rule: "cargo-features", file, message });
  const expectedDefinitions = {
    [PATHS.dbCargo]: [],
    [PATHS.nodeCargo]: [`grimodex-db/${EVAL_FEATURE}`],
  };
  for (const [file, expectedItems] of Object.entries(expectedDefinitions)) {
    const text = sources[file];
    if (text === undefined) {
      fail(file, "the Cargo.toml is missing");
      continue;
    }
    const features = parseCargoSections(text).features ?? {};
    if (!(EVAL_FEATURE in features)) {
      fail(file, `the \`${EVAL_FEATURE}\` feature is not defined`);
      continue;
    }
    const items = listItems(features[EVAL_FEATURE]);
    if (
      JSON.stringify(items) !== JSON.stringify(expectedItems) ||
      !/^\[.*\]$/.test(features[EVAL_FEATURE])
    ) {
      fail(
        file,
        `\`${EVAL_FEATURE}\` must enable exactly ${JSON.stringify(expectedItems)} (found ${features[EVAL_FEATURE]})`,
      );
    }
    for (const [name, value] of Object.entries(features)) {
      if (name === EVAL_FEATURE) continue;
      if (listItems(value).some((item) => item.includes(EVAL_FEATURE))) {
        fail(file, `feature \`${name}\` enables the evaluation feature`);
      }
    }
    if (
      listItems(features.default).some((item) => item.includes(EVAL_FEATURE))
    ) {
      fail(file, "the evaluation feature is in `default`");
    }
    for (const [section, entries] of Object.entries(parseCargoSections(text))) {
      if (section === "features") continue;
      for (const [key, value] of Object.entries(entries)) {
        if (`${key} ${value}`.includes(EVAL_FEATURE)) {
          fail(
            file,
            `[${section}] \`${key}\` enables the evaluation feature outside its definition`,
          );
        }
      }
    }
  }
  for (const [file, text] of Object.entries(sources)) {
    if (!file.endsWith("Cargo.toml") || file in expectedDefinitions) continue;
    if (text.includes(EVAL_FEATURE)) {
      fail(file, "another Cargo.toml mentions the evaluation feature");
    }
  }
  // Release and packaging scripts never name the feature.
  for (const [file, text] of Object.entries(sources)) {
    if (!file.endsWith("package.json")) continue;
    let scripts = {};
    try {
      scripts = JSON.parse(text).scripts ?? {};
    } catch {
      continue;
    }
    for (const [name, command] of Object.entries(scripts)) {
      if (String(command).includes(EVAL_FEATURE) && !/test/.test(name)) {
        fail(
          file,
          `script \`${name}\` enables the evaluation feature outside a test script`,
        );
      }
      if (ALL_FEATURES_BUILD.test(String(command)) && !/test/.test(name)) {
        fail(
          file,
          `script \`${name}\` builds with \`--all-features\`, which enables the evaluation feature`,
        );
      }
    }
  }
  // CI workflows: a release or publish workflow never names the feature, and
  // no workflow builds (as opposed to checks or tests) with it or with
  // \`--all-features\`. Backslash continuations are joined before matching.
  for (const [file, text] of Object.entries(sources)) {
    if (!file.startsWith(".github/workflows/") || !/\.ya?ml$/.test(file))
      continue;
    const releaseLike = /release|publish|deploy|aur/.test(path.basename(file));
    const logical = text.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/);
    logical.forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      const names = line.includes(EVAL_FEATURE);
      if (releaseLike && names) {
        fail(
          `${file}:${index + 1}`,
          "a release or publish workflow names the evaluation feature",
        );
      } else if (
        (names || /--all-features/.test(line)) &&
        BUILD_COMMAND.test(line)
      ) {
        fail(
          `${file}:${index + 1}`,
          "a workflow builds with the evaluation feature or `--all-features`",
        );
      }
    });
  }
  return violations;
}

const BUILD_COMMAND = /\b(?:cargo|napi)\s+build\b|--release\b/;
const ALL_FEATURES_BUILD =
  /(?:\b(?:cargo|napi)\s+build\b|--release\b)[^&|;]*--all-features|--all-features[^&|;]*(?:\b(?:cargo|napi)\s+build\b|--release\b)/;

// ------------------------------------------------------------ reachability

const TS_PRODUCT_ROOTS = Object.freeze([
  "src/",
  "electron/shared/",
  "electron/preload/",
  "electron/main/",
]);
const REACH_IDENTIFIERS = Object.freeze([
  EVAL_FEATURE,
  NODE_CAPABILITY_FLAG,
  "nir1_final_request_eval",
  "final_request_eval",
  "observe_rendered",
  "observe_candidate_set",
  "run_dfinal_with_capture",
]);

function isTestFile(file) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /\/__tests__\//.test(file)
  );
}

function isProductTypeScript(file) {
  return (
    /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) &&
    !isTestFile(file) &&
    TS_PRODUCT_ROOTS.some((root) => file.startsWith(root))
  );
}

export function checkNotReachable(sources) {
  const violations = [];
  for (const [file, text] of Object.entries(sources)) {
    const isDeclaration =
      file === "electron/native/grimodex-node/index.d.ts" ||
      file.endsWith(".d.ts");
    if (!isProductTypeScript(file) && !isDeclaration) continue;
    for (const identifier of REACH_IDENTIFIERS) {
      if (text.includes(identifier)) {
        violations.push({
          rule: "eval-hooks-not-reachable-from-napi-ipc-preload",
          file,
          message: `\`${identifier}\` is referenced from the IPC contract, preload, main, renderer or N-API declarations`,
        });
      }
    }
  }
  // The N-API surface (`#[napi]` items) never names the evaluation modules:
  // the allowlist check already limits lib.rs to the capability flag, and no
  // other Rust file outside the evaluation modules may name them. Here the
  // `#[napi]` items of lib.rs are also checked directly.
  const lib = sources[PATHS.nodeLib];
  if (lib !== undefined) {
    const masked = maskRust(lib, { maskStrings: true });
    const withStrings = maskRust(lib, { maskStrings: false });
    for (const match of masked.matchAll(/#\[napi\b[^\]]*\]/g)) {
      const open = masked.indexOf("{", match.index);
      let depth = 0;
      let end = open;
      for (; end < masked.length; end += 1) {
        if (masked[end] === "{") depth += 1;
        if (masked[end] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const item = withStrings.slice(match.index, end);
      const allowedFlag = snippetPattern(SITES.buildCapability.snippet);
      const rest = item.replace(allowedFlag, "");
      for (const identifier of EVAL_IDENTIFIERS) {
        if (rest.includes(identifier)) {
          violations.push({
            rule: "eval-hooks-not-reachable-from-napi-ipc-preload",
            file: PATHS.nodeLib,
            message: `a #[napi] item references \`${identifier}\``,
          });
        }
      }
    }
  }
  return violations;
}

const PACKER_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'][^"']*\/nir1Packing(?:\.[cm]?[jt]sx?)?["']/;

export function checkProductDoesNotImportTsPacker(sources) {
  const violations = [];
  for (const [file, text] of Object.entries(sources)) {
    if (!isProductTypeScript(file)) continue;
    if (/\/nir1Packing\.[cm]?[jt]sx?$/.test(file)) continue;
    if (PACKER_IMPORT.test(text)) {
      violations.push({
        rule: "product-path-does-not-import-ts-packer",
        file,
        message: "product code imports the TS packer (nir1Packing)",
      });
    }
  }
  return violations;
}

// -------------------------------------------------- build capabilities

export function checkBuildCapabilities(sources) {
  const violations = [];
  const fail = (file, message) =>
    violations.push({ rule: "build-capabilities", file, message });
  const release = sources[PATHS.verifyRelease];
  if (release === undefined) {
    fail(PATHS.verifyRelease, "the release check is missing");
  } else if (
    !new RegExp(`${NODE_CAPABILITY_FLAG}\\s*:\\s*false\\b`).test(release)
  ) {
    fail(
      PATHS.verifyRelease,
      `the release check must expect ${NODE_CAPABILITY_FLAG}: false`,
    );
  }
  const lib = sources[PATHS.nodeLib];
  if (lib === undefined) {
    fail(PATHS.nodeLib, "lib.rs is missing");
  } else {
    const body = functionBody(lib, "get_native_build_capabilities");
    if (body === null) {
      fail(PATHS.nodeLib, "get_native_build_capabilities was not found");
    } else if (!snippetPattern(SITES.buildCapability.snippet).test(body)) {
      fail(
        PATHS.nodeLib,
        `get_native_build_capabilities must report ${NODE_CAPABILITY_FLAG}`,
      );
    }
  }
  return violations;
}

// ------------------------------------------------------------ the harness

/** Statements that write or change the schema; none belongs in the setup. */
const SQL_WRITE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+["`\w]+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)|ALTER\s+TABLE|CREATE\s+(?:TABLE|INDEX|TRIGGER|VIEW)|PRAGMA\s+\w+\s*=)/i;

/** The only direct write the harness tests make, to prove the audit sees it. */
const AUDIT_TEST = "write_audit_attributes_and_flags_direct_dml";

function harnessFiles(sources) {
  return Object.keys(sources).filter((file) =>
    file.startsWith(PATHS.nodeHarnessDir),
  );
}

export function checkHarness(sources) {
  const violations = [];
  const fail = (file, message) =>
    violations.push({
      rule: "harness-setup-uses-product-writers",
      file,
      message,
    });
  const mod = sources[PATHS.nodeEvalMod];
  if (mod === undefined) {
    fail(PATHS.nodeEvalMod, "the evaluation module root is missing");
  } else if (
    !/#\[cfg\(test\)\]\s*mod\s+harness\s*;/.test(
      maskRust(mod, { maskStrings: true }),
    )
  ) {
    fail(
      PATHS.nodeEvalMod,
      "the harness must be declared `#[cfg(test)] mod harness;`",
    );
  }
  for (const [file, text] of Object.entries(sources)) {
    if (file.endsWith(".rs") && !file.startsWith(PATHS.nodeEvalDir)) {
      if (
        /\bharness::/.test(maskRust(text, { maskStrings: true })) &&
        file.includes("nir1_final_request_eval")
      ) {
        fail(file, "only the evaluation module declares the harness");
      }
    }
  }
  const files = harnessFiles(sources);
  if (files.length === 0)
    fail(PATHS.nodeHarnessDir, "the harness sources are missing");
  let connectionUses = 0;
  for (const file of files) {
    const isTest = file.endsWith("/tests.rs");
    const code = maskRust(sources[file], { maskStrings: false });
    const codeWithoutStrings = maskRust(sources[file], { maskStrings: true });
    for (const [pattern, what] of [
      [
        /\bseed_database\b/,
        "`seed_database` (the D-final unit tests' direct INSERT helper)",
      ],
      [
        /\bnir1_prepared_request::tests::Fixture\b|\bFixture::new\b/,
        "the D-final unit tests' `Fixture`",
      ],
    ]) {
      if (pattern.test(codeWithoutStrings)) fail(file, `uses ${what}`);
    }
    // Every child process is `git`.
    for (const match of codeWithoutStrings.matchAll(/Command::new\(/g)) {
      const after = code.slice(match.index, match.index + 40);
      if (!/^Command::new\(\s*"git"\s*\)/.test(after)) {
        fail(file, "a child process other than git");
      }
    }
    if (isTest) {
      const direct = [
        ...codeWithoutStrings.matchAll(/\.execute(?:_batch)?\(/g),
      ];
      if (direct.length > 1) {
        fail(file, "the tests run more than the one audited direct statement");
      }
      if (direct.length === 1) {
        const body = functionBody(sources[file], AUDIT_TEST);
        if (
          body === null ||
          !/\.execute\(/.test(maskRust(body, { maskStrings: true }))
        ) {
          fail(file, `the one direct statement must be inside ${AUDIT_TEST}`);
        }
      }
      continue;
    }
    if (SQL_WRITE.test(code)) fail(file, "a SQL write statement in the setup");
    if (/\.execute(?:_batch)?\(/.test(codeWithoutStrings)) {
      fail(file, "a direct `execute` call in the setup");
    }
    connectionUses += [...codeWithoutStrings.matchAll(/\.with_conn\(/g)].length;
    if (
      /\.with_conn\(/.test(codeWithoutStrings) &&
      !file.endsWith("/workspace.rs")
    ) {
      fail(
        file,
        "a direct connection (`with_conn`) outside the workspace module",
      );
    }
  }
  // The single `with_conn` installs the write-audit hook; reads use
  // `with_read_transaction`.
  if (connectionUses > 1) {
    fail(
      PATHS.nodeHarnessDir,
      "`with_conn` is used more than once (only the audit hook is installed through it)",
    );
  }
  checkFreezeOrder(sources, files, fail);
  return violations;
}

/** The only test that reads the frozen fixture's bytes (as text, never into Native). */
const FROZEN_READ_TEST =
  "mechanics_fixture_shares_no_material_with_the_frozen_fixture";

/**
 * Native runs on the frozen fixture's materials only after the freeze gate
 * (draft K6/2 観測前の固定): `run_all_variants` is called once outside the
 * tests, in `evidence_run`, after `check_freeze`; no test or helper reads the
 * frozen fixture except the one that compares text; and there is no run
 * without the gate (no development dump).
 */
function checkFreezeOrder(sources, files, fail) {
  const modFile = `${PATHS.nodeHarnessDir}mod.rs`;
  const evidence =
    sources[modFile] === undefined
      ? null
      : functionBody(sources[modFile], "evidence_run");
  if (evidence === null) {
    fail(modFile, "`evidence_run` (the gated evidence entry) is missing");
  } else {
    const masked = maskRust(evidence, { maskStrings: true });
    const gate = masked.search(/\bcheck_freeze\(/);
    const run = masked.search(/\brun_all_variants\(/);
    if (gate === -1 || run === -1 || gate > run) {
      fail(
        modFile,
        "`evidence_run` must call `check_freeze` before `run_all_variants`",
      );
    }
  }
  for (const file of files) {
    const text = sources[file];
    const masked = maskRust(text, { maskStrings: true });
    const code = maskRust(text, { maskStrings: false });
    if (/DEV_OUT|development_receipts_dump/.test(code)) {
      fail(file, "a run without the freeze gate (a development dump)");
    }
    if (file.endsWith("/tests.rs")) {
      const reads = [...masked.matchAll(/\.join\(\s*FIXTURE_PATH\s*\)/g)];
      if (reads.length > 0) {
        const body = functionBody(text, FROZEN_READ_TEST);
        const inside =
          body === null
            ? 0
            : [
                ...maskRust(body, { maskStrings: true }).matchAll(
                  /\.join\(\s*FIXTURE_PATH\s*\)/g,
                ),
              ].length;
        if (reads.length !== inside) {
          fail(
            file,
            `the frozen fixture is read outside ${FROZEN_READ_TEST} (a test must run on the mechanics fixture)`,
          );
        }
      }
      continue;
    }
    // Outside the tests, `run_all_variants` is called by `evidence_run` only.
    const calls = [...masked.matchAll(/(?<!fn\s)\brun_all_variants\(/g)];
    const allowed = file === modFile && evidence !== null ? 1 : 0;
    if (calls.length !== allowed) {
      fail(
        file,
        "`run_all_variants` is called outside `evidence_run` (Native must run on the fixture only behind the freeze gate)",
      );
    }
  }
}

// ------------------------------------------------------------- the runner

const SKIPPED_DIRS = new Set([
  "node_modules",
  "target",
  ".git",
  ".artifacts",
  "dist",
  "out",
]);

function walk(root, relative, files, include) {
  const absolute = path.join(root, relative);
  let entries;
  try {
    entries = readdirSync(absolute);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const child = path.posix.join(relative, entry);
    const stats = statSync(path.join(root, child));
    if (stats.isDirectory()) walk(root, child, files, include);
    else if (include(child)) files.push(child);
  }
}

/** Reads the repository files these checks look at. */
export function loadRepositorySources(root) {
  const files = [];
  walk(root, "src-tauri", files, (file) => /\.rs$|Cargo\.toml$/.test(file));
  walk(root, "electron/native", files, (file) =>
    /\.rs$|Cargo\.toml$|\.d\.ts$|package\.json$/.test(file),
  );
  for (const dir of [
    "src",
    "electron/shared",
    "electron/preload",
    "electron/main",
  ]) {
    walk(root, dir, files, (file) =>
      /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file),
    );
  }
  files.push(PATHS.verifyRelease, "package.json");
  try {
    for (const name of readdirSync(path.join(root, ".github/workflows"))) {
      if (/\.ya?ml$/.test(name)) files.push(`.github/workflows/${name}`);
    }
  } catch {
    // No workflow directory: nothing to scan.
  }
  const sources = {};
  for (const file of new Set(files)) {
    try {
      sources[file] = readFileSync(path.join(root, file), "utf8");
    } catch {
      // A missing file is reported by the rule that needs it.
    }
  }
  return sources;
}

export function runArchitectureChecks(sources) {
  return [
    ...checkEvalFeatureAllowlist(sources),
    ...checkObservationCalls(sources),
    ...checkCargoFeatures(sources),
    ...checkNotReachable(sources),
    ...checkProductDoesNotImportTsPacker(sources),
    ...checkBuildCapabilities(sources),
    ...checkHarness(sources),
  ];
}
