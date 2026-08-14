import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { validateSemanticCoreBoundary } from "./validate-semantic-core-boundary.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function minimalFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-core-boundary-"));
  writeJson(root, "policies/narrative/mutation-authority-routes.json", {
    schemaVersion: 1,
    routes: [
      {
        id: "human-direct",
        requiredControls: ["typed-writer"],
        forbiddenCallers: ["background-maintenance"],
      },
      {
        id: "interactive-agent-command",
        requiredControls: ["typed-writer"],
        forbiddenCallers: ["background-maintenance"],
      },
      {
        id: "interpreter-projection",
        requiredControls: ["prepared-commit"],
        forbiddenCallers: ["background-maintenance"],
      },
      { id: "import-apply", requiredControls: ["typed-writer"], forbiddenCallers: [] },
      { id: "history-replay", requiredControls: ["journal-lineage"], forbiddenCallers: [] },
      {
        id: "restore-or-migration",
        requiredControls: ["semantic-epoch-event"],
        forbiddenCallers: [],
      },
    ],
  });
  writeJson(root, "policies/narrative/semantic-state-vocabulary.json", {
    schemaVersion: 1,
    reviewStates: ["unreviewed", "accepted", "rejected", "held", "superseded"],
    evidenceFreshness: ["fresh", "stale", "source-missing", "anchor-mismatch", "read-set-drift", "unknown"],
    reconciliationSignals: ["needs-reconciliation"],
    buildActions: ["none", "rebuild-required"],
    componentCompatibility: ["compatible"],
    projectionApplicationStates: ["unapplied", "applied", "compensated", "undone", "stale", "not-applicable"],
  });
  writeJson(root, "policies/narrative/semantic-core-authorities.json", {
    schemaVersion: 1,
    authorities: [{ concern: "evidence-freshness", canonicalAuthority: "consumer-freshness", compatibilityMirror: "legacy-projection-freshness" }],
    semanticIndexAllowedFields: ["generation", "builtAt", "sourceDigest", "dependencySetDigest", "dirtyCacheFlag"],
  });
  writeJson(root, "policies/narrative/retrieval-disclosure.json", {
    schemaVersion: 1,
    phaseResolutionModes: ["reading", "story", "auto"],
    rejectionRules: ["future-phase", "future-story-time", "secret-before-reveal", "knowledge-holder-mismatch", "reader-knowledge-not-character", "worldline-mismatch", "timeline-mismatch", "narrative-layer-mismatch"],
  });
  writeJson(root, "policies/narrative/change-feed-writers.json", {
    schemaVersion: 1,
    writerMatrix: [{ writer: "fixture.writer" }],
    operations: [{
      id: "fixture.write",
      feedPolicy: "required",
      authorityRoute: "human-direct",
      controls: ["typed-writer"],
    }],
  });
  mkdirSync(path.join(root, "src-tauri/crates/grimodex-core/src"), { recursive: true });
  writeFileSync(
    path.join(root, "src-tauri/crates/grimodex-core/src/lib.rs"),
    "pub const SCHEMA_VERSION: i32 = 22;\n",
  );
  return root;
}

describe("validate-semantic-core-boundary", () => {
  it("accepts the repository's ratified semantic contract", () => {
    const result = validateSemanticCoreBoundary({ repoRoot: REPO_ROOT });
    assert.deepEqual(result.errors, []);
    assert.ok(result.operationCount > 0);
    assert.equal(result.schemaVersion, 22);
  });

  it("fails closed for an unknown route and a forbidden interpreter import", () => {
    const root = minimalFixtureRoot();
    const manifest = path.join(root, "policies/narrative/change-feed-writers.json");
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    parsed.operations[0].authorityRoute = "unknown";
    writeFileSync(manifest, JSON.stringify(parsed));
    mkdirSync(path.join(root, "src/features/narrative-extraction/reconciler"), { recursive: true });
    writeFileSync(
      path.join(root, "src/features/narrative-extraction/reconciler/bad.ts"),
      'import { agentCreateCodexEntry } from "@/features/agent-writes/codex";\nimport { createCodexEntry } from "@/features/codex/api";\n',
    );
    mkdirSync(path.join(root, "src-tauri/crates/grimodex-semantic/src"), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, "src-tauri/crates/grimodex-semantic/src/bad.rs"),
      "use grimodex_db::agent_writes::agent_codex_create_impl;\nfn bad() { agent_writes::agent_codex_create_impl(); }\n",
    );

    const result = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(result.errors.some((error) => /unknown authority route/i.test(error)));
    assert.ok(result.errors.some((error) => /forbidden.*agent writer|interpreter.*agent/i.test(error)));
    assert.ok(result.errors.some((error) => /Domain API directly/i.test(error)));
  });

  it("validates every authority variant instead of trusting one static label", () => {
    const root = minimalFixtureRoot();
    const manifest = path.join(root, "policies/narrative/change-feed-writers.json");
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    parsed.operations[0].authorityVariants = [
      { authorityRoute: "unknown-route", controls: [] },
    ];
    writeFileSync(manifest, JSON.stringify(parsed));

    const result = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(result.errors.some((error) => /unknown authority route/i.test(error)));
  });
});
