import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readScopePolicy() {
  return JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        "policies/narrative/narrative-scope-relation-contract.json",
      ),
      "utf8",
    ),
  );
}

function readArtifactPolicy() {
  return JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        "policies/narrative/narrative-artifact-authority.json",
      ),
      "utf8",
    ),
  );
}

test("declares historical scope authority as future-only and stopped", () => {
  const historical = readScopePolicy().historicalAuthorityBasis;
  assert.deepEqual(historical, {
    contractId: "narrative-scope-authority-basis/2",
    schema:
      "policies/narrative/schemas/narrative-scope-authority-basis-v2.schema.json",
    futureCarrierArtifactKind: "source.snapshot@2",
    basisKind: "historical-run-snapshot",
    sourceKind: "snapshot-document",
    sourceKeyPattern: "snapshot:<runId>",
    currentOracle: false,
    runtimeStopCode: "NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE",
    v1Compatibility: {
      implicitUpgrade: "forbidden",
      rebuildRequired: true,
    },
    implementationStatus: {
      state: "declared",
      productionEntryPoints: [],
      blockedOn: [
        "native-scope-authority-basis-producer",
        "native-scope-authority-basis-resolver",
        "c2b-scope-override-wiring",
        "project-scope-order-authority",
      ],
    },
  });
});

test("does not promote the historical carrier through generic artifact authority", () => {
  const artifacts = readArtifactPolicy().artifacts;
  const extractionArtifact = artifacts.find(
    (artifact) => artifact.id === "extraction-artifact",
  );
  assert.deepEqual(
    {
      authority: extractionArtifact?.authority,
      authoritative: extractionArtifact?.authoritative,
    },
    { authority: "none", authoritative: false },
  );
  assert.equal(
    artifacts.some((artifact) => artifact.id === "scope-authority-basis"),
    false,
  );
  assert.equal(
    artifacts.filter(
      (artifact) =>
        artifact.storage === "narrative_extraction_artifacts" &&
        artifact.authoritative === true,
    ).length,
    0,
  );
});
