import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isAllowedForWriter,
  validateNativeWriterOwnership,
} from "./validate-native-writer-ownership.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  "policies/narrative/protected-writers.json",
);

const EXPECTED_C2A_WRITERS = new Map([
  ["narrative_extraction_tasks", "narrative.extraction-task"],
  ["narrative_extraction_attempts", "narrative.extraction-attempt"],
  ["narrative_extraction_artifacts", "narrative.extraction-artifact"],
  ["narrative_extraction_stage_model_bindings", "narrative.stage-provenance"],
  ["narrative_extraction_stage_receipts", "narrative.stage-provenance"],
]);

test("NIR-1 cache ownership is scoped to its exact module and table", () => {
  const directory =
    "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_chronicle_index/";
  const owns = (file, table) =>
    isAllowedForWriter(file, "narrative.authority", table);
  assert.equal(
    owns(`${directory}publish.rs`, "narrative_nir1_chronicle_vectors"),
    true,
  );
  assert.equal(
    owns(`${directory}publish.rs`, "narrative_semantic_index_metadata"),
    true,
  );
  assert.equal(
    owns(`${directory}invalidate.rs`, "narrative_semantic_index_metadata"),
    true,
  );
  assert.equal(
    owns(`${directory}invalidate.rs`, "narrative_nir1_chronicle_vectors"),
    false,
  );
  assert.equal(
    owns(`${directory}publish.rs`, "narrative_consumer_freshness"),
    false,
  );
  assert.equal(
    owns(
      "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_entity_relation_index.rs",
      "narrative_semantic_index_metadata",
    ),
    true,
  );
  assert.equal(
    owns(
      "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_entity_relation_index.rs",
      "narrative_consumer_freshness",
    ),
    false,
  );
  assert.equal(
    owns(`${directory}query.rs`, "narrative_nir1_chronicle_vectors"),
    false,
  );
  assert.equal(
    owns(
      "electron/native/grimodex-node/src/publish.rs",
      "narrative_nir1_chronicle_vectors",
    ),
    false,
  );
});

test("C2A protected tables use the exact Native writer registry and pass ownership", () => {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const actual = new Map(
    registry
      .filter((entry) => EXPECTED_C2A_WRITERS.has(entry.table))
      .map((entry) => [entry.table, entry]),
  );

  assert.deepEqual(
    [...actual.keys()].sort(),
    [...EXPECTED_C2A_WRITERS.keys()].sort(),
  );
  for (const [table, writer] of EXPECTED_C2A_WRITERS) {
    assert.equal(actual.get(table).enforcement, "active");
    assert.equal(actual.get(table).writer, writer);
  }

  const result = validateNativeWriterOwnership({
    repoRoot: REPO_ROOT,
    registryPath: REGISTRY_PATH,
  });
  assert.deepEqual(result.violations, []);
});
