import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EVAL_FEATURE,
  NODE_CAPABILITY_FLAG,
  PATHS,
  SITES,
  checkBuildCapabilities,
  checkCargoFeatures,
  checkEvalFeatureAllowlist,
  checkNotReachable,
  checkObservationCalls,
  checkProductDoesNotImportTsPacker,
  functionBody,
  loadRepositorySources,
  maskRust,
  parseCargoSections,
  runArchitectureChecks,
} from "./architecture.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const real = loadRepositorySources(repoRoot);

function mutated(file, mutate) {
  const source = real[file];
  assert.ok(source !== undefined, `${file} is missing from the real sources`);
  const next = mutate(source);
  assert.notEqual(next, source, "the mutation changed nothing");
  return { ...real, [file]: next };
}

/** Applies `change` to the text of one observation call only. */
function inCall(callee, change) {
  return (text) => {
    const start = text.indexOf(callee);
    assert.ok(start !== -1, `${callee} is missing`);
    const end = text.indexOf(");", start) + 2;
    return (
      text.slice(0, start) + change(text.slice(start, end)) + text.slice(end)
    );
  };
}

function rules(violations) {
  return [...new Set(violations.map((violation) => violation.rule))];
}

// ----------------------------------------------------- the real repository

test("the repository passes every architecture check", () => {
  assert.deepEqual(runArchitectureChecks(real), []);
});

test("masking keeps offsets and hides comments and string contents", () => {
  const source =
    'let a = "x { y"; // brace {\nlet b = r#"}"#; /* { */ let c = \'}\';';
  const masked = maskRust(source, { maskStrings: true });
  assert.equal(masked.length, source.length);
  assert.ok(!masked.includes("{") && !masked.includes("}"));
  const keepStrings = maskRust(source, { maskStrings: false });
  assert.ok(keepStrings.includes('"x { y"'));
  assert.ok(!keepStrings.includes("brace"));
});

test("functionBody finds the body of a function with a generic signature", () => {
  const body = functionBody(
    'fn a<T>(x: impl Fn() -> Result<()>) -> Result<T> where T: Copy { let y = "}"; y }',
    "a",
  );
  assert.equal(body.trim(), 'let y = "}"; y');
  assert.equal(functionBody("fn b() {}", "missing"), null);
});

// ----------------------------------------------------- eval-feature-allowlist

test("eval-feature-allowlist: a #[cfg] outside the allowlist fails", () => {
  const sources = mutated(PATHS.nodePrepared, (text) =>
    text.replace(
      "fn capture_owner(",
      `#[cfg(feature = "${EVAL_FEATURE}")]\nfn extra_hook() {}\n\nfn capture_owner(`,
    ),
  );
  const violations = checkEvalFeatureAllowlist(sources);
  assert.deepEqual(rules(violations), ["eval-feature-allowlist"]);
  assert.ok(
    violations.some((violation) =>
      /#\[cfg\]|appears outside/.test(violation.message),
    ),
  );
});

test("eval-feature-allowlist: cfg!, cfg_attr and any-all-not forms fail", () => {
  for (const injected of [
    `let _ = cfg!(feature = "${EVAL_FEATURE}");`,
    `#[cfg_attr(feature = "${EVAL_FEATURE}", derive(Debug))] struct Hooked;`,
    `#[cfg(all(test, feature = "${EVAL_FEATURE}"))] fn hooked() {}`,
    `#[cfg(not(feature = "${EVAL_FEATURE}"))] fn unhooked() {}`,
  ]) {
    const sources = mutated(
      PATHS.dbNarrativeMod,
      (text) => `${text}\n${injected}\n`,
    );
    const violations = checkEvalFeatureAllowlist(sources);
    assert.ok(violations.length > 0, injected);
  }
});

test("eval-feature-allowlist: a reference to an evaluation module outside the allowlist fails", () => {
  const sources = {
    ...real,
    "electron/native/grimodex-node/src/state.rs": `${real["electron/native/grimodex-node/src/state.rs"]}\nfn x() { crate::nir1_final_request_eval::observe_rendered(); }\n`,
  };
  const violations = checkEvalFeatureAllowlist(sources);
  assert.ok(
    violations.some((violation) => violation.file.endsWith("state.rs")),
  );
});

test("eval-feature-allowlist: the evaluation module files may use the feature freely", () => {
  const sources = {
    ...real,
    [`${PATHS.nodeEvalDir}extra.rs`]: `#[cfg(feature = "${EVAL_FEATURE}")] fn ok() {}`,
    [`${PATHS.dbEvalDir}final_request_eval/child.rs`]: `#[cfg(feature = "${EVAL_FEATURE}")] fn ok() {}`,
  };
  assert.deepEqual(checkEvalFeatureAllowlist(sources), []);
});

test("eval-feature-allowlist: a mention in a comment is not code", () => {
  const sources = mutated(
    PATHS.dbNarrativeMod,
    (text) =>
      `${text}\n// the ${EVAL_FEATURE} feature is documented in the eval module\n`,
  );
  assert.deepEqual(checkEvalFeatureAllowlist(sources), []);
});

test("eval-feature-allowlist: removing an allowlisted site is reported", () => {
  const sources = mutated(PATHS.dbNarrativeMod, (text) =>
    text.replace(
      `#[cfg(feature = "${EVAL_FEATURE}")]\npub use nir1_packing::final_request_eval;\n`,
      "",
    ),
  );
  assert.ok(
    checkEvalFeatureAllowlist(sources).some((violation) =>
      /exactly once/.test(violation.message),
    ),
  );
});

// ------------------------------------- observation-calls-are-single-shared-ref

const c1 = SITES.c1;
const c2 = SITES.c2;

function observationViolations(site, mutate) {
  const sources = mutated(site.file, mutate);
  return checkObservationCalls(sources);
}

test("observation-calls-are-single-shared-ref-statements: the real sites pass", () => {
  assert.deepEqual(checkObservationCalls(real), []);
});

test("observation-calls-are-single-shared-ref-statements: a mutable or moved argument fails", () => {
  const c1Call = "final_request_eval::observe_candidate_set(";
  const c2Call = "nir1_final_request_eval::observe_rendered(";
  assert.ok(
    observationViolations(
      c1,
      inCall(c1Call, (call) =>
        call.replace("&candidate_owners,", "&mut candidate_owners,"),
      ),
    ).length > 0,
  );
  assert.ok(
    observationViolations(
      c1,
      inCall(c1Call, (call) => call.replace("&items,", "items,")),
    ).length > 0,
  );
  assert.ok(
    observationViolations(
      c2,
      inCall(c2Call, (call) => call.replace("&rendered,", "rendered,")),
    ).length > 0,
  );
  assert.ok(
    observationViolations(
      c2,
      inCall(c2Call, (call) => call.replace("&route,", "&mut route,")),
    ).length > 0,
  );
  assert.ok(
    observationViolations(
      c2,
      inCall(c2Call, (call) =>
        call.replace("message_version_id,", "message_version_id.clone(),"),
      ),
    ).length > 0,
  );
});

test("observation-calls-are-single-shared-ref-statements: a return value use or `?` fails", () => {
  assert.ok(
    observationViolations(c1, (text) =>
      text.replace(
        "final_request_eval::observe_candidate_set(",
        "let _seen = final_request_eval::observe_candidate_set(",
      ),
    ).length > 0,
  );
  assert.ok(
    observationViolations(c2, (text) =>
      text.replace("&rendered,\n    );", "&rendered,\n    )?;"),
    ).length > 0,
  );
});

test("observation-calls-are-single-shared-ref-statements: an extra statement, a move or a branch fails", () => {
  // An extra statement between the previous statement and the call.
  assert.ok(
    observationViolations(c1, (text) =>
      text.replace(
        `#[cfg(feature = "${EVAL_FEATURE}")]\n    final_request_eval::observe_candidate_set(`,
        `let _extra = 1;\n    #[cfg(feature = "${EVAL_FEATURE}")]\n    final_request_eval::observe_candidate_set(`,
      ),
    ).length > 0,
  );
  // An extra statement between the call and the next statement.
  assert.ok(
    observationViolations(c2, (text) =>
      text.replace(
        "&rendered,\n    );\n",
        "&rendered,\n    );\n    let _extra = 1;\n",
      ),
    ).length > 0,
  );
  // Moved before the previous statement.
  assert.ok(
    observationViolations(c2, (text) => {
      const call = text.match(
        /#\[cfg\(feature = "nir1-final-request-eval"\)\]\s*nir1_final_request_eval::observe_rendered\([^)]*\);\n/,
      )[0];
      return text
        .replace(call, "")
        .replace(
          "    let rendered = render_local_plain_chat_payload(",
          `${call}    let rendered = render_local_plain_chat_payload(`,
        );
    }).length > 0,
  );
  // Wrapped in a branch.
  assert.ok(
    observationViolations(c1, (text) =>
      text
        .replace(
          `#[cfg(feature = "${EVAL_FEATURE}")]\n    final_request_eval::observe_candidate_set(`,
          `if request.budget_tokens > 0 {\n    #[cfg(feature = "${EVAL_FEATURE}")]\n    final_request_eval::observe_candidate_set(`,
        )
        .replace(
          "&raw_budget_charge,\n    );",
          "&raw_budget_charge,\n    ); }",
        ),
    ).length > 0,
  );
});

test("observation-calls-are-single-shared-ref-statements: a missing attribute or a second call fails", () => {
  assert.ok(
    observationViolations(c1, (text) =>
      text.replace(
        `    #[cfg(feature = "${EVAL_FEATURE}")]\n    final_request_eval::observe_candidate_set(`,
        "    final_request_eval::observe_candidate_set(",
      ),
    ).length > 0,
  );
  assert.ok(
    observationViolations(c2, (text) =>
      text.replace(
        "    ensure!(\n        rendered.canonical_payload.len() <= MAX_PREPARED_PAYLOAD_BYTES,",
        `    #[cfg(feature = "${EVAL_FEATURE}")]\n    nir1_final_request_eval::observe_rendered(message_version_id, &projection, &route, &packing_context_budget_tokens, &rendered);\n    ensure!(\n        rendered.canonical_payload.len() <= MAX_PREPARED_PAYLOAD_BYTES,`,
      ),
    ).length > 0,
  );
});

test("observation-calls-are-single-shared-ref-statements: a renamed function is reported", () => {
  assert.ok(
    observationViolations(c1, (text) =>
      text.replace(
        "fn read_and_pack_native_a2_context_in_tx_with_raw_charge(",
        "fn read_and_pack_renamed(",
      ),
    ).some((violation) => /was not found/.test(violation.message)),
  );
});

// ------------------------------------------------------------ cargo-features

function cargoSources(overrides) {
  return {
    [PATHS.dbCargo]: real[PATHS.dbCargo],
    [PATHS.nodeCargo]: real[PATHS.nodeCargo],
    ...overrides,
  };
}

test("cargo-features: the real definitions pass", () => {
  assert.deepEqual(checkCargoFeatures(cargoSources({})), []);
  const node = parseCargoSections(real[PATHS.nodeCargo]);
  assert.equal(
    node.features[EVAL_FEATURE],
    '["grimodex-db/nir1-final-request-eval"]',
  );
  assert.equal(
    parseCargoSections(real[PATHS.dbCargo]).features[EVAL_FEATURE],
    "[]",
  );
  assert.equal(node.features.default, "[]");
});

test("cargo-features: a feature that enables another feature fails", () => {
  const node = real[PATHS.nodeCargo].replace(
    `${EVAL_FEATURE} = ["grimodex-db/${EVAL_FEATURE}"]`,
    `${EVAL_FEATURE} = ["grimodex-db/${EVAL_FEATURE}", "test-lifecycle"]`,
  );
  assert.ok(
    checkCargoFeatures(cargoSources({ [PATHS.nodeCargo]: node })).length > 0,
  );
  const db = real[PATHS.dbCargo].replace(
    `${EVAL_FEATURE} = []`,
    `${EVAL_FEATURE} = ["native-current-human-capture"]`,
  );
  assert.ok(
    checkCargoFeatures(cargoSources({ [PATHS.dbCargo]: db })).length > 0,
  );
});

test("cargo-features: the feature in default or in another feature or dependency fails", () => {
  const defaultNode = real[PATHS.nodeCargo].replace(
    "default = []",
    `default = ["${EVAL_FEATURE}"]`,
  );
  assert.ok(
    checkCargoFeatures(cargoSources({ [PATHS.nodeCargo]: defaultNode }))
      .length > 0,
  );
  const viaOther = real[PATHS.nodeCargo].replace(
    "licensing = [",
    `licensing = ["${EVAL_FEATURE}", `,
  );
  assert.ok(
    checkCargoFeatures(cargoSources({ [PATHS.nodeCargo]: viaOther })).some(
      (violation) => /enables the evaluation feature/.test(violation.message),
    ),
  );
  const viaDependency = real[PATHS.nodeCargo].replace(
    'features = ["native-current-human-capture"]',
    `features = ["native-current-human-capture", "${EVAL_FEATURE}"]`,
  );
  assert.ok(
    checkCargoFeatures(cargoSources({ [PATHS.nodeCargo]: viaDependency })).some(
      (violation) => /outside its definition/.test(violation.message),
    ),
  );
});

test("cargo-features: a missing definition, another Cargo.toml or a release script fails", () => {
  const missing = real[PATHS.dbCargo].replace(`${EVAL_FEATURE} = []`, "");
  assert.ok(
    checkCargoFeatures(cargoSources({ [PATHS.dbCargo]: missing })).length > 0,
  );
  const other = cargoSources({
    "src-tauri/crates/grimodex-core/Cargo.toml": `[features]\nx = ["${EVAL_FEATURE}"]\n`,
  });
  assert.ok(checkCargoFeatures(other).length > 0);
  const release = cargoSources({
    "package.json": JSON.stringify({
      scripts: {
        "napi:build:release": `napi build --release --features licensing,${EVAL_FEATURE}`,
        "test:eval": `cargo test --features ${EVAL_FEATURE}`,
      },
    }),
  });
  const violations = checkCargoFeatures(release);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /napi:build:release/);
});

test("cargo-features: workflows and --all-features builds are scanned", () => {
  const workflow = (name, body) =>
    cargoSources({ [`.github/workflows/${name}`]: body });
  const ok = workflow(
    "ci.yml",
    `jobs:\n  t:\n    steps:\n      - run: |\n          cargo test -p grimodex-node \\\n            --features ${EVAL_FEATURE} --lib\n`,
  );
  assert.deepEqual(checkCargoFeatures(ok), []);
  const releaseNames = workflow(
    "release.yml",
    `jobs:\n  t:\n    steps:\n      - run: cargo check --features ${EVAL_FEATURE}\n`,
  );
  assert.match(
    checkCargoFeatures(releaseNames)[0].message,
    /release or publish workflow/,
  );
  const ciBuild = workflow(
    "ci.yml",
    `jobs:\n  t:\n    steps:\n      - run: |\n          napi build --platform \\\n            --features licensing,${EVAL_FEATURE}\n`,
  );
  assert.match(checkCargoFeatures(ciBuild)[0].message, /builds with/);
  const allFeatures = workflow(
    "ci.yml",
    "jobs:\n  t:\n    steps:\n      - run: cargo build --release --all-features\n",
  );
  assert.match(checkCargoFeatures(allFeatures)[0].message, /builds with/);
  const scriptAll = cargoSources({
    "package.json": JSON.stringify({
      scripts: { "napi:build": "napi build --release --all-features" },
    }),
  });
  assert.match(checkCargoFeatures(scriptAll)[0].message, /--all-features/);
  const commented = workflow(
    "release.yml",
    `# cargo build --features ${EVAL_FEATURE}\njobs: {}\n`,
  );
  assert.deepEqual(checkCargoFeatures(commented), []);
});

test("cargo-features: multi-line arrays and comments parse", () => {
  const sections = parseCargoSections(
    '[features]\n# comment\nx = [\n  "a", # trailing\n  "b",\n]\ny = []\n[dependencies]\nz = { path = "p" }\n',
  );
  assert.equal(sections.features.y, "[]");
  assert.match(sections.features.x, /"a".*"b"/);
  assert.equal(sections.dependencies.z, '{ path = "p" }');
});

// --------------------------------------------------------------- reachability

test("eval-hooks-not-reachable-from-napi-ipc-preload: the real sources pass", () => {
  assert.deepEqual(checkNotReachable(real), []);
});

test("eval-hooks-not-reachable-from-napi-ipc-preload: a reference from the IPC contract, preload, main or renderer fails", () => {
  for (const file of [
    "electron/shared/ipcContract.ts",
    "electron/preload/index.ts",
    "electron/main/ipc.ts",
    "src/lib/ai.ts",
    "electron/native/grimodex-node/index.d.ts",
  ]) {
    for (const identifier of [
      NODE_CAPABILITY_FLAG,
      "nir1_final_request_eval",
      EVAL_FEATURE,
    ]) {
      const violations = checkNotReachable({
        ...real,
        [file]: `${real[file] ?? ""}\nconst x = "${identifier}";\n`,
      });
      assert.ok(violations.length > 0, `${file} ${identifier}`);
    }
  }
  // A test file may mention them.
  assert.deepEqual(
    checkNotReachable({
      ...real,
      "src/lib/ai.test.ts": `// ${EVAL_FEATURE}\n`,
    }),
    [],
  );
});

test("eval-hooks-not-reachable-from-napi-ipc-preload: a #[napi] item that names the evaluation module fails", () => {
  const sources = mutated(PATHS.nodeLib, (text) =>
    text.replace(
      "    pub async fn get_native_build_capabilities(&self) -> Result<String> {",
      "    pub async fn get_native_build_capabilities(&self) -> Result<String> {\n        crate::nir1_final_request_eval::run_dfinal_with_capture();",
    ),
  );
  const violations = checkNotReachable(sources);
  assert.ok(
    violations.some((violation) => /#\[napi\]/.test(violation.message)),
  );
  assert.ok(checkEvalFeatureAllowlist(sources).length > 0);
});

// ------------------------------------------------------------------ ts packer

test("product-path-does-not-import-ts-packer: the real sources pass", () => {
  assert.deepEqual(checkProductDoesNotImportTsPacker(real), []);
});

test("product-path-does-not-import-ts-packer: product code importing the packer fails", () => {
  for (const line of [
    'import { selectNir1PackingItems } from "../ai-context/nir1Packing";',
    'export * from "./nir1Packing";',
    'const p = await import("../ai-context/nir1Packing.ts");',
    'const p = require("../ai-context/nir1Packing");',
  ]) {
    const violations = checkProductDoesNotImportTsPacker({
      ...real,
      "src/features/chat/useChat.ts": `${line}\n`,
    });
    assert.equal(violations.length, 1, line);
  }
  assert.equal(
    checkProductDoesNotImportTsPacker({
      ...real,
      "electron/main/ipc.ts":
        'import "../../src/features/ai-context/nir1Packing";\n',
    }).length,
    1,
  );
});

test("product-path-does-not-import-ts-packer: tests, the packer itself and similar names are allowed", () => {
  assert.deepEqual(
    checkProductDoesNotImportTsPacker({
      ...real,
      "src/features/chat/useChat.test.ts":
        'import "../ai-context/nir1Packing";\n',
      "src/features/ai-context/nir1Packing.ts": 'import "./nir1Packing";\n',
      "src/features/chat/a.ts":
        'import "../narrative-semantic-core/nir1PackingApi";\n',
    }),
    [],
  );
});

// ----------------------------------------------------------------- capabilities

test("build-capabilities-eval-flag-false-in-release: the real sources pass", () => {
  assert.deepEqual(checkBuildCapabilities(real), []);
  assert.match(real[PATHS.verifyRelease], /nir1FinalRequestEval:\s*false/);
});

test("build-capabilities-eval-flag-false-in-release: an expectation of true or a missing flag fails", () => {
  const expectsTrue = mutated(PATHS.verifyRelease, (text) =>
    text.replace("nir1FinalRequestEval: false", "nir1FinalRequestEval: true"),
  );
  assert.ok(checkBuildCapabilities(expectsTrue).length > 0);
  const noFlag = mutated(PATHS.nodeLib, (text) =>
    text.replace(
      `            "${NODE_CAPABILITY_FLAG}": cfg!(feature = "${EVAL_FEATURE}"),\n`,
      "",
    ),
  );
  assert.ok(checkBuildCapabilities(noFlag).length > 0);
  const noExpectation = mutated(PATHS.verifyRelease, (text) =>
    text.replace("    nir1FinalRequestEval: false,\n", ""),
  );
  assert.ok(checkBuildCapabilities(noExpectation).length > 0);
});
