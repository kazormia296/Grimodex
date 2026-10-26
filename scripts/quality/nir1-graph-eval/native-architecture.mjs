// Architecture checks for the evaluation-only Graph arm of the Native
// (CP-4 S1a; K6/2 graph-eval-procedure, Mandatory defenses; CP-4 TASK D8,
// D9, §15.3). Modelled on the DP-H checks
// (`scripts/quality/nir1-packing/final-request/architecture.mjs`).
//
// The checks are read-only text checks over the repository's Rust, Cargo,
// script and TypeScript sources:
//
//   eval-feature-allowlist   every mention of the evaluation feature, module,
//                            N-API names and owner hooks outside the
//                            evaluation module files is one of the fixed
//                            snippets or blocks; the hook functions
//                            (`publication_open`, `begin`, `begin_deferred`,
//                            `begin_probed`) have a fixed body;
//                            `PRODUCT_GRAPH_PUBLISHED` stays false; the gate
//                            field is stored only by `open_publication_for_eval`
//                            (fixed body) and only `record_registration` calls
//                            it; no build script reads the feature (CP-4 S1e A-1);
//   cargo-features           the feature is defined only in the two
//                            Cargo.toml files, enables only the grimodex-db
//                            feature of the same name, is not in `default`,
//                            is not enabled by another feature or dependency,
//                            and no package.json script, workflow or release
//                            script names it;
//   not-reachable            the IPC contract, the preload, Main, the renderer
//                            and the N-API declarations never name it; no
//                            `#[napi]` item outside the module names it; the
//                            module's `#[napi]` functions are exactly the fixed
//                            set, and none of them configures the worker;
//   build-capabilities       `get_native_build_capabilities` reports
//                            `nir1GraphEval` and the release check expects
//                            `false` and no `nir1GraphEval*` export.
//
// `scanNativeBinary` is the auxiliary A-1 check of a built `.node`.
//
// The functions are pure over a `{ path -> text }` map so each rule has a
// negative test with a synthetic source. `loadRepositorySources` reads the
// real files. CLI: `node scripts/quality/nir1-graph-eval/native-architecture.mjs`
// runs the source checks; `--binary <file> --expect product|eval` scans a
// built `.node`.

import { Buffer } from "node:buffer";
import console from "node:console";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  functionBody,
  maskRust,
  parseCargoSections,
} from "../nir1-packing/final-request/architecture.mjs";

export const EVAL_FEATURE = "nir1-graph-eval";
export const NODE_CAPABILITY_FLAG = "nir1GraphEval";
export const EVAL_NAPI_PREFIX = "nir1GraphEval";

/** The `#[napi]` functions of the module (Rust names), fixed. */
export const EVAL_NAPI_FUNCTIONS = Object.freeze([
  "nir1_graph_eval_status",
  "nir1_graph_eval_diagnostics",
  "nir1_graph_eval_clear_next_query_cache",
  "nir1_graph_eval_samples",
  "nir1_graph_eval_clear_samples",
  "nir1_graph_eval_clock_ns",
  "nir1_graph_eval_read_a3",
]);

/** The JavaScript names napi-rs gives them. */
export const EVAL_NAPI_EXPORTS = Object.freeze(
  EVAL_NAPI_FUNCTIONS.map((name) =>
    name.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase()),
  ),
);

export const PATHS = Object.freeze({
  dbCargo: "src-tauri/crates/grimodex-db/Cargo.toml",
  nodeCargo: "electron/native/grimodex-node/Cargo.toml",
  dbNarrativeMod:
    "src-tauri/crates/grimodex-db/src/narrative_extraction/mod.rs",
  dbEvalFile:
    "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph_eval.rs",
  nodeLib: "electron/native/grimodex-node/src/lib.rs",
  nodeProduct: "electron/native/grimodex-node/src/nir1_graph_product.rs",
  nodeEvalDir: "electron/native/grimodex-node/src/nir1_graph_eval/",
  nodeEvalMod: "electron/native/grimodex-node/src/nir1_graph_eval/mod.rs",
  verifyRelease: "electron/scripts/verify-release-native.mjs",
  nodeDeclarations: "electron/native/grimodex-node/index.d.ts",
});

/** Script files that may name the feature (the eval build and the checks). */
const SCRIPT_ALLOWLIST = Object.freeze([
  "scripts/quality/nir1-graph-eval/",
  "scripts/quality/impact-map.mjs",
  "scripts/quality/impact-map.test.mjs",
  // S1b's guard of the evaluation build receipt names the feature it requires.
  "scripts/quality/nir1-retrieval/contract.mjs",
  "scripts/quality/nir1-retrieval/contract.test.mjs",
]);

function isEvalModuleFile(file) {
  return file.startsWith(PATHS.nodeEvalDir) || file === PATHS.dbEvalFile;
}

const EVAL_IDENTIFIERS = Object.freeze([
  EVAL_FEATURE,
  "nir1_graph_eval",
  NODE_CAPABILITY_FLAG,
  "BeginProbe",
  "eval_probe",
  "_for_eval",
  "eval_notes",
  "eval_stamp",
  "note_busy_cause",
  // A build script that reads the feature and emits another cfg (M5b), or
  // reads the feature list, would compile evaluation code outside the
  // allowlisted `#[cfg(feature)]` sites.
  "NIR1_GRAPH_EVAL",
  "CARGO_CFG_FEATURE",
]);

/** The opener of the gate (product file) and its fixed body (A-1). */
const GATE_OPENER = "open_publication_for_eval";
const GATE_OPENER_BODY =
  "self.shared.publication_open_for_eval.store(true, Ordering::SeqCst);";
const GATE_FIELD = "publication_open_for_eval";

/** Uses of `name` that are not its own `fn` definition. */
function identifierUses(masked, name) {
  return [...masked.matchAll(new RegExp(`(?<!\\bfn\\s+)\\b${name}\\b`, "g"))];
}

/**
 * The gate field of the product file: declared, initialised, loaded, read by
 * its getter, and stored `true` exactly once (in the opener's fixed body).
 * Any other access (a second store, `swap`, `fetch_or`, a borrow) is refused.
 */
function gateFieldViolations(product) {
  const masked = maskRust(product, { maskStrings: true });
  const problems = [];
  let stores = 0;
  for (const match of identifierUses(masked, GATE_FIELD)) {
    const after = masked.slice(match.index + match[0].length);
    const before = masked.slice(0, match.index);
    if (/^\s*:\s*AtomicBool\b/.test(after)) continue;
    if (/^\s*\.\s*load\s*\(\s*Ordering::SeqCst\s*\)/.test(after)) continue;
    if (/\.\s*$/.test(before) && /^\s*\(\s*\)/.test(after)) continue;
    if (
      /^\s*\.\s*store\s*\(\s*true\s*,\s*Ordering::SeqCst\s*,?\s*\)/.test(after)
    ) {
      stores += 1;
      continue;
    }
    problems.push(
      `\`${GATE_FIELD}\` is used other than declared, loaded or stored by \`${GATE_OPENER}\` (line ${before.split("\n").length})`,
    );
  }
  if (stores !== 1)
    problems.push(
      `\`${GATE_FIELD}\` must be stored exactly once, by \`${GATE_OPENER}\` (found ${stores})`,
    );
  const body = functionBody(product, GATE_OPENER);
  if (body === null || squash(body) !== squash(GATE_OPENER_BODY))
    problems.push(`\`fn ${GATE_OPENER}\` must have exactly its fixed body`);
  if (identifierUses(masked, GATE_OPENER).length !== 0)
    problems.push(
      `the product file must not call \`${GATE_OPENER}\` (only \`record_registration\` does)`,
    );
  return problems;
}

// ------------------------------------------------------------- helpers

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regex matching `snippet` with any whitespace between its tokens. */
export function snippetPattern(snippet, flags = "g") {
  const tokens = snippet.match(/[A-Za-z0-9_]+|"[^"]*"|[^\sA-Za-z0-9_"]/g);
  const parts = tokens.map((token) =>
    token === ")" ? ",?\\s*\\)" : escapeRegExp(token),
  );
  return new RegExp(parts.join("\\s*"), flags);
}

const squash = (text) => text.replace(/\s+/g, "").replace(/,\)/g, ")");

/** `[start, end)` of the brace block that starts at the first `{` after `from`. */
function braceBlock(masked, from) {
  const open = masked.indexOf("{", from);
  if (open === -1) return null;
  let depth = 0;
  for (let end = open; end < masked.length; end += 1) {
    if (masked[end] === "{") depth += 1;
    if (masked[end] === "}") {
      depth -= 1;
      if (depth === 0) return [open, end + 1];
    }
  }
  return null;
}

// --------------------------------------------------------- the fixed sites

const CFG = `#[cfg(feature = "${EVAL_FEATURE}")]`;

const BUSY_ANSWER =
  "self.unserved(GraphUnavailable::Busy, &demand.key.project_id)";

/** Every Busy answer of `begin` (DSN §1.2) and the hook in front of it. */
const BEGIN_BUSY_HOOKS = [
  `${CFG} crate::nir1_graph_eval::note_busy_cause("preparing-other-key"); ${BUSY_ANSWER}`,
  `${CFG} crate::nir1_graph_eval::note_busy_cause(if matches!(phase, Phase::InUse) { "in-use" } else { "retiring" }); ${BUSY_ANSWER}`,
  `${CFG} crate::nir1_graph_eval::note_busy_cause("edge-before-query"); return ${BUSY_ANSWER};`,
  `${CFG} crate::nir1_graph_eval::note_busy_cause("command-queue"); ${BUSY_ANSWER}`,
  `${CFG} crate::nir1_graph_eval::note_busy_cause("other-key"); let busy = ${BUSY_ANSWER};`,
];

/**
 * CQ-DEFER（D′）：`begin_deferred`（`demand_deferred` と `defer_on_ready`）の
 * Busy の答えとその前の hook。3 つは `begin` のものと同じ snippet なので、
 * snippet は一覧に載った回数だけ現れることを求める。
 */
const DEFERRED_BUSY_HOOKS = [
  `${CFG} crate::nir1_graph_eval::note_busy_cause("deferred-held"); ${BUSY_ANSWER}`,
  `${CFG} crate::nir1_graph_eval::note_busy_cause("preparing-other-key"); ${BUSY_ANSWER}`,
  `${CFG} crate::nir1_graph_eval::note_busy_cause(if matches!(phase, Phase::InUse) { "in-use" } else { "retiring" }); ${BUSY_ANSWER}`,
  `${CFG} crate::nir1_graph_eval::note_busy_cause("edge-before-query"); return ${BUSY_ANSWER};`,
  `${CFG} crate::nir1_graph_eval::note_busy_cause("other-key"); return ${BUSY_ANSWER};`,
  `${CFG} crate::nir1_graph_eval::note_busy_cause("command-queue"); return ${BUSY_ANSWER};`,
];

export const BUSY_HOOKS = Object.freeze([
  ...BEGIN_BUSY_HOOKS,
  ...DEFERRED_BUSY_HOOKS,
]);

export const SNIPPETS = Object.freeze({
  [PATHS.nodeLib]: [
    `${CFG} mod nir1_graph_eval;`,
    `#[cfg(all(feature = "${EVAL_FEATURE}", not(test)))] nir1_graph_eval::register(&state);`,
    `"${NODE_CAPABILITY_FLAG}": cfg!(feature = "${EVAL_FEATURE}"),`,
  ],
  [PATHS.nodeProduct]: [
    `${CFG} publication_open_for_eval: AtomicBool,`,
    `${CFG} publication_open_for_eval: AtomicBool::new(false),`,
    `${CFG} if self.publication_open_for_eval.load(Ordering::SeqCst) { return true; }`,
    `${CFG} let eval_probe = crate::nir1_graph_eval::BeginProbe::start(self);`,
    `${CFG} eval_probe.finish(&result);`,
    `#[cfg(any(test, feature = "${EVAL_FEATURE}"))] fn slot_kind(&self) -> GraphSlotKind {`,
    // The per-ticket notes (stamp attempt and Busy cause), CP-4 S1a review.
    `${CFG} eval_notes: crate::nir1_graph_eval::TicketNotes,`,
    `${CFG} eval_notes: crate::nir1_graph_eval::TicketNotes::default(),`,
    // The Busy answers of `begin` and `begin_deferred`, each with the
    // statement it precedes.
    ...BUSY_HOOKS,
    `${CFG} ticket.eval_notes.busy("rebuild-window"); ticket.deliver(GraphTicketOutcome::Unavailable(GraphUnavailable::Busy));`,
    `let failure = classify_c_query_failure(&error); ${CFG} if matches!(failure, CQueryFailure::CapacityBusy) { ticket.eval_notes.busy("worker-capacity"); }`,
    `${CFG} let eval_stamp_attempted_at = Instant::now(); let stamp1 = read_stamp_for_query(context, &guard.binding); ${CFG} ticket.eval_notes.stamp(eval_stamp_attempted_at, stamp0, stamp1.as_ref());`,
    // The read-only accessor of the path Main configured (CP-2b): the trait's
    // default and the process factory's answer (DR-CP4-M-1).
    `${CFG} fn worker_path_for_eval(&self) -> Option<&Path> { None }`,
    `${CFG} fn worker_path_for_eval(&self) -> Option<&Path> { Some(&self.worker) }`,
  ],
  [PATHS.dbNarrativeMod]: [`${CFG} pub mod nir1_graph_eval;`],
});

/** Blocks whose whole body belongs to the evaluation build. */
export const BLOCKS = Object.freeze({
  [PATHS.nodeProduct]: [
    `${CFG} impl Nir1GraphProductOwner {`,
    `${CFG} impl GraphTicketWaiter {`,
  ],
});

/**
 * Fixed bodies of the hooked product functions. CQ-DEFER（D′）：`begin` と
 * `begin_deferred` はどちらも `begin_probed`（probe の唯一の場所）を通る。
 */
export const FIXED_BODIES = Object.freeze({
  publication_open: `if PRODUCT_GRAPH_PUBLISHED { return true; } ${CFG} if self.publication_open_for_eval.load(Ordering::SeqCst) { return true; } #[cfg(test)] { self.publication_open_for_test.load(Ordering::SeqCst) } #[cfg(not(test))] { false }`,
  begin: `self.begin_probed(state, query, Shared::demand)`,
  begin_deferred: `self.begin_probed(state, query, Shared::demand_deferred)`,
  begin_probed: `${CFG} let eval_probe = crate::nir1_graph_eval::BeginProbe::start(self); let result = self.admit_and_route(state, query, route); ${CFG} eval_probe.finish(&result); result`,
});

const BACKEND_REGISTRATION = `let state = Arc::new(state); #[cfg(all(feature = "${EVAL_FEATURE}", not(test)))] nir1_graph_eval::register(&state); Ok(Backend { state })`;

const FEATURE_CFG = new RegExp(
  `(#\\s*\\[\\s*cfg(_attr)?\\b|\\bcfg!\\s*\\()[^\\n;{]*?${escapeRegExp(EVAL_FEATURE)}`,
);

/** Masks the allowlisted snippets and blocks of `file`; counts each. */
function maskAllowed(file, masked, counts) {
  let out = masked;
  // n 回載った snippet はちょうど n 回現れる（CQ-DEFER：`begin_deferred` が
  // `begin` と共有する Busy の hook）。
  const expected = new Map();
  for (const snippet of SNIPPETS[file] ?? []) {
    expected.set(snippet, (expected.get(snippet) ?? 0) + 1);
  }
  for (const [snippet, want] of expected) {
    let count = 0;
    out = out.replace(snippetPattern(snippet), (match) => {
      count += 1;
      return " ".repeat(match.length);
    });
    counts.push({ snippet, count, want });
  }
  for (const header of BLOCKS[file] ?? []) {
    const pattern = snippetPattern(header);
    const matches = [...out.matchAll(pattern)];
    counts.push({ snippet: header, count: matches.length, want: 1 });
    // Mask from the last match so earlier offsets stay valid.
    for (const match of matches.reverse()) {
      const block = braceBlock(out, match.index + match[0].length - 1);
      if (!block) continue;
      out =
        out.slice(0, match.index) +
        out.slice(match.index, block[1]).replace(/[^\n]/g, " ") +
        out.slice(block[1]);
    }
  }
  return out;
}

// --------------------------------------------------- eval-feature-allowlist

export function checkEvalFeatureAllowlist(sources) {
  const violations = [];
  const fail = (file, message, line) =>
    violations.push({ rule: "eval-feature-allowlist", file, line, message });
  for (const [file, source] of Object.entries(sources)) {
    if (!file.endsWith(".rs") || isEvalModuleFile(file)) continue;
    const listed = file in SNIPPETS || file in BLOCKS;
    if (
      !listed &&
      !EVAL_IDENTIFIERS.some((identifier) => source.includes(identifier))
    ) {
      continue;
    }
    const counts = [];
    const masked = maskAllowed(
      file,
      maskRust(source, { maskStrings: false }),
      counts,
    );
    for (const { snippet, count, want } of counts) {
      if (count !== want) {
        fail(
          file,
          `the allowlisted site must appear exactly ${want === 1 ? "once" : `${want} times`} (found ${count}): ${snippet.slice(0, 90)}`,
        );
      }
    }
    for (const identifier of EVAL_IDENTIFIERS) {
      let from = 0;
      for (;;) {
        const index = masked.indexOf(identifier, from);
        if (index === -1) break;
        fail(
          file,
          `\`${identifier}\` appears outside the allowlist`,
          masked.slice(0, index).split("\n").length,
        );
        from = index + identifier.length;
      }
    }
    if (FEATURE_CFG.test(masked)) {
      fail(
        file,
        "a #[cfg], cfg! or cfg_attr conditioned on the evaluation feature is outside the allowlist",
      );
    }
  }
  for (const file of new Set([
    ...Object.keys(SNIPPETS),
    ...Object.keys(BLOCKS),
  ])) {
    if (sources[file] === undefined)
      fail(file, "an allowlisted file is missing");
  }
  // The evaluation blocks only add `*_for_eval` methods.
  const product = sources[PATHS.nodeProduct];
  if (product !== undefined) {
    const masked = maskRust(product, { maskStrings: false });
    for (const header of BLOCKS[PATHS.nodeProduct]) {
      for (const match of masked.matchAll(snippetPattern(header))) {
        const block = braceBlock(masked, match.index + match[0].length - 1);
        if (!block) continue;
        for (const fn of masked
          .slice(...block)
          .matchAll(/\bfn\s+([A-Za-z0-9_]+)/g)) {
          if (!fn[1].endsWith("_for_eval")) {
            fail(
              PATHS.nodeProduct,
              `the evaluation block adds \`${fn[1]}\`, which is not a \`*_for_eval\` method`,
            );
          }
        }
      }
    }
    for (const message of gateFieldViolations(product))
      fail(PATHS.nodeProduct, message);
    for (const [name, expected] of Object.entries(FIXED_BODIES)) {
      const body = functionBody(product, name);
      if (body === null || squash(body) !== squash(expected)) {
        fail(
          PATHS.nodeProduct,
          `\`fn ${name}\` must have exactly its fixed body (the evaluation arm only under the feature)`,
        );
      }
    }
    const busyAnswers = (
      maskRust(product, { maskStrings: false }).match(
        /\bunserved\(\s*GraphUnavailable::Busy\b/g,
      ) ?? []
    ).length;
    if (busyAnswers !== BUSY_HOOKS.length) {
      fail(
        PATHS.nodeProduct,
        `every Busy answer of \`begin\` and \`begin_deferred\` needs its cause hook (${busyAnswers} answers, ${BUSY_HOOKS.length} hooks)`,
      );
    }
    const constant = maskRust(product, { maskStrings: true });
    if (
      (
        constant.match(
          /\bconst\s+PRODUCT_GRAPH_PUBLISHED\s*:\s*bool\s*=\s*false\s*;/g,
        ) ?? []
      ).length !== 1 ||
      !/const\s+_\s*:\s*\(\)\s*=\s*assert!\(\s*!\s*PRODUCT_GRAPH_PUBLISHED\s*\)\s*;/.test(
        constant,
      )
    ) {
      fail(
        PATHS.nodeProduct,
        "`PRODUCT_GRAPH_PUBLISHED` must stay `false` and asserted",
      );
    }
  }
  const lib = sources[PATHS.nodeLib];
  if (lib !== undefined) {
    const flat = squash(maskRust(lib, { maskStrings: false }));
    if (flat.split(squash(BACKEND_REGISTRATION)).length - 1 !== 1) {
      fail(
        PATHS.nodeLib,
        "`Backend::new` must register exactly between `Arc::new(state)` and `Ok(Backend { state })`",
      );
    }
  }
  return violations;
}

// ------------------------------------------------------------ Cargo files

function listItems(value) {
  return [...(value ?? "").matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

const FEATURE_WORD = new RegExp(
  `(?<![\\w/-])${escapeRegExp(EVAL_FEATURE)}(?![\\w/-])`,
);

const BUILD_COMMAND = /\b(?:cargo|napi)\s+build\b|--release\b/;

const NODE_BUILD_SCRIPT = "electron/native/grimodex-node/build.rs";
const NODE_BUILD_SCRIPT_BODY = "fn main() { napi_build::setup(); }";
const DB_BUILD_SCRIPT = "src-tauri/crates/grimodex-db/build.rs";

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
    const sections = parseCargoSections(text);
    const features = sections.features ?? {};
    if (!(EVAL_FEATURE in features)) {
      fail(file, `the \`${EVAL_FEATURE}\` feature is not defined`);
      continue;
    }
    if (
      JSON.stringify(listItems(features[EVAL_FEATURE])) !==
        JSON.stringify(expectedItems) ||
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
        fail(
          file,
          name === "default"
            ? "the evaluation feature is in `default`"
            : `feature \`${name}\` enables the evaluation feature`,
        );
      }
    }
    for (const [section, entries] of Object.entries(sections)) {
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
  // No package.json script names the feature or builds with --all-features.
  for (const [file, text] of Object.entries(sources)) {
    if (!file.endsWith("package.json")) continue;
    let scripts;
    try {
      scripts = JSON.parse(text).scripts ?? {};
    } catch {
      continue;
    }
    for (const [name, command] of Object.entries(scripts)) {
      const line = String(command);
      if (line.includes(EVAL_FEATURE)) {
        fail(file, `script \`${name}\` names the evaluation feature`);
      }
      if (/--all-features/.test(line) && BUILD_COMMAND.test(line)) {
        fail(
          file,
          `script \`${name}\` builds with \`--all-features\`, which enables the evaluation feature`,
        );
      }
    }
  }
  // No workflow names the feature; no workflow builds with --all-features.
  for (const [file, text] of Object.entries(sources)) {
    if (!file.startsWith(".github/workflows/") || !/\.ya?ml$/.test(file))
      continue;
    const logical = text.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/);
    logical.forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      if (line.includes(EVAL_FEATURE)) {
        fail(`${file}:${index + 1}`, "a workflow names the evaluation feature");
      } else if (/--all-features/.test(line) && BUILD_COMMAND.test(line)) {
        fail(
          `${file}:${index + 1}`,
          "a workflow builds with `--all-features`, which enables the evaluation feature",
        );
      }
    });
  }
  // Release and packaging scripts never name the feature.
  for (const [file, text] of Object.entries(sources)) {
    const script =
      (file.startsWith("scripts/") || file.startsWith("electron/scripts/")) &&
      /\.(?:[cm]?js|sh|json)$/.test(file);
    if (!script || SCRIPT_ALLOWLIST.some((allowed) => file.startsWith(allowed)))
      continue;
    // The feature as a word: not the `scripts/quality/nir1-graph-eval/`
    // directory of the harness, nor a schema name such as `nir1-graph-eval-…`.
    if (FEATURE_WORD.test(text)) {
      fail(
        file,
        "a script outside the evaluation tools names the evaluation feature",
      );
    }
  }
  // E-11: no build script can turn the feature into another cfg. The
  // grimodex-node build script is fixed, grimodex-db has none, and neither
  // Cargo.toml names another one.
  const buildScript = sources[NODE_BUILD_SCRIPT];
  if (
    buildScript === undefined ||
    squash(maskRust(buildScript, { maskStrings: false })) !==
      squash(NODE_BUILD_SCRIPT_BODY)
  )
    fail(
      NODE_BUILD_SCRIPT,
      "the grimodex-node build script must be exactly `fn main() { napi_build::setup(); }`",
    );
  if (sources[DB_BUILD_SCRIPT] !== undefined)
    fail(DB_BUILD_SCRIPT, "grimodex-db must have no build script");
  for (const file of [PATHS.nodeCargo, PATHS.dbCargo]) {
    const text = sources[file];
    if (text !== undefined && /^\s*build\s*=/m.test(text))
      fail(file, "the Cargo.toml must not name a build script (`build =`)");
  }
  return violations;
}

// ------------------------------------------------------------ reachability

const TS_PRODUCT_ROOTS = Object.freeze([
  "src/",
  "electron/shared/",
  "electron/preload/",
  "electron/main/",
]);
const REACH_IDENTIFIERS = Object.freeze([
  EVAL_FEATURE,
  "nir1_graph_eval",
  EVAL_NAPI_PREFIX,
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

/** `{ name, start, end }` of every `#[napi...]` item of a Rust source. */
function napiItems(source) {
  const masked = maskRust(source, { maskStrings: true });
  const items = [];
  for (const match of masked.matchAll(/#\[napi\b[^\]]*\]/g)) {
    const block = braceBlock(masked, match.index + match[0].length);
    if (!block) continue;
    const header = masked.slice(match.index, block[0]);
    const name =
      /\bfn\s+([A-Za-z0-9_]+)/.exec(header)?.[1] ??
      /\b(?:struct|impl)\s+([A-Za-z0-9_]+)/.exec(header)?.[1] ??
      null;
    items.push({ name, start: match.index, end: block[1], header });
  }
  return items;
}

export function checkNotReachable(sources) {
  const violations = [];
  const fail = (file, message) =>
    violations.push({
      rule: "eval-not-reachable-from-ipc-preload-main-renderer",
      file,
      message,
    });
  for (const [file, text] of Object.entries(sources)) {
    const declaration = file.endsWith(".d.ts");
    if (!isProductTypeScript(file) && !declaration) continue;
    for (const identifier of REACH_IDENTIFIERS) {
      if (text.includes(identifier)) {
        fail(
          file,
          `\`${identifier}\` is referenced from the IPC contract, preload, Main, renderer or N-API declarations`,
        );
      }
    }
  }
  // No `#[napi]` item outside the module names the evaluation identifiers.
  // lib.rs may report the capability flag, and the constructor holds the one
  // registration statement (§15.3); nothing else.
  for (const [file, text] of Object.entries(sources)) {
    if (!file.endsWith(".rs") || isEvalModuleFile(file)) continue;
    if (!text.includes("#[napi")) continue;
    const withStrings = maskRust(text, { maskStrings: false });
    for (const item of napiItems(text)) {
      let body = withStrings.slice(item.start, item.end);
      if (file === PATHS.nodeLib) {
        for (const allowed of SNIPPETS[PATHS.nodeLib].slice(1)) {
          body = body.replace(snippetPattern(allowed), "");
        }
      }
      for (const identifier of EVAL_IDENTIFIERS) {
        if (body.includes(identifier)) {
          fail(file, `a #[napi] item references \`${identifier}\``);
        }
      }
    }
  }
  // The module's N-API surface is exactly the fixed set, and none of it
  // touches the worker (Main configures it; the module only verifies it).
  const mod = sources[PATHS.nodeEvalMod];
  if (mod === undefined) {
    fail(PATHS.nodeEvalMod, "the evaluation module is missing");
  } else {
    const items = napiItems(mod);
    const names = items.map((item) => item.name).sort();
    if (
      JSON.stringify(names) !== JSON.stringify([...EVAL_NAPI_FUNCTIONS].sort())
    ) {
      fail(
        PATHS.nodeEvalMod,
        `the #[napi] functions must be exactly ${JSON.stringify(EVAL_NAPI_FUNCTIONS)} (found ${JSON.stringify(names)})`,
      );
    }
    const withStrings = maskRust(mod, { maskStrings: false });
    for (const item of items) {
      const index = EVAL_NAPI_FUNCTIONS.indexOf(item.name);
      const attribute =
        /#\[napi\b[^\]]*\]/.exec(
          withStrings.slice(item.start, item.end),
        )?.[0] ?? "";
      if (
        index !== -1 &&
        !attribute.includes(`js_name = "${EVAL_NAPI_EXPORTS[index]}"`)
      ) {
        fail(
          PATHS.nodeEvalMod,
          `#[napi] \`${item.name}\` must name itself \`${EVAL_NAPI_EXPORTS[index]}\` (js_name)`,
        );
      }
    }
    const masked = maskRust(mod, { maskStrings: true });
    for (const item of items) {
      const text = masked.slice(item.start, item.end);
      if (
        /\bworker\b|configure_worker|verify_worker|configured_worker_path_for_eval|\bregister\(/.test(
          text,
        )
      ) {
        fail(
          PATHS.nodeEvalMod,
          `#[napi] \`${item.name}\` touches the worker configuration or the registration`,
        );
      }
    }
    // CP-2b (DR-CP4-M-1): Main's constructor is the only setter of the worker
    // path. The module never names the setter, even in a comment (the CP-2b
    // test counts every occurrence); it reads the path Main configured once,
    // in `verify_worker`, and only `register` verifies.
    if (/configure_worker_path|\.worker\.set\(|from_path\(/.test(mod)) {
      fail(
        PATHS.nodeEvalMod,
        "the evaluation module must not set the worker path (Main's constructor is the only setter)",
      );
    }
    const verifyBody = functionBody(mod, "verify_worker");
    const registerBody = functionBody(mod, "register");
    const reads = [...masked.matchAll(/\.configured_worker_path_for_eval\(/g)];
    if (
      reads.length !== 1 ||
      verifyBody === null ||
      !/\.configured_worker_path_for_eval\(/.test(verifyBody)
    ) {
      fail(
        PATHS.nodeEvalMod,
        "`configured_worker_path_for_eval` must be read once, from `verify_worker`",
      );
    }
    const verifyCalls = [...masked.matchAll(/(?<!fn\s)\bverify_worker\(/g)];
    if (
      verifyCalls.length !== 1 ||
      registerBody === null ||
      !/\bverify_worker\(/.test(registerBody)
    ) {
      fail(
        PATHS.nodeEvalMod,
        "`verify_worker` must be called from `register` only",
      );
    }
    // Only `record_registration` opens the gate, and only `register` (and the
    // tests) call it.
    const recordBody = functionBody(mod, "record_registration");
    const opens = identifierUses(masked, GATE_OPENER);
    if (
      opens.length !== 1 ||
      recordBody === null ||
      identifierUses(recordBody, GATE_OPENER).length !== 1
    ) {
      fail(
        PATHS.nodeEvalMod,
        "`open_publication_for_eval` must be called once, from `record_registration`",
      );
    }
    const records = [...masked.matchAll(/(?<!fn\s)\brecord_registration\(/g)];
    if (
      records.length !== 1 ||
      registerBody === null ||
      !/\brecord_registration\(/.test(registerBody)
    ) {
      fail(
        PATHS.nodeEvalMod,
        "`record_registration` must be called from `register` only (outside the tests)",
      );
    }
  }
  for (const [file, text] of Object.entries(sources)) {
    if (!isEvalModuleFile(file) || file === PATHS.nodeEvalMod) continue;
    if (file.endsWith("/tests.rs")) continue;
    const masked = maskRust(text, { maskStrings: true });
    if (
      identifierUses(masked, GATE_OPENER).length > 0 ||
      /\brecord_registration\b/.test(masked)
    ) {
      fail(
        file,
        "only `record_registration` in the module root opens the gate",
      );
    }
  }
  return violations;
}

// -------------------------------------------------- build capabilities

/** JavaScript without `//` and block comments (strings are kept). */
export function stripJsComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== char) {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      out += source.slice(index, cursor + 1);
      index = cursor + 1;
    } else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** E-10: the capability object the release check asserts (squashed). */
const RELEASE_CAPABILITIES = `licensing: true, legacyKeyringMigration: true, nir1FinalRequestEval: false, ${NODE_CAPABILITY_FLAG}: false,`;

export function checkBuildCapabilities(sources) {
  const violations = [];
  const fail = (file, message) =>
    violations.push({ rule: "build-capabilities", file, message });
  const release = sources[PATHS.verifyRelease];
  if (release === undefined) {
    fail(PATHS.verifyRelease, "the release check is missing");
  } else {
    // Comments do not count: the expectations must be the asserted values.
    const code = stripJsComments(release);
    if (
      !new RegExp(
        `assert\\.deepEqual\\(\\s*JSON\\.parse\\(\\s*await\\s+backend\\.getNativeBuildCapabilities\\(\\)\\s*\\)\\s*,\\s*\\{[^{}]*\\b${NODE_CAPABILITY_FLAG}\\s*:\\s*false\\b[^{}]*\\}\\s*,?\\s*\\)`,
      ).test(code)
    ) {
      fail(
        PATHS.verifyRelease,
        `the release check must expect ${NODE_CAPABILITY_FLAG}: false`,
      );
    }
    // A duplicate key would let a later `nir1GraphEval: true` win (M4).
    const literal =
      /assert\.deepEqual\(\s*JSON\.parse\(\s*await\s+backend\.getNativeBuildCapabilities\(\)\s*\)\s*,\s*\{([^{}]*)\}/.exec(
        code,
      );
    const keys = [
      ...(literal?.[1] ?? "").matchAll(/([A-Za-z0-9_$]+|"[^"]*"|'[^']*')\s*:/g),
    ].map((match) => match[1].replace(/^["']|["']$/g, ""));
    const duplicates = keys.filter((key, at) => keys.indexOf(key) !== at);
    if (duplicates.length > 0 || /\.\.\./.test(literal?.[1] ?? "")) {
      fail(
        PATHS.verifyRelease,
        `the release check's capability object has a duplicate or spread key: ${duplicates.join(", ") || "..."}`,
      );
    }
    // E-10: and nothing else (a computed key `["nir1GraphEval"]: true` would
    // pass the key scan, M4b): the object is exactly the fixed one.
    if (squash(literal?.[1] ?? "") !== squash(RELEASE_CAPABILITIES)) {
      fail(
        PATHS.verifyRelease,
        "the release check's capability object must be exactly the fixed four keys and values",
      );
    }
    if (
      !/assert\.deepEqual\(\s*Object\.keys\(\s*native\s*\)\.filter\(\s*\(\s*name\s*\)\s*=>\s*name\.startsWith\(\s*"nir1GraphEval"\s*\)\s*,?\s*\)\s*,\s*\[\s*\]\s*,?\s*\)/.test(
        code,
      )
    ) {
      fail(
        PATHS.verifyRelease,
        "the release check must refuse any `nir1GraphEval*` export",
      );
    }
  }
  const lib = sources[PATHS.nodeLib];
  if (lib === undefined) {
    fail(PATHS.nodeLib, "lib.rs is missing");
  } else {
    const body = functionBody(lib, "get_native_build_capabilities");
    if (
      body === null ||
      !snippetPattern(SNIPPETS[PATHS.nodeLib][2]).test(body)
    ) {
      fail(
        PATHS.nodeLib,
        `get_native_build_capabilities must report ${NODE_CAPABILITY_FLAG}`,
      );
    }
  }
  return violations;
}

// ------------------------------------------------------- the built binary

/** Strings only an evaluation `.node` carries. */
export const BINARY_MARKERS = Object.freeze([
  ...EVAL_NAPI_EXPORTS,
  "nir1-graph-eval-status/1",
  "NIR1_GRAPH_EVAL_NOT_REGISTERED",
]);

/**
 * The A-1 auxiliary check of a built `.node`: a product build carries none of
 * the markers; an evaluation build carries every one. Returns violations.
 */
export function scanNativeBinary(buffer, expect) {
  if (expect !== "product" && expect !== "eval") {
    throw new Error("expect must be product or eval");
  }
  const found = BINARY_MARKERS.filter((marker) =>
    buffer.includes(Buffer.from(marker, "utf8")),
  );
  const violations = [];
  if (expect === "product" && found.length > 0) {
    violations.push({
      rule: "binary-markers",
      message: `the product .node carries evaluation strings: ${found.join(", ")}`,
    });
  }
  if (expect === "eval") {
    const missing = BINARY_MARKERS.filter((marker) => !found.includes(marker));
    if (missing.length > 0) {
      violations.push({
        rule: "binary-markers",
        message: `the evaluation .node lacks: ${missing.join(", ")}`,
      });
    }
  }
  return violations;
}

// ------------------------------------------------------------- the runner

const SKIPPED_DIRS = new Set([
  "node_modules",
  "target",
  ".git",
  ".artifacts",
  "dist",
  "dist-electron",
  "out",
]);

function walk(root, relative, files, include) {
  let entries;
  try {
    entries = readdirSync(path.join(root, relative));
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
  for (const dir of ["scripts", "electron/scripts"]) {
    walk(root, dir, files, (file) => /\.(?:[cm]?js|sh|json)$/.test(file));
  }
  files.push("package.json");
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
    ...checkCargoFeatures(sources),
    ...checkNotReachable(sources),
    ...checkBuildCapabilities(sources),
  ];
}

function main(argv) {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const binaryAt = argv.indexOf("--binary");
  if (binaryAt !== -1) {
    const file = argv[binaryAt + 1];
    const expect = argv[argv.indexOf("--expect") + 1];
    const violations = scanNativeBinary(readFileSync(file), expect);
    for (const violation of violations) console.error(violation.message);
    if (violations.length === 0)
      console.log(`[nir1-graph-eval] ${expect} binary markers ok: ${file}`);
    return violations.length === 0 ? 0 : 1;
  }
  const violations = runArchitectureChecks(loadRepositorySources(root));
  for (const violation of violations) {
    console.error(
      `${violation.rule}: ${violation.file}${violation.line ? `:${violation.line}` : ""}: ${violation.message}`,
    );
  }
  if (violations.length === 0)
    console.log("[nir1-graph-eval] native architecture ok");
  return violations.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exitCode = main(process.argv.slice(2));
}
