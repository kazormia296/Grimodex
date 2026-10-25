// Tests of the CP-4 S1a architecture checks: the real repository passes, and
// each mutation the TASK names (feature in `default`, the flag forced true,
// an IPC/N-API name, an open gate without the feature, ...) is caught.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BINARY_MARKERS,
  EVAL_FEATURE,
  EVAL_NAPI_EXPORTS,
  PATHS,
  checkBuildCapabilities,
  checkCargoFeatures,
  checkEvalFeatureAllowlist,
  checkNotReachable,
  loadRepositorySources,
  runArchitectureChecks,
  scanNativeBinary,
} from "./native-architecture.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const real = loadRepositorySources(root);

function mutate(file, from, to) {
  const text = real[file];
  assert.ok(text !== undefined, `${file} is loaded`);
  assert.ok(
    text.includes(from),
    `${file} contains the mutation anchor: ${from.slice(0, 60)}`,
  );
  return { ...real, [file]: text.replace(from, to) };
}

function rules(violations) {
  return [...new Set(violations.map((violation) => violation.rule))].sort();
}

test("the repository passes every CP-4 S1a architecture check", () => {
  assert.deepEqual(runArchitectureChecks(real), []);
});

test("the evaluation feature in `default` is refused", () => {
  const sources = mutate(
    PATHS.nodeCargo,
    "default = []",
    `default = ["${EVAL_FEATURE}"]`,
  );
  assert.ok(
    checkCargoFeatures(sources).some((violation) =>
      /in `default`/.test(violation.message),
    ),
  );
});

test("another feature or a dependency enabling the evaluation feature is refused", () => {
  const byFeature = mutate(
    PATHS.nodeCargo,
    'licensing = ["grimodex-license/licensing"]',
    `licensing = ["grimodex-license/licensing", "${EVAL_FEATURE}"]`,
  );
  assert.ok(checkCargoFeatures(byFeature).length > 0);
  const byDependency = mutate(
    PATHS.nodeCargo,
    'features = ["native-current-human-capture"] }',
    `features = ["native-current-human-capture", "${EVAL_FEATURE}"] }`,
  );
  assert.ok(checkCargoFeatures(byDependency).length > 0);
  const widened = mutate(
    PATHS.nodeCargo,
    `${EVAL_FEATURE} = ["grimodex-db/${EVAL_FEATURE}"]`,
    `${EVAL_FEATURE} = ["grimodex-db/${EVAL_FEATURE}", "licensing"]`,
  );
  assert.ok(checkCargoFeatures(widened).length > 0);
});

test("a package.json script, a workflow or a release script naming the feature is refused", () => {
  const script = JSON.parse(real["package.json"]);
  script.scripts["napi:build:eval"] =
    `pnpm --dir electron/native/grimodex-node exec napi build --release --features ${EVAL_FEATURE}`;
  assert.ok(
    checkCargoFeatures({ ...real, "package.json": JSON.stringify(script) })
      .length > 0,
  );
  const workflow = {
    ...real,
    ".github/workflows/synthetic.yml": `jobs:\n  b:\n    steps:\n      - run: cargo test --features ${EVAL_FEATURE}\n`,
  };
  assert.ok(checkCargoFeatures(workflow).length > 0);
  const release = mutate(
    PATHS.verifyRelease,
    "const native = require(nativePath);",
    `const native = require(nativePath); // built with ${EVAL_FEATURE}`,
  );
  assert.ok(checkCargoFeatures(release).length > 0);
  const allFeatures = JSON.parse(real["package.json"]);
  allFeatures.scripts["napi:build:all"] = "napi build --release --all-features";
  assert.ok(
    checkCargoFeatures({ ...real, "package.json": JSON.stringify(allFeatures) })
      .length > 0,
  );
});

test("forcing the capability flag true or dropping the release expectation is refused", () => {
  const forced = mutate(
    PATHS.nodeLib,
    `"nir1GraphEval": cfg!(feature = "${EVAL_FEATURE}"),`,
    '"nir1GraphEval": true,',
  );
  assert.ok(checkBuildCapabilities(forced).length > 0);
  assert.ok(checkEvalFeatureAllowlist(forced).length > 0);
  const expectsTrue = mutate(
    PATHS.verifyRelease,
    "nir1GraphEval: false",
    "nir1GraphEval: true",
  );
  assert.ok(checkBuildCapabilities(expectsTrue).length > 0);
  const noExportCheck = mutate(
    PATHS.verifyRelease,
    'startsWith("nir1GraphEval")',
    'startsWith("nir1Unrelated")',
  );
  assert.ok(checkBuildCapabilities(noExportCheck).length > 0);
});

test("naming an evaluation function from the IPC contract, the preload, Main, the renderer or the declarations is refused", () => {
  for (const file of [
    "electron/shared/ipcContract.ts",
    "electron/preload/index.ts",
    "electron/main/backend.ts",
    "src/lib/tauri.ts",
    PATHS.nodeDeclarations,
  ]) {
    const sources = {
      ...real,
      [file]: `${real[file] ?? ""}\nexport const x = "${EVAL_NAPI_EXPORTS[0]}";\n`,
    };
    assert.deepEqual(
      rules(checkNotReachable(sources)),
      ["eval-not-reachable-from-ipc-preload-main-renderer"],
      file,
    );
  }
});

test("a #[napi] item outside the module that reaches the evaluation module is refused", () => {
  const sources = mutate(
    PATHS.nodeLib,
    "    pub async fn get_native_build_capabilities(&self) -> Result<String> {\n",
    "    pub async fn get_native_build_capabilities(&self) -> Result<String> {\n        let _ = crate::nir1_graph_eval::status_json();\n",
  );
  assert.ok(checkNotReachable(sources).length > 0);
  assert.ok(checkEvalFeatureAllowlist(sources).length > 0);
});

test("a new N-API entry in the module, or one that configures the worker, is refused", () => {
  const added = mutate(
    PATHS.nodeEvalMod,
    '/// The eval clock now, in nanoseconds since the anchor.\n#[napi(js_name = "nir1GraphEvalClockNs")]\n',
    '#[napi(js_name = "nir1GraphEvalConfigureWorker")]\npub fn nir1_graph_eval_configure_worker(path: String) -> napi::Result<()> {\n    let state = registered_state()?;\n    let _ = configure_worker(&state, Path::new(&path));\n    Ok(())\n}\n\n/// The eval clock now, in nanoseconds since the anchor.\n#[napi(js_name = "nir1GraphEvalClockNs")]\n',
  );
  const messages = checkNotReachable(added)
    .map((violation) => violation.message)
    .join("\n");
  assert.match(messages, /must be exactly/);
  assert.match(messages, /touches the worker configuration/);
  assert.match(
    messages,
    /`configure_worker` must be called from `register` only/,
  );
});

test("opening the gate without the feature, or unconditionally, is refused", () => {
  const withoutCfg = mutate(
    PATHS.nodeProduct,
    `        #[cfg(feature = "${EVAL_FEATURE}")]\n        if self.publication_open_for_eval.load(Ordering::SeqCst) {`,
    "        if self.publication_open_for_eval.load(Ordering::SeqCst) {",
  );
  assert.ok(checkEvalFeatureAllowlist(withoutCfg).length > 0);
  const unconditional = mutate(
    PATHS.nodeProduct,
    "        if PRODUCT_GRAPH_PUBLISHED {\n            return true;\n        }",
    "        if PRODUCT_GRAPH_PUBLISHED || true {\n            return true;\n        }",
  );
  assert.match(
    checkEvalFeatureAllowlist(unconditional)
      .map((violation) => violation.message)
      .join("\n"),
    /`fn publication_open` must have exactly its fixed body/,
  );
  const published = mutate(
    PATHS.nodeProduct,
    "const PRODUCT_GRAPH_PUBLISHED: bool = false;",
    "const PRODUCT_GRAPH_PUBLISHED: bool = true;",
  );
  assert.ok(checkEvalFeatureAllowlist(published).length > 0);
});

test("a hook that is not compiled out, or an extra method of the evaluation block, is refused", () => {
  const probe = mutate(
    PATHS.nodeProduct,
    `        #[cfg(feature = "${EVAL_FEATURE}")]\n        eval_probe.finish(&result);`,
    "        eval_probe.finish(&result);",
  );
  assert.ok(checkEvalFeatureAllowlist(probe).length > 0);
  const extra = mutate(
    PATHS.nodeProduct,
    "    pub(crate) fn slot_kind_for_eval(&self) -> GraphSlotKind {",
    "    pub(crate) fn open_every_gate(&self) {}\n\n    pub(crate) fn slot_kind_for_eval(&self) -> GraphSlotKind {",
  );
  assert.match(
    checkEvalFeatureAllowlist(extra)
      .map((violation) => violation.message)
      .join("\n"),
    /not a `\*_for_eval` method/,
  );
  const elsewhere = mutate(
    "electron/native/grimodex-node/src/state.rs",
    "pub struct AppState {",
    "fn leak(owner: &crate::nir1_graph_product::Nir1GraphProductOwner) { owner.open_publication_for_eval(); }\npub struct AppState {",
  );
  assert.ok(checkEvalFeatureAllowlist(elsewhere).length > 0);
});

test("a registration that also runs under test, or outside Backend::new, is refused", () => {
  const underTest = mutate(
    PATHS.nodeLib,
    `#[cfg(all(feature = "${EVAL_FEATURE}", not(test)))]`,
    `#[cfg(feature = "${EVAL_FEATURE}")]`,
  );
  assert.ok(checkEvalFeatureAllowlist(underTest).length > 0);
  const moved = mutate(
    PATHS.nodeLib,
    `        let state = Arc::new(state);\n        #[cfg(all(feature = "${EVAL_FEATURE}", not(test)))]\n        nir1_graph_eval::register(&state);\n        Ok(Backend { state })`,
    `        let state = Arc::new(state);\n        Ok(Backend { state })`,
  );
  assert.ok(checkEvalFeatureAllowlist(moved).length > 0);
});

test("another Cargo.toml naming the feature is refused", () => {
  const sources = {
    ...real,
    "src-tauri/Cargo.toml": `${real["src-tauri/Cargo.toml"]}\n# ${EVAL_FEATURE}\n`,
  };
  assert.ok(checkCargoFeatures(sources).length > 0);
});

test("the binary scan refuses evaluation strings in a product .node and missing ones in an evaluation .node", () => {
  const product = Buffer.from("\0napi_register_module_v1\0Backend\0");
  assert.deepEqual(scanNativeBinary(product, "product"), []);
  const leaked = Buffer.concat([
    product,
    Buffer.from(`${EVAL_NAPI_EXPORTS[0]}\0`),
  ]);
  assert.equal(scanNativeBinary(leaked, "product").length, 1);
  const evaluation = Buffer.from(
    BINARY_MARKERS.map((marker) => `${marker}\0`).join(""),
  );
  assert.deepEqual(scanNativeBinary(evaluation, "eval"), []);
  const partial = Buffer.from(
    BINARY_MARKERS.slice(1)
      .map((marker) => `${marker}\0`)
      .join(""),
  );
  assert.equal(scanNativeBinary(partial, "eval").length, 1);
  assert.throws(() => scanNativeBinary(product, "other"));
});

test("the N-API export names are napi-rs's camel case of the fixed Rust names", () => {
  assert.deepEqual(EVAL_NAPI_EXPORTS, [
    "nir1GraphEvalStatus",
    "nir1GraphEvalDiagnostics",
    "nir1GraphEvalClearNextQueryCache",
    "nir1GraphEvalSamples",
    "nir1GraphEvalClearSamples",
    "nir1GraphEvalClockNs",
    "nir1GraphEvalReadA3",
  ]);
});

// ---- CP-4 S1a review follow-up ---------------------------------------------------

test("an owner hook outside the feature, or a Busy answer without its hook, is refused", () => {
  const busy = mutate(
    PATHS.nodeProduct,
    `                    #[cfg(feature = "${EVAL_FEATURE}")]\n                    crate::nir1_graph_eval::note_busy_cause("command-queue");`,
    `                    crate::nir1_graph_eval::note_busy_cause("command-queue");`,
  );
  assert.ok(checkEvalFeatureAllowlist(busy).length > 0);
  const stamp = mutate(
    PATHS.nodeProduct,
    `    #[cfg(feature = "${EVAL_FEATURE}")]\n    ticket.eval_notes.stamp(`,
    "    ticket.eval_notes.stamp(",
  );
  assert.ok(checkEvalFeatureAllowlist(stamp).length > 0);
  const unhooked = mutate(
    PATHS.nodeProduct,
    `                    #[cfg(feature = "${EVAL_FEATURE}")]\n                    crate::nir1_graph_eval::note_busy_cause("command-queue");\n`,
    "",
  );
  assert.match(
    checkEvalFeatureAllowlist(unhooked)
      .map((violation) => violation.message)
      .join("\n"),
    /allowlisted site must appear exactly once/,
  );
  const extraBusy = mutate(
    PATHS.nodeProduct,
    "            Phase::Empty => self.start_session(&mut slot, state, demand, &config),",
    "            Phase::Empty if false => self.unserved(GraphUnavailable::Busy, &demand.key.project_id),\n            Phase::Empty => self.start_session(&mut slot, state, demand, &config),",
  );
  assert.match(
    checkEvalFeatureAllowlist(extraBusy)
      .map((violation) => violation.message)
      .join("\n"),
    /every Busy answer of `begin` needs its cause hook/,
  );
});

test("an N-API function that opens the gate or registers is refused", () => {
  const anchor =
    "pub fn nir1_graph_eval_clear_samples() -> napi::Result<String> {\n    let cleared = clear_samples();\n";
  for (const inserted of [
    "    registered_state()?.nir1_graph.open_publication_for_eval();\n",
    "    record_registration(&registered_state()?, WorkerSetup::NotAttempted);\n",
  ]) {
    const sources = mutate(PATHS.nodeEvalMod, anchor, `${anchor}${inserted}`);
    assert.ok(checkNotReachable(sources).length > 0, inserted);
  }
});

test("a release check whose expectations live only in comments is refused", () => {
  const commentedFlag = mutate(
    PATHS.verifyRelease,
    "    nir1GraphEval: false,\n",
    "    nir1GraphEval: true, // nir1GraphEval: false\n",
  );
  assert.ok(checkBuildCapabilities(commentedFlag).length > 0);
  const commentedExports = mutate(
    PATHS.verifyRelease,
    'Object.keys(native).filter((name) => name.startsWith("nir1GraphEval")),',
    'Object.keys(native).filter(() => false), // name.startsWith("nir1GraphEval")',
  );
  assert.ok(checkBuildCapabilities(commentedExports).length > 0);
});
