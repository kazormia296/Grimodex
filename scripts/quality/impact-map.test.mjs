import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import yaml from "js-yaml";

import {
  LIGHT_SUITE_DEFINITIONS,
  collectChangedPaths,
  formatImpactSummary,
  parseImpactMap,
  selectImpact,
} from "./impact-map.mjs";

test("the AI routing light suite executes browser transport contracts", () => {
  const commandText = JSON.stringify(
    LIGHT_SUITE_DEFINITIONS["ai-routing"].commands,
  );
  assert.match(commandText, /src\/lib\/browser-ai\.test\.ts/);
  assert.match(commandText, /src\/lib\/browser-mock\.ai-runtime\.test\.ts/);
  assert.match(commandText, /test:cloudflare-editor-deploy/);
});

test("Windows command runners invoke pnpm shims directly", async () => {
  const [impactSource, evaluationRuntimeSource, certifySource] =
    await Promise.all([
      readFile(new URL("./impact-map.mjs", import.meta.url), "utf8"),
      readFile(
        new URL("./quality-evaluation-runtime.mjs", import.meta.url),
        "utf8",
      ),
      readFile(new URL("./certify-gate-b2.mjs", import.meta.url), "utf8"),
    ]);
  assert.match(impactSource, /pnpm\.cmd/);
  assert.match(evaluationRuntimeSource, /pnpm\.cmd/);
  assert.doesNotMatch(impactSource, /process\.env\.ComSpec/);
  assert.doesNotMatch(evaluationRuntimeSource, /process\.env\.ComSpec/);
  assert.doesNotMatch(certifySource, /process\.env\.ComSpec/);
  assert.doesNotMatch(impactSource, /\["\/d", "\/s", "\/c"/);
  assert.doesNotMatch(evaluationRuntimeSource, /\["\/d", "\/s", "\/c"/);
  assert.doesNotMatch(certifySource, /\["\/d", "\/s", "\/c"/);
});

test("the Narrative Extraction suite executes the deterministic Human Gold gate", () => {
  const commandText = JSON.stringify(
    LIGHT_SUITE_DEFINITIONS["narrative-extraction"].commands,
  );
  assert.match(commandText, /eval:narrative/);
});

test("the Narrative runtime suite executes incremental Freshness integration", () => {
  const commands = LIGHT_SUITE_DEFINITIONS["narrative-runtime"].commands;
  const commandLines = commands.map((command) => command.join(" "));
  const commandText = JSON.stringify(commands);
  assert.match(commandText, /test:narrative:run-kind-policy/);
  assert.match(commandText, /test:narrative:execution-state/);
  assert.match(commandText, /electron\/main\/narrativeFreshness\.test\.ts/);
  assert.match(commandText, /electron\/tsconfig\.json/);
  assert.match(commandText, /narrative_runtime_authority/);
  assert.match(commandText, /narrative_incremental_freshness_runtime/);
  assert.match(commandText, /electron\/native\/grimodex-node\/Cargo\.toml/);
  assert.ok(
    commandLines.includes(
      "pnpm test:electron --run electron/main/narrativeFreshness.test.ts",
    ),
  );
  assert.ok(
    commandLines.includes("pnpm exec tsc -p electron/tsconfig.json --noEmit"),
  );
  assert.ok(
    commandLines.includes(
      "cargo check --manifest-path electron/native/grimodex-node/Cargo.toml",
    ),
  );
  assert.ok(
    commandLines.includes(
      "node --test scripts/product-journey-phase1.test.mjs scripts/c2-5b-product-journeys.test.mjs scripts/c2zc-product-journeys.test.mjs",
    ),
  );
});

test("the Narrative semantic suite executes terminal timestamp and projection gates", () => {
  const commandText = JSON.stringify(
    LIGHT_SUITE_DEFINITIONS["narrative-semantic-contract"].commands,
  );
  assert.match(
    commandText,
    /narrative_extraction::execution_state::tests::run_transition_persists_millisecond_rfc3339_timestamps/,
  );
  assert.match(
    commandText,
    /narrative_extraction::repository::unit_tests::every_generic_public_task_api_rejects_runtime_owned_automatic_runs/,
  );
  assert.match(
    commandText,
    /narrative_extraction::repository::unit_tests::list_resumable_runs_orders_mixed_legacy_and_rfc3339_instants/,
  );
  assert.match(
    commandText,
    /narrative_extraction::legacy_backfill::tests::backfill_owner_finalizer_survives_generic_cancel_phase_gap/,
  );
  assert.match(commandText, /narrative_scope_authority_runtime/);
  assert.match(commandText, /narrative_scope_authority_basis/);
  assert.match(commandText, /scopeAuthorityBasisV2\.contract\.test\.ts/);
  assert.match(commandText, /projectSnapshotAdapter\.test\.ts/);
  assert.match(commandText, /extractionCoordinator\.test\.ts/);
  assert.match(commandText, /electron\/shared\/ipcContract\.test\.ts/);
  assert.match(
    commandText,
    /narrative_extraction::restore_rebuild::tests::rebuild_finalization_after_epoch_rotation_is_failed_and_returns_error/,
  );
  assert.match(commandText, /narrative_terminal_failure_projection/);
});

test("incremental Freshness runtime changes select the Narrative runtime gate", async () => {
  const source = await readFile(
    new URL("../../evals/impact-map.yaml", import.meta.url),
    "utf8",
  );
  const map = parseImpactMap(source);

  for (const changedPath of [
    "policies/narrative/narrative-run-kind-policy.json",
    "policies/narrative/schemas/narrative-run-kind-policy.schema.json",
    "scripts/quality/validate-run-kind-policy.mjs",
    "scripts/quality/validate-run-kind-policy.test.mjs",
    "scripts/quality/validate-execution-state-authority.mjs",
    "scripts/quality/validate-execution-state-authority.test.mjs",
    "policies/narrative/narrative-failure-policy.json",
    "electron/main/index.ts",
    "electron/main/narrativeFreshness.ts",
    "electron/main/narrativeFreshness.test.ts",
    "electron/shared/ipcContract.ts",
    "electron/shared/ipcContract.test.ts",
    "electron/native/grimodex-node/Cargo.toml",
    "electron/native/grimodex-node/index.d.ts",
    "electron/native/grimodex-node/src/lib.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs",
    "src-tauri/crates/grimodex-db/tests/narrative_incremental_freshness_runtime.rs",
  ]) {
    const selection = selectImpact(map, [changedPath]);
    assert.ok(
      selection.matchedRuleIds.includes("narrative-runtime-authority"),
      changedPath,
    );
    assert.ok(selection.requirementIds.includes("GDX-POLICY-001"));
    assert.ok(selection.requirementIds.includes("GDX-TRACE-001"));
    assert.ok(selection.suiteIds.includes("narrative-runtime"));
    assert.equal(selection.fallback, false);
  }
});

test("the Narrative Extraction command includes deterministic Detail contracts", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const command = packageJson.scripts["eval:narrative"];

  assert.match(command, /src\/features\/codex\/details/);
  assert.match(command, /detailPresets\.test\.ts/);
  assert.match(command, /detailPresets\.semantic\.test\.ts/);
});

test("the Narrative Extraction command includes deterministic Temporal contracts", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const command = packageJson.scripts["eval:narrative"];

  assert.match(command, /narrative-extraction\/temporal/);
  assert.match(command, /application\/narrative-extraction\/temporal/);
  assert.match(command, /chronicle\/calendar/);
  assert.match(command, /ChronicleCalendarEditor\.test\.tsx/);
  assert.match(command, /ChronicleCalendarPopover\.test\.tsx/);
  assert.match(command, /ChronicleToolbar\.test\.tsx/);
  assert.match(command, /projectCalendarSchema\.test\.ts/);
  assert.match(command, /projectSnapshotApi\.test\.ts/);
});

test("Narrative Extraction changes select every Narrative semantic requirement", async () => {
  const source = await readFile(
    new URL("../../evals/impact-map.yaml", import.meta.url),
    "utf8",
  );
  const map = parseImpactMap(source);
  const selection = selectImpact(map, [
    "src/features/narrative-extraction/eval/scorer.ts",
  ]);

  assert.ok(selection.matchedRuleIds.includes("narrative-extraction"));
  assert.ok(selection.suiteIds.includes("narrative-extraction"));
  for (const requirementId of [
    "GDX-NARR-EVAL-001",
    "GDX-NARR-EVIDENCE-001",
    "GDX-NARR-SEMANTIC-001",
    "GDX-NARR-COVERAGE-001",
    "GDX-NARR-DETAIL-001",
    "GDX-NARR-TEMPORAL-001",
  ]) {
    assert.ok(selection.requirementIds.includes(requirementId));
  }
  assert.equal(selection.fallback, false);
});

test("NIR-0 Wave 1 contracts remain traceable to the semantic Light gate", async () => {
  const [impactSource, manifestSource] = await Promise.all([
    readFile(new URL("../../evals/impact-map.yaml", import.meta.url), "utf8"),
    readFile(
      new URL("../../evals/quality-manifest.yaml", import.meta.url),
      "utf8",
    ),
  ]);
  const map = parseImpactMap(impactSource);
  const manifest = yaml.load(manifestSource);
  const requirement = manifest.requirements.find(
    (candidate) => candidate.id === "GDX-NARR-SEMANTIC-CONTRACT-001",
  );
  assert.ok(requirement, "semantic contract requirement must exist");
  const artifactRequirement = manifest.requirements.find(
    (candidate) => candidate.id === "GDX-ARTIFACT-001",
  );
  assert.ok(artifactRequirement, "artifact requirement must exist");
  for (const relativePath of [
    "policies/narrative/narrative-artifact-authority.json",
    "policies/narrative/schemas/narrative-artifact-authority.schema.json",
  ]) {
    assert.ok(
      artifactRequirement.implementedBy.includes(relativePath),
      `${relativePath} must be listed in artifact requirement implementedBy`,
    );
  }

  const implementations = [
    "policies/narrative/fixtures/canonical-json-number-parity.json",
    "src/features/narrative-semantic-core/contracts/scopeV2.ts",
    "src/features/narrative-semantic-core/contracts/narrativeIr.ts",
    "src/features/narrative-semantic-core/contracts/scopeRelation.ts",
    "src/features/narrative-extraction/source/digest.ts",
    "src/features/narrative-extraction/source/scopeAuthorityBasisV2.ts",
    "src/features/narrative-extraction/source/types.ts",
    "src/features/tree/api.ts",
    "src/application/narrative-extraction/nativeApi.ts",
    "src/application/narrative-extraction/projectSnapshotAdapter.ts",
    "electron/shared/ipcContract.ts",
    "src-tauri/crates/grimodex-core/src/canonical_json.rs",
    "src-tauri/crates/grimodex-core/src/narrative_ir.rs",
    "src-tauri/crates/grimodex-core/src/narrative_scope_authority_basis.rs",
    "src/features/narrative-extraction/reconciler/stageExecution.ts",
    "src/features/narrative-extraction/reconciler/types.ts",
    "src/features/narrative-extraction/reconciler/v2Adapter.ts",
    "src/features/narrative-extraction/reconciler/chroniclePromptBuilder.ts",
    "src/application/narrative-extraction/aiTasks/chronicleStageAudit.ts",
    "src/application/narrative-extraction/aiTasks/runObservationExtractionTask.ts",
    "src/application/narrative-extraction/aiTasks/runEventSynthesisTask.ts",
    "src/application/narrative-extraction/aiTasks/runStructuredRepairTask.ts",
    "src/application/narrative-extraction/extractionCoordinator.ts",
    "src/features/narrative-extraction/proposals/chronicleSceneEventAdapter.ts",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/execution_state.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/scope_authority_runtime.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/task_leases.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/legacy_backfill.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/restore_rebuild.rs",
  ];
  const tests = [
    "src/features/narrative-semantic-core/contracts/scopeV2.test.ts",
    "src/features/narrative-semantic-core/contracts/narrativeIr.test.ts",
    "src/features/narrative-semantic-core/contracts/scopeRelation.test.ts",
    "src/features/narrative-extraction/source/canonicalJsonNumberParity.test.ts",
    "src/features/narrative-extraction/source/scopeAuthorityBasisV2.contract.test.ts",
    "src/features/tree/api.listProjection.test.ts",
    "src/application/narrative-extraction/projectSnapshotAdapter.test.ts",
    "src/application/narrative-extraction/extractionCoordinator.test.ts",
    "electron/shared/ipcContract.test.ts",
    "src-tauri/crates/grimodex-core/tests/canonical_json.rs",
    "src-tauri/crates/grimodex-core/tests/narrative_ir.rs",
    "src-tauri/crates/grimodex-core/tests/narrative_scope_authority_basis.rs",
    "src/features/narrative-extraction/reconciler/stageExecution.test.ts",
    "src/features/narrative-extraction/reconciler/v2Adapter.test.ts",
    "src/features/narrative-extraction/reconciler/chroniclePromptBuilder.test.ts",
    "src/application/narrative-extraction/aiTasks/chronicleStageAudit.test.ts",
    "src/application/narrative-extraction/aiTasks/runStructuredRepairTask.test.ts",
    "src/features/narrative-extraction/proposals/chronicleSceneEventAdapter.test.ts",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/execution_state.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/task_leases.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/legacy_backfill.rs",
    "src-tauri/crates/grimodex-db/src/narrative_extraction/restore_rebuild.rs",
    "src-tauri/crates/grimodex-db/tests/narrative_terminal_failure_projection.rs",
    "src-tauri/crates/grimodex-db/tests/narrative_scope_authority_runtime.rs",
    "scripts/quality/impact-map.test.mjs",
  ];

  for (const relativePath of implementations) {
    assert.ok(
      requirement.implementedBy.includes(relativePath),
      `${relativePath} must be listed in semantic contract implementedBy`,
    );
  }
  for (const relativePath of tests) {
    assert.ok(
      requirement.lightTests.includes(relativePath),
      `${relativePath} must be listed in semantic contract lightTests`,
    );
  }

  for (const relativePath of [
    ...implementations,
    ...tests.filter(
      (relativePath) => relativePath !== "scripts/quality/impact-map.test.mjs",
    ),
  ]) {
    const selection = selectImpact(map, [relativePath]);
    assert.ok(
      selection.matchedRuleIds.includes("narrative-semantic-contract"),
      `${relativePath} must select the semantic contract rule`,
    );
    assert.ok(
      selection.requirementIds.includes("GDX-NARR-SEMANTIC-CONTRACT-001"),
      `${relativePath} must select the semantic contract requirement`,
    );
    assert.ok(
      selection.suiteIds.includes("narrative-semantic-contract"),
      `${relativePath} must select the semantic Light suite`,
    );
    assert.equal(selection.fallback, false, relativePath);
  }

  for (const relativePath of [
    "policies/narrative/narrative-artifact-authority.json",
    "policies/narrative/schemas/narrative-artifact-authority.schema.json",
  ]) {
    const selection = selectImpact(map, [relativePath]);
    assert.ok(
      selection.matchedRuleIds.includes("narrative-semantic-contract"),
      `${relativePath} must select the semantic contract rule`,
    );
    assert.ok(
      selection.requirementIds.includes("GDX-NARR-SEMANTIC-CONTRACT-001"),
      `${relativePath} must retain the semantic contract requirement`,
    );
    assert.ok(
      selection.requirementIds.includes("GDX-ARTIFACT-001"),
      `${relativePath} must select the artifact requirement`,
    );
    assert.ok(
      selection.suiteIds.includes("narrative-semantic-contract"),
      `${relativePath} must select the semantic Light suite`,
    );
    assert.equal(selection.fallback, false, relativePath);
  }
});

test("isolated Chronicle stage provenance changes select semantic and AI audit/routing gates", async () => {
  const source = await readFile(
    new URL("../../evals/impact-map.yaml", import.meta.url),
    "utf8",
  );
  const map = parseImpactMap(source);
  for (const changedPath of [
    "src/features/narrative-extraction/reconciler/stageProvenance.ts",
    "src/features/narrative-extraction/reconciler/stageProvenance.test.ts",
  ]) {
    const selection = selectImpact(map, [changedPath]);
    assert.ok(selection.matchedRuleIds.includes("narrative-semantic-contract"));
    assert.ok(selection.matchedRuleIds.includes("ai-audit-runtime"));
    assert.ok(selection.matchedRuleIds.includes("ai-routing"));
    assert.ok(
      selection.requirementIds.includes("GDX-NARR-SEMANTIC-CONTRACT-001"),
    );
    assert.ok(selection.requirementIds.includes("GDX-AI-AUDIT-001"));
    assert.ok(selection.requirementIds.includes("GDX-ROUTE-001"));
    assert.ok(selection.suiteIds.includes("narrative-semantic-contract"));
    assert.ok(selection.suiteIds.includes("ai-routing"));
    assert.equal(selection.fallback, false);
  }
  const transportSelection = selectImpact(map, [
    "src/features/ai-audit/transportContext.ts",
  ]);
  assert.ok(transportSelection.matchedRuleIds.includes("ai-routing"));
  assert.ok(transportSelection.matchedRuleIds.includes("ai-audit-runtime"));
  assert.ok(transportSelection.requirementIds.includes("GDX-AI-AUDIT-001"));
});

test("Temporal IR, adapter, and Calendar changes select the Temporal requirement", async () => {
  const source = await readFile(
    new URL("../../evals/impact-map.yaml", import.meta.url),
    "utf8",
  );
  const map = parseImpactMap(source);

  for (const changedPath of [
    "src/features/narrative-extraction/temporal/graph.ts",
    "src/application/narrative-extraction/temporal/sceneTemporalAdapter.ts",
    "src/features/chronicle/calendar/extractionCalendarSnapshot.ts",
    "src/features/chronicle/ChronicleCalendarEditor.tsx",
    "src/features/chronicle/ChronicleCalendarPopover.tsx",
    "src/features/chronicle/ChronicleCalendarPopover.test.tsx",
    "src/features/revision/projectSnapshotApi.ts",
    "src/db/schema.ts",
    "src/db/generated/schema-contract.json",
    "src/db/projectCalendarSchema.test.ts",
    "src/lib/browser-mock.ts",
    "scripts/schema-seed-ja.sql",
    "src-tauri/crates/grimodex-core/src/workspace_schema.rs",
    "src-tauri/crates/grimodex-db/src/migrate.rs",
    "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
  ]) {
    const selection = selectImpact(map, [changedPath]);
    assert.ok(selection.requirementIds.includes("GDX-NARR-TEMPORAL-001"));
    assert.ok(selection.suiteIds.includes("narrative-extraction"));
    assert.equal(selection.fallback, false);
  }
});

test("Detail codec and preset changes select the Narrative Detail requirement", async () => {
  const source = await readFile(
    new URL("../../evals/impact-map.yaml", import.meta.url),
    "utf8",
  );
  const map = parseImpactMap(source);

  for (const changedPath of [
    "src/features/codex/details/detailValueCodec.ts",
    "src/features/codex/detailPresets.ts",
  ]) {
    const selection = selectImpact(map, [changedPath]);
    assert.ok(selection.matchedRuleIds.includes("narrative-extraction"));
    assert.ok(selection.requirementIds.includes("GDX-NARR-DETAIL-001"));
    assert.ok(selection.suiteIds.includes("narrative-extraction"));
    assert.equal(selection.fallback, false);
  }
});

test("the extracted chat stream transport preserves audit and Web Editor impact coverage", async () => {
  const source = await readFile(
    new URL("../../evals/impact-map.yaml", import.meta.url),
    "utf8",
  );
  const map = parseImpactMap(source);
  const selection = selectImpact(map, [
    "src/features/chat/chatStreamTransport.ts",
  ]);

  assert.ok(selection.matchedRuleIds.includes("ai-audit-runtime"));
  assert.ok(selection.matchedRuleIds.includes("web-editor-ai"));
  assert.ok(selection.requirementIds.includes("GDX-AI-AUDIT-001"));
  assert.ok(selection.requirementIds.includes("GDX-AI-CONSENT-001"));
  assert.ok(selection.suiteIds.includes("quality-workflow"));
  assert.ok(selection.suiteIds.includes("ai-routing"));
  assert.ok(selection.suiteIds.includes("tool-policy"));
  assert.equal(selection.fallback, false);
});

test("semantic recall and reranker runtimes preserve audit impact coverage", async () => {
  const source = await readFile(
    new URL("../../evals/impact-map.yaml", import.meta.url),
    "utf8",
  );
  const map = parseImpactMap(source);
  const runtimePaths = [
    "src/features/chat/semanticRecall.ts",
    "src/features/chat/semanticRerankerApply.ts",
    "src/features/chat/semanticRerankerShadow.ts",
  ];

  for (const runtimePath of runtimePaths) {
    const selection = selectImpact(map, [runtimePath]);

    assert.ok(
      selection.matchedRuleIds.includes("ai-audit-runtime"),
      runtimePath,
    );
    assert.ok(
      selection.matchedRuleIds.includes("retrieval-grounding"),
      runtimePath,
    );
    assert.ok(
      selection.requirementIds.includes("GDX-AI-AUDIT-001"),
      runtimePath,
    );
    assert.ok(selection.suiteIds.includes("ai-routing"), runtimePath);
    assert.ok(selection.suiteIds.includes("retrieval-grounding"), runtimePath);
    assert.equal(selection.fallback, false, runtimePath);
  }
});

const execFileAsync = promisify(execFile);
const ALLOWED_SUITES = ["quality-workflow", "ai-routing", "tool-policy"];

const VALID_MAP = `
version: 1
allSuites:
  - quality-workflow
  - ai-routing
  - tool-policy
rules:
  - id: global-workflow
    reason: Global workflow rules affect every AI behavior surface.
    paths:
      - AGENTS.md
      - .agents/skills/**
    requirements:
      - GDX-TRACE-001
    suites:
      - all
  - id: prompts
    reason: Prompt changes affect routing and output contracts.
    paths:
      - src/prompts/**
    requirements:
      - GDX-ROUTE-001
    suites:
      - ai-routing
  - id: source-policy
    reason: Source policy changes require the policy lane.
    paths:
      - src/**
    requirements:
      - GDX-POLICY-001
    suites:
      - tool-policy
default: all
`;

test("matching rules are unioned and normalized deterministically", () => {
  const map = parseImpactMap(VALID_MAP, { allowedSuites: ALLOWED_SUITES });
  const selection = selectImpact(map, [
    "src\\prompts\\ja\\chatSystem.ts",
    "src/prompts/ja/chatSystem.ts",
  ]);

  assert.deepEqual(selection.changedPaths, ["src/prompts/ja/chatSystem.ts"]);
  assert.deepEqual(selection.matchedRuleIds, ["prompts", "source-policy"]);
  assert.deepEqual(selection.requirementIds, [
    "GDX-ROUTE-001",
    "GDX-POLICY-001",
  ]);
  assert.deepEqual(selection.suiteIds, ["ai-routing", "tool-policy"]);
  assert.equal(selection.fallback, false);
});

test("a global rule expands all suites", () => {
  const map = parseImpactMap(VALID_MAP, { allowedSuites: ALLOWED_SUITES });
  const selection = selectImpact(map, ["AGENTS.md"]);

  assert.deepEqual(selection.suiteIds, ALLOWED_SUITES);
  assert.equal(selection.fallback, false);
  assert.equal(selection.allSelected, true);
});

test("any unclassified path forces the safe all-suite fallback", () => {
  const map = parseImpactMap(VALID_MAP, { allowedSuites: ALLOWED_SUITES });
  const selection = selectImpact(map, [
    "src/prompts/en/chatSystem.ts",
    "docs/unclassified-note.md",
  ]);

  assert.deepEqual(selection.suiteIds, ALLOWED_SUITES);
  assert.equal(selection.fallback, true);
  assert.deepEqual(selection.unmatchedPaths, ["docs/unclassified-note.md"]);
  assert.match(selection.reason, /unclassified/i);
});

test("an empty or unavailable diff also fails safe to all suites", () => {
  const map = parseImpactMap(VALID_MAP, { allowedSuites: ALLOWED_SUITES });

  const empty = selectImpact(map, []);
  assert.deepEqual(empty.suiteIds, ALLOWED_SUITES);
  assert.equal(empty.fallback, true);

  const unavailable = selectImpact(map, ["src/prompts/en/chatSystem.ts"], {
    forceAllReason: "git diff unavailable",
  });
  assert.deepEqual(unavailable.suiteIds, ALLOWED_SUITES);
  assert.equal(unavailable.fallback, true);
  assert.match(unavailable.reason, /git diff unavailable/);
});

test("map parsing rejects ambiguous rules and unsupported glob syntax", () => {
  assert.throws(
    () =>
      parseImpactMap(
        VALID_MAP.replace("src/prompts/**", "src/prompts/[a-z]/**"),
        { allowedSuites: ALLOWED_SUITES },
      ),
    /unsupported glob/i,
  );

  assert.throws(
    () =>
      parseImpactMap(
        VALID_MAP.replace("  - id: source-policy", "  - id: prompts"),
        { allowedSuites: ALLOWED_SUITES },
      ),
    /duplicate rule id/i,
  );

  assert.throws(
    () =>
      parseImpactMap(VALID_MAP.replace("tool-policy", "unknown-suite"), {
        allowedSuites: ALLOWED_SUITES,
      }),
    /unknown suite/i,
  );
});

test("the Markdown summary exposes change, requirement, suite, and fallback evidence", () => {
  const map = parseImpactMap(VALID_MAP, { allowedSuites: ALLOWED_SUITES });
  const summary = formatImpactSummary(
    selectImpact(map, ["docs/unclassified-note.md"]),
  );

  assert.match(summary, /Changed files/);
  assert.match(summary, /Affected requirements/);
  assert.match(summary, /Selected light suites/);
  assert.match(summary, /Fallback/);
  assert.match(summary, /docs\/unclassified-note\.md/);
});

test("working-tree collection includes rename endpoints, unstaged edits, and untracked files", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "grimodex-impact-"));
  await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "Quality Test"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["config", "user.email", "quality@example.test"], {
    cwd: repoRoot,
  });
  await writeFile(path.join(repoRoot, "old.txt"), "old\n");
  await writeFile(path.join(repoRoot, "tracked.txt"), "before\n");
  await execFileAsync("git", ["add", "old.txt", "tracked.txt"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["commit", "-qm", "base"], { cwd: repoRoot });
  const { stdout: baseStdout } = await execFileAsync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoRoot },
  );
  const base = baseStdout.trim();

  await execFileAsync("git", ["mv", "old.txt", "new.txt"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "tracked.txt"), "after\n");
  await writeFile(path.join(repoRoot, "untracked.txt"), "new\n");

  const changed = await collectChangedPaths({
    repoRoot,
    base,
    head: "HEAD",
  });

  assert.equal(changed.complete, true);
  assert.deepEqual(changed.paths, [
    "new.txt",
    "old.txt",
    "tracked.txt",
    "untracked.txt",
  ]);
});

test("an invalid comparison base is reported instead of silently trusting a partial diff", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "grimodex-impact-"));
  await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });

  const changed = await collectChangedPaths({
    repoRoot,
    base: "missing-base",
    head: "HEAD",
  });

  assert.equal(changed.complete, false);
  assert.match(changed.reason, /diff/i);
});
