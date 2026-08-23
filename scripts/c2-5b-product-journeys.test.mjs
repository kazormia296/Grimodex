import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import initSqlJs from "sql.js/dist/sql-asm.js";
import yaml from "js-yaml";

import {
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS,
  resolveProductJourneySet,
  resolveSelectedProductJourneys,
} from "../electron/scripts/product-journeys.mjs";
import {
  NARRATIVE_MAINTENANCE_FAULTS,
  NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES,
  NARRATIVE_MAINTENANCE_FOREGROUND_SYSTEM_WORK_MARKER,
  NARRATIVE_MAINTENANCE_FOREGROUND_TRIGGER,
  NARRATIVE_MAINTENANCE_INTERRUPTED_CODE,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
  NARRATIVE_MAINTENANCE_RETRY_OBSERVATION_MS,
  NARRATIVE_MAINTENANCE_SEAM_CONTRACT,
  NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
  NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
  NARRATIVE_MAINTENANCE_TRIGGERS,
  assertForegroundRunMarker,
  assertTerminalFailureEvidence,
  assertTransientAttemptEvidence,
  foregroundMarkedRuns,
  terminalRetryCandidates,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";
import {
  NARRATIVE_MAINTENANCE_ELECTRON_OWNER_GLOB,
  NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_DOMAIN_RULES,
} from "../electron/scripts/product-journey-catalog.mjs";
import { PRODUCT_JOURNEY_ELECTRON_PHASES } from "../electron/scripts/product-journey-harness.mjs";
import {
  resolveProductJourneyImpactCatalog,
  selectProductJourneys,
} from "../electron/scripts/product-journey-impact.mjs";
import {
  parseImpactMap,
  selectImpact,
} from "./quality/impact-map.mjs";

test("Run ledger scopes attempt evidence through task and Run ownership", async () => {
  const source = await readFile(
    new URL(
      "../electron/scripts/narrative-maintenance-product-journeys.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const runColumns = source.match(/const RUN_COLUMNS = `([\s\S]*?)`;/)?.[1];
  assert.ok(runColumns, "RUN_COLUMNS must remain a SQL projection contract");

  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.run(`
    CREATE TABLE narrative_extraction_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_kind TEXT,
      work_key TEXT,
      status TEXT,
      semantic_epoch_id TEXT,
      consumer_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      spec_json TEXT,
      terminal_reason_code TEXT,
      outcome_summary_json TEXT,
      spec_digest TEXT,
      catalog_digest TEXT,
      registry_digest TEXT
    );
    CREATE TABLE narrative_extraction_tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      status TEXT,
      input_json TEXT,
      created_at TEXT,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE narrative_extraction_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      failure_code TEXT
    );
  `);

  const attemptsColumns = database.exec(
    "PRAGMA table_info(narrative_extraction_attempts)",
  )[0].values;
  assert.equal(
    attemptsColumns.some((column) => column[1] === "run_id"),
    false,
    "attempts must remain owned by task_id, not gain a run_id column",
  );

  const insert = (sql, params) => database.run(sql, params);
  insert(
    "INSERT INTO narrative_extraction_runs (id, project_id, created_at) VALUES (?, ?, ?)",
    ["run-1", "project-1", "2026-08-23T00:00:00.000Z"],
  );
  insert(
    "INSERT INTO narrative_extraction_runs (id, project_id, created_at) VALUES (?, ?, ?)",
    ["run-2", "project-1", "2026-08-23T00:00:01.000Z"],
  );
  insert(
    "INSERT INTO narrative_extraction_tasks (id, run_id) VALUES (?, ?)",
    ["task-1", "run-1"],
  );
  insert(
    "INSERT INTO narrative_extraction_tasks (id, run_id) VALUES (?, ?)",
    ["task-2", "run-2"],
  );
  insert(
    "INSERT INTO narrative_extraction_attempts (id, task_id, attempt_number, status, started_at, failure_code) VALUES (?, ?, ?, ?, ?, ?)",
    [
      "attempt-1",
      "task-1",
      1,
      "failed",
      "2026-08-23T00:00:02.000Z",
      "older-code",
    ],
  );
  insert(
    "INSERT INTO narrative_extraction_attempts (id, task_id, attempt_number, status, started_at, failure_code) VALUES (?, ?, ?, ?, ?, ?)",
    [
      "attempt-2a",
      "task-1",
      2,
      "failed",
      "2026-08-23T00:00:03.000Z",
      "not-the-latest-code",
    ],
  );
  insert(
    "INSERT INTO narrative_extraction_attempts (id, task_id, attempt_number, status, started_at, failure_code) VALUES (?, ?, ?, ?, ?, ?)",
    [
      "attempt-2b",
      "task-1",
      2,
      "failed",
      "2026-08-23T00:00:03.000Z",
      NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
    ],
  );
  insert(
    "INSERT INTO narrative_extraction_attempts (id, task_id, attempt_number, status, started_at, failure_code) VALUES (?, ?, ?, ?, ?, ?)",
    [
      "attempt-foreign",
      "task-2",
      9,
      "failed",
      "2026-08-23T00:00:04.000Z",
      "foreign-run-code",
    ],
  );

  const result = database.exec(`
    SELECT ${runColumns}
      FROM narrative_extraction_runs r
     WHERE r.project_id = 'project-1'
     ORDER BY created_at
  `);
  const [ledger] = result;
  assert.ok(ledger, "the Run ledger query must return rows");
  const rows = ledger.values.map((values) =>
    Object.fromEntries(
      ledger.columns.map((column, index) => [column, values[index]]),
    ),
  );
  assert.deepEqual(
    rows.map((row) => ({
      id: row.id,
      attemptCount: row.attemptCount,
      maxAttemptNumber: row.maxAttemptNumber,
      lastAttemptStatus: row.lastAttemptStatus,
      lastAttemptFailureCode: row.lastAttemptFailureCode,
    })),
    [
      {
        id: "run-1",
        attemptCount: 3,
        maxAttemptNumber: 2,
        lastAttemptStatus: "failed",
        lastAttemptFailureCode: NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
      },
      {
        id: "run-2",
        attemptCount: 1,
        maxAttemptNumber: 9,
        lastAttemptStatus: "failed",
        lastAttemptFailureCode: "foreign-run-code",
      },
    ],
    "attempts from another task/Run must not contaminate any Run evidence",
  );
  database.close();
});

test("c2-5b runner set is explicit and preserves stable order", () => {
  const selected = resolveProductJourneySet("c2-5b");
  assert.deepEqual(
    selected.map((journey) => journey.id),
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS.map((journey) => journey.id),
  );
  assert.equal(selected.length, 11);
});

test("C2-5B fault and trigger seams are closed enums", () => {
  assert.deepEqual(NARRATIVE_MAINTENANCE_FAULTS, [
    "transient-io",
    "contract-violation",
    "process-interruption",
  ]);
  assert.deepEqual(NARRATIVE_MAINTENANCE_TRIGGERS, [
    "dependency-gap",
    "foreground-workspace-wake",
    "graphContractDigest-changed",
    "ruleRegistryDigest-changed",
    "producerGenerationSetDigest-changed",
  ]);
});

test("C2-5B journey seam constants keep exact durable failure contracts", () => {
  assert.equal(NARRATIVE_MAINTENANCE_TRANSIENT_CODE, "NEX_MAINTENANCE_TRANSIENT");
  assert.equal(
    NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
    "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_INTERRUPTED_CODE,
    "NEX_MAINTENANCE_INTERRUPTED",
  );
  assert.equal(NARRATIVE_MAINTENANCE_RETRY_OBSERVATION_MS, 1_250);
  assert.equal(
    NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
    "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    "c2-5b-product-journey-owner-v1",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
    "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_BARRIER_ID",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
    "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_CORRELATION",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_SEAM_CONTRACT.jsDigestAuthority,
    "durable native outcome skipEvidence fields",
  );
  assert.equal(NARRATIVE_MAINTENANCE_FOREGROUND_TRIGGER, "workspace-opened");
  assert.deepEqual(NARRATIVE_MAINTENANCE_FOREGROUND_SYSTEM_WORK_MARKER, [
    "trigger",
    "canonicalWorkKey",
    "authorityId",
    "generation",
    "productJourneyBarrierId",
    "correlation",
  ]);
});

test("foreground marker selects one native Run by immutable barrier, not row order", () => {
  const expected = {
    barrierId: "barrier-unique",
    correlation: "correlation-unique",
    trigger: "workspace-opened",
  };
  const unrelatedFreshness = {
    id: "freshness-unrelated",
    projectId: "project-1",
    runKind: "freshness-evaluation",
    workKey: "incremental-freshness",
    semanticEpochId: "epoch-1",
    status: "running",
    specJson: JSON.stringify({ domain: "freshness" }),
  };
  const markedRun = {
    id: "marked-run",
    projectId: "project-1",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
    semanticEpochId: "epoch-1",
    status: "running",
    specJson: JSON.stringify({
      systemWork: {
        trigger: "workspace-opened",
        canonicalWorkKey:
          "narrative-maintenance:v1/backfill/project-1/legacy-dependency-backfill:v2/epoch/epoch-1",
        authorityId: "authority-1",
        generation: 7,
        productJourneyBarrierId: expected.barrierId,
        correlation: expected.correlation,
      },
    }),
  };
  const selected = foregroundMarkedRuns(
    [unrelatedFreshness, markedRun],
    [],
    expected,
  );
  assert.deepEqual(selected.map((run) => run.id), ["marked-run"]);
  assert.equal(
    assertForegroundRunMarker(markedRun, expected).marker.authorityId,
    "authority-1",
  );
  assert.throws(
    () =>
      assertForegroundRunMarker(
        {
          ...markedRun,
          specJson: JSON.stringify({
            systemWork: {
              ...JSON.parse(markedRun.specJson).systemWork,
              productJourneyBarrierId: "wrong-barrier",
            },
          }),
        },
        expected,
      ),
    /productJourneyBarrierId/,
  );
});

test("transient and terminal validators reject fallback and same-millisecond false greens", () => {
  assert.throws(
    () =>
      assertTransientAttemptEvidence({
        terminalReasonCode: NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
        lastAttemptStatus: "failed",
        lastAttemptFailureCode: null,
        attemptCount: 2,
        maxAttemptNumber: 2,
      }),
    /exact NEX_MAINTENANCE_TRANSIENT/,
  );
  assert.throws(
    () =>
      assertTerminalFailureEvidence({
        status: "failed",
        terminalReasonCode: NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
        completedAt: null,
      }),
    /completedAt/,
  );
  const failed = {
    id: "failed-run",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
  };
  assert.deepEqual(
    terminalRetryCandidates(
      [
        failed,
        { ...failed, id: "same-ms-retry" },
        {
          ...failed,
          id: "other-work",
          workKey: "different-work",
        },
      ],
      failed,
    ).map((run) => run.id),
    ["same-ms-retry"],
  );
});

test("every actual C2-5B Electron launch phase is registered for diagnostics", () => {
  assert.equal(
    new Set(NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES).size,
    NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES.length,
    "C2-5B launch phases must be unique",
  );
  for (const phase of NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES) {
    assert.ok(PRODUCT_JOURNEY_ELECTRON_PHASES.includes(phase), phase);
  }
  const registeredC2Phases = PRODUCT_JOURNEY_ELECTRON_PHASES.filter((phase) =>
    phase.startsWith("c2-5b-"),
  );
  assert.deepEqual(
    registeredC2Phases,
    NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES,
    "C2-5B launch phase registry must stay in parity with the runner",
  );
});

test("c2-5b runner IDs are wired to the central catalog and impact selector", () => {
  assert.deepEqual(
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS.map((journey) => journey.id),
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  const selection = selectProductJourneys({
    catalog: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: [
      "electron/scripts/narrative-maintenance-product-journeys.mjs",
    ],
    mode: "all",
  });
  assert.deepEqual(
    selection.journeyIds,
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  assert.equal(selection.allSelected, true);
});

test("maintenance source changes select the executable C2-5B journey subset", () => {
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  for (const changedPath of [
    "src-tauri/crates/grimodex-db/src/narrative_extraction/legacy_backfill.rs",
    "electron/native/grimodex-node/src/lib.rs",
    "electron/main/narrativeFreshness.ts",
    "policies/narrative/narrative-run-kind-policy.json",
  ]) {
    const selection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
      mode: "affected",
    });
    assert.deepEqual(
      expectedIds.filter((id) => selection.journeyIds.includes(id)),
      expectedIds,
      changedPath,
    );
  }
});

test("C2-5B runtime/semantic impact is direct for every launch owner path", async () => {
  const [impactSource, qualityManifest] = await Promise.all([
    readFile(new URL("../evals/impact-map.yaml", import.meta.url), "utf8"),
    readFile(
      new URL("../evals/quality-manifest.yaml", import.meta.url),
      "utf8",
    ),
  ]);
  const impactMap = parseImpactMap(impactSource);
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  const ownerPaths = [
    ...NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS,
    "src-tauri/crates/grimodex-db/src/migrate.rs",
    "src-tauri/crates/grimodex-core/src/workspace_schema.rs",
    "src-tauri/crates/grimodex-db/src/backup_restore.rs",
  ];
  for (const changedPath of ownerPaths) {
    assert.ok(
      qualityManifest.includes(`- ${changedPath}`),
      `${changedPath} must remain traceable in the quality manifest`,
    );
    const productSelection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
      mode: "affected",
    });
    assert.deepEqual(productSelection.journeyIds, expectedIds, changedPath);
    assert.equal(productSelection.fallback, false, changedPath);
    assert.equal(productSelection.allSelected, false, changedPath);
    assert.ok(
      productSelection.matchedRuleIds.includes(
        "narrative-maintenance-product-journeys",
      ),
      changedPath,
    );

    const qualitySelection = selectImpact(impactMap, [changedPath]);
    assert.equal(qualitySelection.fallback, false, changedPath);
    assert.ok(
      qualitySelection.matchedRuleIds.includes("narrative-runtime-authority"),
      changedPath,
    );
    assert.ok(
      qualitySelection.matchedRuleIds.includes("narrative-semantic-contract"),
      changedPath,
    );
    assert.ok(
      qualitySelection.suiteIds.includes("narrative-runtime"),
      changedPath,
    );
    assert.ok(
      qualitySelection.suiteIds.includes("narrative-semantic-contract"),
      changedPath,
    );
  }
});

test("current C2-5B scheduler owner tests route directly to product and quality gates", async () => {
  const [entries, impactSource, qualityManifestSource] = await Promise.all([
    readdir(new URL("../electron/main/", import.meta.url), {
      withFileTypes: true,
    }),
    readFile(new URL("../evals/impact-map.yaml", import.meta.url), "utf8"),
    readFile(
      new URL("../evals/quality-manifest.yaml", import.meta.url),
      "utf8",
    ),
  ]);
  const currentOwnerTests = [
    ...entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith("narrativeMaintenance") &&
          entry.name.endsWith(".test.ts"),
      )
      .map((entry) => `electron/main/${entry.name}`),
    "electron/main/foregroundBarrierRelease.test.ts",
  ].sort();
  const qualityManifest = yaml.load(qualityManifestSource);
  const requirements = new Map(
    qualityManifest.requirements.map((requirement) => [
      requirement.id,
      requirement,
    ]),
  );
  const impactMap = parseImpactMap(impactSource);
  const expectedProductJourneyIds =
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
      (journey) => journey.id,
    );
  const expectedQualityRuleIds = [
    "narrative-runtime-authority",
    "narrative-semantic-contract",
  ];
  const expectedQualitySuiteIds = [
    "narrative-runtime",
    "narrative-semantic-contract",
  ];

  assert.ok(currentOwnerTests.length > 0);
  for (const changedPath of currentOwnerTests) {
    assert.ok(
      NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS.includes(changedPath),
      `${changedPath} must be an explicit C2-5B owner path`,
    );
    for (const requirementId of [
      "GDX-POLICY-001",
      "GDX-NARR-SEMANTIC-CONTRACT-001",
    ]) {
      assert.ok(
        requirements.get(requirementId)?.implementedBy.includes(changedPath),
        `${changedPath} must be traceable in ${requirementId}.implementedBy`,
      );
    }

    const productSelection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
      mode: "affected",
    });
    assert.deepEqual(productSelection.journeyIds, expectedProductJourneyIds);
    assert.equal(productSelection.fallback, false, changedPath);
    assert.equal(productSelection.allSelected, false, changedPath);
    assert.ok(
      productSelection.matchedRuleIds.includes(
        "narrative-maintenance-product-journeys",
      ),
      changedPath,
    );

    const qualitySelection = selectImpact(impactMap, [changedPath]);
    assert.equal(qualitySelection.fallback, false, changedPath);
    assert.deepEqual(qualitySelection.unmatchedPaths, [], changedPath);
    for (const ruleId of expectedQualityRuleIds) {
      assert.ok(qualitySelection.matchedRuleIds.includes(ruleId), changedPath);
    }
    for (const suiteId of expectedQualitySuiteIds) {
      assert.ok(qualitySelection.suiteIds.includes(suiteId), changedPath);
    }
  }
});

test("future narrativeMaintenance files route directly without safe-all fallback", async () => {
  const impactMap = parseImpactMap(
    await readFile(new URL("../evals/impact-map.yaml", import.meta.url), "utf8"),
  );
  const changedPath =
    "electron/main/narrativeMaintenance.futureRegression.test.ts";
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  const productSelection = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: [changedPath],
    mode: "affected",
  });
  assert.deepEqual(productSelection.journeyIds, expectedIds);
  assert.equal(productSelection.fallback, false);
  assert.equal(productSelection.allSelected, false);
  assert.ok(
    productSelection.matchedRuleIds.includes(
      "narrative-maintenance-product-journeys",
    ),
  );
  const qualitySelection = selectImpact(impactMap, [changedPath]);
  assert.equal(qualitySelection.fallback, false);
  assert.ok(
    qualitySelection.matchedRuleIds.includes("narrative-runtime-authority"),
  );
  assert.ok(
    qualitySelection.matchedRuleIds.includes("narrative-semantic-contract"),
  );
  assert.ok(qualitySelection.suiteIds.includes("narrative-runtime"));
  assert.ok(
    qualitySelection.suiteIds.includes("narrative-semantic-contract"),
  );
  assert.ok(
    PRODUCT_DOMAIN_RULES.find(
      (rule) => rule.id === "narrative-maintenance-product-journeys",
    )?.paths.includes(NARRATIVE_MAINTENANCE_ELECTRON_OWNER_GLOB),
  );
});

test("current narrativeMaintenance inventory remains explicit in the quality manifest", async () => {
  const [entries, qualityManifest] = await Promise.all([
    readdir(new URL("../electron/main/", import.meta.url), {
      withFileTypes: true,
    }),
    readFile(
      new URL("../evals/quality-manifest.yaml", import.meta.url),
      "utf8",
    ),
  ]);
  const currentInventory = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("narrativeMaintenance") &&
        entry.name.endsWith(".ts"),
    )
    .map((entry) => `electron/main/${entry.name}`)
    .sort();
  assert.ok(currentInventory.length > 0);
  for (const path of currentInventory) {
    assert.ok(
      NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS.includes(path),
      `${path} must be represented by the explicit maintenance owner inventory`,
    );
    assert.ok(
      qualityManifest.includes(`- ${path}`),
      `${path} must remain an explicit quality-manifest implementation path`,
    );
  }
});

test("central impact catalog emits C2-5B IDs that the Electron runner can execute", () => {
  const reportCatalog = resolveProductJourneyImpactCatalog("c2-5b");
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  assert.deepEqual(
    reportCatalog.map((journey) => journey.id),
    expectedIds,
  );
});

test("c2-5b selector executes only explicitly selected durable journeys", () => {
  const set = resolveProductJourneySet("c2-5b");
  const selected = resolveSelectedProductJourneys(
    set,
    JSON.stringify([
      "c2-5b-terminal-failure-inbox",
      "c2-5b-incremental-liveness",
    ]),
  );
  assert.deepEqual(
    selected.map((journey) => journey.id),
    ["c2-5b-terminal-failure-inbox", "c2-5b-incremental-liveness"],
  );
});
