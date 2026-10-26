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

test("a new N-API entry in the module, or one that touches the worker, is refused", () => {
  const added = mutate(
    PATHS.nodeEvalMod,
    '/// The eval clock now, in nanoseconds since the anchor.\n#[napi(js_name = "nir1GraphEvalClockNs")]\n',
    '#[napi(js_name = "nir1GraphEvalVerifyWorker")]\npub fn nir1_graph_eval_verify_worker(path: String) -> napi::Result<()> {\n    let state = registered_state()?;\n    let _ = verify_worker(&state.nir1_graph, Path::new(&path));\n    Ok(())\n}\n\n/// The eval clock now, in nanoseconds since the anchor.\n#[napi(js_name = "nir1GraphEvalClockNs")]\n',
  );
  const messages = checkNotReachable(added)
    .map((violation) => violation.message)
    .join("\n");
  assert.match(messages, /must be exactly/);
  assert.match(messages, /touches the worker configuration/);
  assert.match(messages, /`verify_worker` must be called from `register` only/);
});

// CP-2b (DR-CP4-M-1): Main's constructor is the only setter of the worker
// path; the module only reads it, once, in `verify_worker`.
test("the evaluation module setting the worker path, even in a comment, is refused", () => {
  const SETTER = "the evaluation module must not set the worker path";
  const verify =
    "        Ok(library) => verify_worker(&state.nir1_graph, &library),\n";
  for (const [label, to] of [
    [
      "setter call",
      "        Ok(library) => {\n            let _ = state.nir1_graph.configure_worker_path(library.clone());\n            verify_worker(&state.nir1_graph, &library)\n        }\n",
    ],
    [
      "setter in a comment",
      "        // configure_worker_path is Main's.\n" + verify,
    ],
    [
      "factory slot write",
      "        Ok(library) => {\n            let _ = state.nir1_graph.shared.worker.set(todo!());\n            verify_worker(&state.nir1_graph, &library)\n        }\n",
    ],
    [
      "own factory",
      "        Ok(library) => {\n            let _ = ProcessGraphWorkerFactory::from_path(library.clone());\n            verify_worker(&state.nir1_graph, &library)\n        }\n",
    ],
  ]) {
    const messages = checkNotReachable(mutate(PATHS.nodeEvalMod, verify, to))
      .map((violation) => violation.message)
      .join("\n");
    assert.ok(messages.includes(SETTER), `${label}: ${messages}`);
  }
});

test("reading Main's worker path outside `verify_worker`, or not verifying in `register`, is refused", () => {
  const twice = mutate(
    PATHS.nodeEvalMod,
    "pub(crate) fn register(state: &Arc<AppState>) {\n",
    "pub(crate) fn register(state: &Arc<AppState>) {\n    let _ = state.nir1_graph.configured_worker_path_for_eval();\n",
  );
  assert.ok(
    checkNotReachable(twice).some((violation) =>
      /must be read once, from `verify_worker`/.test(violation.message),
    ),
  );
  const unverified = mutate(
    PATHS.nodeEvalMod,
    "        Ok(library) => verify_worker(&state.nir1_graph, &library),\n",
    "        Ok(_library) => WorkerSetup::NotAttempted,\n",
  );
  assert.ok(
    checkNotReachable(unverified).some((violation) =>
      /`verify_worker` must be called from `register` only/.test(
        violation.message,
      ),
    ),
  );
});

test("the worker path accessor of the product owner without the feature is refused", () => {
  const sources = mutate(
    PATHS.nodeProduct,
    `    #[cfg(feature = "${EVAL_FEATURE}")]\n    fn worker_path_for_eval(&self) -> Option<&Path> {\n        Some(&self.worker)\n    }\n`,
    "    fn worker_path_for_eval(&self) -> Option<&Path> {\n        Some(&self.worker)\n    }\n",
  );
  const messages = checkEvalFeatureAllowlist(sources)
    .map((violation) => violation.message)
    .join("\n");
  assert.match(messages, /must appear exactly once \(found 0\)/);
  assert.match(messages, /`_for_eval` appears outside the allowlist/);
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
    /every Busy answer of `begin` and `begin_deferred` needs its cause hook/,
  );
});

test("CQ-DEFER: a Busy answer of begin_deferred without its hook, or a begin outside the probe, is refused", () => {
  const held = mutate(
    PATHS.nodeProduct,
    `                #[cfg(feature = "${EVAL_FEATURE}")]\n                crate::nir1_graph_eval::note_busy_cause("deferred-held");\n`,
    "",
  );
  assert.match(
    checkEvalFeatureAllowlist(held)
      .map((violation) => violation.message)
      .join("\n"),
    /allowlisted site must appear exactly once/,
  );
  // 共有の snippet：保留の側を消すと 2 つのうち 1 つだけが残る。
  const shared = mutate(
    PATHS.nodeProduct,
    `                    #[cfg(feature = "${EVAL_FEATURE}")]\n                    crate::nir1_graph_eval::note_busy_cause("preparing-other-key");\n                    self.unserved(GraphUnavailable::Busy, &demand.key.project_id)\n                }\n                Some(session) => {\n                    session.last_demand = demand.now;\n                    self.unserved(GraphUnavailable::Warming, &demand.key.project_id)\n                }\n                None => self.unserved(GraphUnavailable::Warming, &demand.key.project_id),\n            },\n            Phase::InUse`,
    `                    self.unserved(GraphUnavailable::Busy, &demand.key.project_id)\n                }\n                Some(session) => {\n                    session.last_demand = demand.now;\n                    self.unserved(GraphUnavailable::Warming, &demand.key.project_id)\n                }\n                None => self.unserved(GraphUnavailable::Warming, &demand.key.project_id),\n            },\n            Phase::InUse`,
  );
  assert.match(
    checkEvalFeatureAllowlist(shared)
      .map((violation) => violation.message)
      .join("\n"),
    /allowlisted site must appear exactly 2 times \(found 1\)/,
  );
  const unprobed = mutate(
    PATHS.nodeProduct,
    "        self.begin_probed(state, query, Shared::demand_deferred)",
    "        self.admit_and_route(state, query, Shared::demand_deferred)",
  );
  assert.match(
    checkEvalFeatureAllowlist(unprobed)
      .map((violation) => violation.message)
      .join("\n"),
    /`fn begin_deferred` must have exactly its fixed body/,
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

test("A-1: the product file opens the gate only in `open_publication_for_eval`, and only `record_registration` calls it (M1, M2)", () => {
  const anchor =
    "    pub(crate) fn cache_occupied_for_eval(&self) -> bool {\n        lock(&self.shared.cache).is_some()\n";
  for (const inserted of [
    // M1: a second store in another `*_for_eval` method of the eval block.
    "        self.shared.publication_open_for_eval.store(true, Ordering::SeqCst);\n",
    "        self.shared\n            .publication_open_for_eval\n            .store(true, Ordering::SeqCst);\n",
    "        self.shared.publication_open_for_eval.fetch_or(true, Ordering::SeqCst);\n",
    "        let _ = self.shared.publication_open_for_eval.swap(true, Ordering::SeqCst);\n",
  ]) {
    const sources = mutate(
      PATHS.nodeProduct,
      anchor,
      anchor.replace(
        "    pub(crate) fn cache_occupied_for_eval(&self) -> bool {\n",
        (head) => `${head}${inserted}`,
      ),
    );
    assert.ok(checkEvalFeatureAllowlist(sources).length > 0, inserted);
  }
  // M2: another method of the block calls the opener.
  for (const call of [
    "self.open_publication_for_eval();",
    "Self::open_publication_for_eval(self);",
    "Nir1GraphProductOwner::open_publication_for_eval(self);",
  ]) {
    const sources = mutate(
      PATHS.nodeProduct,
      "    pub(crate) fn slot_kind_for_eval(&self) -> GraphSlotKind {\n        self.slot_kind()\n",
      `    pub(crate) fn slot_kind_for_eval(&self) -> GraphSlotKind {\n        ${call}\n        self.slot_kind()\n`,
    );
    assert.match(
      checkEvalFeatureAllowlist(sources)
        .map((violation) => violation.message)
        .join("\n"),
      /open_publication_for_eval/,
      call,
    );
  }
  // The store moved out of the opener (the opener left empty) is refused too.
  const moved = mutate(
    PATHS.nodeProduct,
    "        self.shared\n            .publication_open_for_eval\n            .store(true, Ordering::SeqCst);\n    }\n",
    "    }\n",
  );
  assert.ok(checkEvalFeatureAllowlist(moved).length > 0);
});

test("A-1: a build script that turns the evaluation feature into another cfg is refused (M5b)", () => {
  for (const body of [
    'fn main() {\n    napi_build::setup();\n    if std::env::var_os("CARGO_FEATURE_NIR1_GRAPH_EVAL").is_some() {\n        println!("cargo:rustc-cfg=gx");\n    }\n}\n',
    'fn main() {\n    napi_build::setup();\n    if std::env::var("CARGO_CFG_FEATURE").unwrap_or_default().contains("graph") {\n        println!("cargo:rustc-cfg=gx");\n    }\n}\n',
  ]) {
    const sources = {
      ...real,
      "electron/native/grimodex-node/build.rs": body,
    };
    assert.ok(checkEvalFeatureAllowlist(sources).length > 0, body);
  }
});

test("A-1: a release check with a duplicate capability key is refused (M4)", () => {
  const duplicated = mutate(
    PATHS.verifyRelease,
    "    nir1GraphEval: false,\n",
    "    nir1GraphEval: false,\n    nir1GraphEval: true,\n",
  );
  assert.match(
    checkBuildCapabilities(duplicated)
      .map((violation) => violation.message)
      .join("\n"),
    /duplicate/,
  );
});
