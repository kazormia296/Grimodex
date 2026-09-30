import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  PRODUCT_CHAT_SCOPES,
  PRODUCT_CONTRACT_EXEMPTIONS,
  PRODUCT_CONTRACT_REQUIREMENTS,
  PRODUCT_DOMAIN_RULES,
  PRODUCT_INTERACTION_REQUIREMENTS,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG_DIGEST,
  PRODUCT_JOURNEY_COVERAGE_BACKLOG,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_NATIVE_PERSISTENCE_DOMAINS,
  PRODUCT_SCOPE_TRANSITIONS,
} from "../electron/scripts/product-journey-catalog.mjs";
import {
  formatCoverageError,
  validateProductJourneyCoverage,
} from "../electron/scripts/product-journey-coverage.mjs";
import {
  formatProductJourneyImpactSummary,
  resolveProductJourneyExecution,
  selectProductJourneys,
} from "../electron/scripts/product-journey-impact.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

function validate(overrides = {}) {
  return validateProductJourneyCoverage({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    requiredContracts: PRODUCT_CONTRACT_REQUIREMENTS,
    scopeTransitions: PRODUCT_SCOPE_TRANSITIONS,
    nativePersistenceDomains: PRODUCT_NATIVE_PERSISTENCE_DOMAINS,
    interactions: PRODUCT_INTERACTION_REQUIREMENTS,
    exemptions: PRODUCT_CONTRACT_EXEMPTIONS,
    backlog: PRODUCT_JOURNEY_COVERAGE_BACKLOG,
    authoritativeChatScopes: PRODUCT_CHAT_SCOPES,
    implementationIds: PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
    now: new Date("2026-07-30T00:00:00.000Z"),
    ...overrides,
  });
}

test("the current catalog has complete journey, contract, and interaction coverage", () => {
  const result = validate();

  assert.deepEqual(result.journeyIds, [
    "editor-persistence",
    "chat-authority-isolation",
    "workspace-switch-authority",
    "external-write-conflict",
    "cross-feature-authoring",
    "chat-stream-project-switch",
    "chat-stream-workspace-switch",
    "editor-pending-project-switch",
    "mcp-external-write-conflict",
    "chronicle-native-roundtrip",
    "lint-native-roundtrip",
    "map-native-roundtrip",
    "snapshot-native-roundtrip",
    "chronicle-extract-review-apply-reopen",
    "codex-entity-relation-review-apply-reopen",
    ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
      (journey) => journey.id,
    ),
    ...NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  ]);
  assert.equal(result.uncoveredContracts.length, 0);
  assert.equal(result.uncoveredInteractions.length, 0);
  assert.deepEqual(result.expiredExemptions, []);
  assert.deepEqual(result.exemptedContracts, [
    "scope-transition:chat-stream:folder",
    "scope-transition:chat-stream:codex",
    "scope-transition:chat-stream:snippet",
  ]);
  assert.equal(result.affectedReady, false);
});

test("catalog and runner implementation IDs must match exactly", () => {
  assert.throws(
    () =>
      validate({
        implementationIds: PRODUCT_JOURNEY_CATALOG.slice(1).map(
          (journey) => journey.id,
        ),
      }),
    /catalog and runner journey IDs differ.*editor-persistence/is,
  );
});

test("a required contract without a journey fails with an actionable error", () => {
  const requiredContracts = [
    ...PRODUCT_CONTRACT_REQUIREMENTS,
    {
      id: "scope-transition:chat-stream:branch",
      domains: ["chat", "branch-lifecycle"],
    },
  ];

  assert.throws(
    () =>
      validate({
        requiredContracts,
      }),
    (error) => {
      assert.match(
        error.message,
        /Uncovered product contract:\s+scope-transition:chat-stream:branch/,
      );
      assert.match(error.message, /Affected domains:\s+chat, branch-lifecycle/);
      assert.match(error.message, /map an existing journey to this contract/);
      assert.match(error.message, /add a new journey/);
      assert.match(
        error.message,
        /reviewed exemption with reason, tracking issue, and expiry/,
      );
      return true;
    },
  );
});

test("stale contracts and nonexistent journey exemptions are rejected", () => {
  const staleCatalog = PRODUCT_JOURNEY_CATALOG.map((journey, index) =>
    index === 0
      ? {
          ...journey,
          contracts: [...journey.contracts, "roundtrip:deleted-domain"],
        }
      : journey,
  );
  assert.throws(
    () => validate({ catalog: staleCatalog }),
    /unknown contract.*roundtrip:deleted-domain/i,
  );

  assert.throws(
    () =>
      validate({
        exemptions: [
          {
            targetType: "contract",
            targetId: PRODUCT_CONTRACT_REQUIREMENTS[0].id,
            journeyId: "deleted-journey",
            reason: "Temporary migration.",
            trackingIssue: "#429",
            expiresOn: "2026-08-30",
          },
        ],
      }),
    /unknown journey.*deleted-journey/i,
  );
});

test("scope and native persistence declarations require their canonical contracts", () => {
  assert.throws(
    () =>
      validate({
        scopeTransitions: [
          ...PRODUCT_SCOPE_TRANSITIONS,
          {
            authority: "lifecycle",
            operation: "chat-stream",
            scope: "branch",
            contractId: "scope-transition:chat-stream:missing",
          },
        ],
      }),
    /scope transition.*scope-transition:chat-stream:branch/i,
  );

  assert.throws(
    () =>
      validate({
        nativePersistenceDomains: [
          ...PRODUCT_NATIVE_PERSISTENCE_DOMAINS,
          {
            domain: "timeline",
            contractId: "native-command-roundtrip:missing",
          },
        ],
      }),
    /native persistence domain.*native-command-roundtrip:timeline/i,
  );
});

test("new interactions require a covering journey or a live reviewed exemption", () => {
  const interactions = [
    ...PRODUCT_INTERACTION_REQUIREMENTS,
    {
      id: "plugin->sqlite",
      domains: ["plugin", "sqlite"],
    },
  ];
  assert.throws(
    () => validate({ interactions }),
    /Uncovered product interaction:\s+plugin->sqlite/i,
  );

  const coveredByExemption = validate({
    interactions,
    exemptions: [
      ...PRODUCT_CONTRACT_EXEMPTIONS,
      {
        targetType: "interaction",
        targetId: "plugin->sqlite",
        reason:
          "Plugin journey is being implemented in the next rollout phase.",
        trackingIssue: "#429",
        expiresOn: "2026-08-30",
      },
    ],
  });
  assert.deepEqual(coveredByExemption.exemptedInteractions, ["plugin->sqlite"]);

  assert.throws(
    () =>
      validate({
        interactions,
        exemptions: [
          ...PRODUCT_CONTRACT_EXEMPTIONS,
          {
            targetType: "interaction",
            targetId: "plugin->sqlite",
            reason: "Expired migration.",
            trackingIssue: "#429",
            expiresOn: "2026-07-29",
          },
        ],
      }),
    /expired exemption.*plugin->sqlite/i,
  );
});

test("each newly classified lifecycle or MCP domain selects its declared journey", () => {
  const cases = [
    [
      "src/features/project/ProjectMenu.tsx",
      ["chat-stream-project-switch", "editor-pending-project-switch"],
    ],
    [
      "src/features/workspace/WorkspaceMenu.tsx",
      [
        "workspace-switch-authority",
        "chat-stream-workspace-switch",
        "codex-entity-relation-review-apply-reopen",
      ],
    ],
    [
      "src-tauri/crates/grimodex-mcp/src/server.rs",
      ["mcp-external-write-conflict"],
    ],
  ];

  for (const [changedPath, journeyIds] of cases) {
    const selection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
    });
    assert.deepEqual(
      selection.journeyIds,
      journeyIds,
      `unexpected selection for ${changedPath}`,
    );
  }
});

test("only exact Rust sinks select native-command roundtrip journeys", () => {
  const cases = [
    [
      "src-tauri/crates/grimodex-db/src/chronicle_bulk.rs",
      "chronicle-native-roundtrip",
    ],
    ["src-tauri/crates/grimodex-db/src/lint_terms.rs", "lint-native-roundtrip"],
    ["src-tauri/crates/grimodex-db/src/map_writes.rs", "map-native-roundtrip"],
    [
      "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
      "snapshot-native-roundtrip",
    ],
  ];

  for (const [changedPath, journeyId] of cases) {
    const selection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
    });
    assert.deepEqual(selection.journeyIds, [journeyId]);
    assert.equal(selection.fallback, false);
  }
});

test("native command feature adapters select only their matching native-command roundtrip", () => {
  const cases = [
    [
      "src/features/agent-writes/chronicleBulk.ts",
      "chronicle-native-roundtrip",
    ],
    ["src/features/lint/termDictionaryRepository.ts", "lint-native-roundtrip"],
    ["src/features/map/mapApi.ts", "map-native-roundtrip"],
    ["src/features/map/causalityBoard.ts", "map-native-roundtrip"],
    ["src/features/map/correlationBoard.ts", "map-native-roundtrip"],
    [
      "src/features/revision/projectSnapshotNative.ts",
      "snapshot-native-roundtrip",
    ],
  ];

  for (const [changedPath, journeyId] of cases) {
    const selection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
    });
    assert.deepEqual(selection.journeyIds, [journeyId]);
    assert.equal(selection.fallback, false);
    assert.equal(selection.allSelected, false);
  }
});

test("feature UI paths stay in the planned UI backlog and do not select native journeys", () => {
  const cases = [
    ["src/features/chronicle/ChroniclePanel.tsx", "chronicle-ui"],
    ["src/features/lint/LintDisablesView.tsx", "lint-ui"],
    ["src/features/map/MapPanel.tsx", "map-ui"],
    ["src/features/revision/ProjectSnapshotModal.tsx", "snapshot-ui"],
  ];

  for (const [changedPath, domain] of cases) {
    const selection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
    });
    assert.deepEqual(selection.affectedDomains, [domain]);
    assert.deepEqual(selection.journeyIds, []);
    assert.equal(selection.fallback, false);
    assert.equal(selection.allSelected, false);
  }
});

test("coverage errors have a stable human-readable formatter", () => {
  assert.equal(
    formatCoverageError({
      kind: "contract",
      id: "native-command-roundtrip:map-write-bundle",
      domains: ["map-write-bundle", "sqlite"],
    }),
    [
      "Uncovered product contract:",
      "  native-command-roundtrip:map-write-bundle",
      "",
      "Affected domains:",
      "  map-write-bundle, sqlite",
      "",
      "Required action:",
      "  - map an existing journey to this contract",
      "  - add a new journey",
      "  - add an explicit reviewed exemption with reason, tracking issue, and expiry",
    ].join("\n"),
  );
});

test("one changed domain selects every declared journey that can be affected", () => {
  const selection = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: ["src/features/codex/codexStore.ts"],
  });

  assert.deepEqual(selection.affectedDomains, ["codex"]);
  assert.deepEqual(selection.journeyIds, [
    "cross-feature-authoring",
    "codex-entity-relation-review-apply-reopen",
  ]);
  assert.equal(selection.fallback, false);
  assert.equal(selection.allSelected, false);
});

test("the shared scope picker selects the project chat transition contract", () => {
  const selection = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: ["src/features/tree/ScopeTreePicker.tsx"],
  });

  assert.ok(selection.journeyIds.includes("chat-stream-project-switch"));
  assert.ok(
    selection.affectedContracts.includes(
      "scope-transition:chat-stream:project",
    ),
  );
  assert.equal(selection.fallback, false);
});

test("an interaction endpoint change selects the journey even when its domain list omits that endpoint", () => {
  const selection = selectProductJourneys({
    catalog: [
      {
        id: "chat-editor",
        domains: ["chat"],
        interactions: ["chat->editor"],
        contracts: ["interaction:chat-editor"],
        capabilities: ["electron"],
      },
    ],
    domainRules: [
      {
        id: "editor",
        domains: ["editor"],
        paths: ["src/features/editor/**"],
      },
    ],
    changedPaths: ["src/features/editor/EditorPane.tsx"],
  });

  assert.deepEqual(selection.journeyIds, ["chat-editor"]);
});

test("declared map and lint changes do not invent a cross-product journey", () => {
  const selection = selectProductJourneys({
    catalog: [
      {
        id: "map-native-roundtrip",
        domains: ["map-write-bundle"],
        interactions: ["map-write-bundle->sqlite"],
        contracts: ["native-command-roundtrip:map-write-bundle"],
        capabilities: ["electron", "napi"],
      },
      {
        id: "lint-native-roundtrip",
        domains: ["lint-term-dictionary"],
        interactions: ["lint-term-dictionary->sqlite"],
        contracts: ["native-command-roundtrip:lint-term-dictionary"],
        capabilities: ["electron", "napi"],
      },
    ],
    domainRules: [
      {
        id: "map",
        domains: ["map-write-bundle"],
        paths: ["src/native/map_writes.rs"],
      },
      {
        id: "lint",
        domains: ["lint-term-dictionary"],
        paths: ["src/native/lint_terms.rs"],
      },
    ],
    changedPaths: ["src/native/map_writes.rs", "src/native/lint_terms.rs"],
  });

  assert.deepEqual(selection.journeyIds, [
    "map-native-roundtrip",
    "lint-native-roundtrip",
  ]);
});

test("contract boundary rules select journeys by contract", () => {
  const selection = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: [
      {
        id: "editor-contract",
        domains: [],
        contracts: ["roundtrip:editor"],
        paths: ["electron/main/editorPersistence.ts"],
      },
    ],
    changedPaths: ["electron/main/editorPersistence.ts"],
  });

  assert.deepEqual(selection.affectedContracts, ["roundtrip:editor"]);
  assert.deepEqual(selection.journeyIds, [
    "editor-persistence",
    "cross-feature-authoring",
  ]);
});

test("neutral paths can skip product execution while unmatched paths fail safe to all", () => {
  const neutral = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: ["docs/product-journeys.md"],
  });
  assert.deepEqual(neutral.journeyIds, []);
  assert.equal(neutral.fallback, false);
  assert.equal(neutral.allSelected, false);

  const unmatched = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: ["unknown/new-boundary.ts"],
  });
  assert.deepEqual(
    unmatched.journeyIds,
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  assert.equal(unmatched.fallback, true);
  assert.deepEqual(unmatched.unmatchedPaths, ["unknown/new-boundary.ts"]);
});

test("empty, incomplete, and selector-infrastructure diffs select all", () => {
  const empty = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: [],
  });
  assert.equal(empty.fallback, true);
  assert.equal(empty.allSelected, true);

  const incomplete = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: ["docs/product-journeys.md"],
    forceAllReason: "Git diff incomplete.",
  });
  assert.equal(incomplete.fallback, true);
  assert.equal(incomplete.allSelected, true);

  const infrastructure = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: ["electron/scripts/product-journey-catalog.mjs"],
  });
  assert.equal(infrastructure.fallback, false);
  assert.equal(infrastructure.allSelected, true);
  assert.match(infrastructure.reason, /critical/i);
});

test("the real preload boundary is classified and forces the safe full catalog", () => {
  const preload = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: ["electron/preload/index.ts"],
  });

  assert.deepEqual(preload.unmatchedPaths, []);
  assert.ok(preload.matchedRuleIds.includes("shared-native-boundary"));
  assert.equal(preload.fallback, false);
  assert.equal(preload.allSelected, true);
  assert.deepEqual(
    preload.journeyIds,
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
});

test("capability order follows the stable registry order", () => {
  const selection = selectProductJourneys({
    catalog: [
      {
        id: "mcp",
        domains: ["mcp"],
        interactions: [],
        contracts: [],
        capabilities: ["mcp", "electron", "napi"],
      },
    ],
    domainRules: [
      {
        id: "mcp",
        domains: ["mcp"],
        paths: ["src-tauri/crates/grimodex-mcp/**"],
      },
    ],
    changedPaths: ["src-tauri/crates/grimodex-mcp/src/main.rs"],
  });

  assert.deepEqual(selection.capabilities, ["electron", "napi", "mcp"]);
});

test("shadow mode records affected recommendations but executes the full catalog", () => {
  const selection = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: ["src/features/codex/codexStore.ts"],
  });
  const execution = resolveProductJourneyExecution({
    mode: "shadow",
    catalog: PRODUCT_JOURNEY_CATALOG,
    selection,
  });

  assert.deepEqual(execution.selectedJourneyIds, [
    "cross-feature-authoring",
    "codex-entity-relation-review-apply-reopen",
  ]);
  assert.deepEqual(
    execution.executionJourneyIds,
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  assert.deepEqual(execution.executionCapabilities, [
    "electron",
    "napi",
    "mcp",
  ]);
  assert.equal(execution.catalogDigest, PRODUCT_JOURNEY_CATALOG_DIGEST);
  assert.equal(execution.shouldRun, true);
  assert.equal(execution.shadow, true);
});

test("affected mode may skip execution and all mode is always explicit full coverage", () => {
  const selection = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: ["docs/product-journeys.md"],
  });
  const affected = resolveProductJourneyExecution({
    mode: "affected",
    catalog: PRODUCT_JOURNEY_CATALOG,
    selection,
  });
  assert.deepEqual(affected.executionJourneyIds, []);
  assert.equal(affected.shouldRun, false);

  const all = resolveProductJourneyExecution({
    mode: "all",
    catalog: PRODUCT_JOURNEY_CATALOG,
    selection,
  });
  assert.deepEqual(
    all.executionJourneyIds,
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  assert.equal(all.shadow, false);
});

test("the dependency-free CLI refuses affected mode while coverage is locked", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, "electron/scripts/product-journey-impact.mjs"),
        "--mode",
        "affected",
        "--changed-file",
        "docs/product-journeys.md",
      ],
      { cwd: repoRoot },
    ),
    (error) => {
      assert.equal(error.code, 1);
      return true;
    },
  );
});

test("impact Markdown distinguishes recommendation from execution", () => {
  const selection = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: ["src/features/codex/codexStore.ts"],
  });
  const execution = resolveProductJourneyExecution({
    mode: "shadow",
    catalog: PRODUCT_JOURNEY_CATALOG,
    selection,
  });
  const coverage = validate();
  const summary = formatProductJourneyImpactSummary(
    selection,
    execution,
    coverage,
  );

  assert.match(summary, /Changed files/);
  assert.match(summary, /Affected domains/);
  assert.match(summary, /Recommended journeys/);
  assert.match(summary, /Execution journeys/);
  assert.match(summary, /Shadow: yes/);
  assert.match(summary, /cross-feature-authoring/);
  assert.match(summary, /chronicle-ui-roundtrip/);
  assert.match(summary, /scope-transition:chat-stream:folder/);
  assert.match(summary, /affected execution remains locked/i);
});

test("dependency-free CLI writes JSON report and GitHub outputs", async (t) => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-impact-"),
  );
  t.after(() => rm(temp, { recursive: true, force: true }));
  const reportPath = path.join(temp, "impact.json");
  const outputPath = path.join(temp, "github-output.txt");
  const summaryPath = path.join(temp, "summary.md");

  await execFileAsync(
    process.execPath,
    [
      path.join(repoRoot, "electron/scripts/product-journey-impact.mjs"),
      "--mode",
      "shadow",
      "--changed-file",
      "src/features/codex/codexStore.ts",
      "--report",
      reportPath,
      "--format",
      "json",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    },
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.version, 1);
  assert.equal(report.catalogDigest, PRODUCT_JOURNEY_CATALOG_DIGEST);
  assert.equal(report.execution.catalogDigest, PRODUCT_JOURNEY_CATALOG_DIGEST);
  assert.deepEqual(report.execution.selectedJourneyIds, [
    "cross-feature-authoring",
    "codex-entity-relation-review-apply-reopen",
  ]);
  assert.deepEqual(
    report.execution.executionJourneyIds,
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  assert.equal(report.coverage.affectedReady, false);
  assert.deepEqual(report.coverage.exemptedContractIds, [
    "scope-transition:chat-stream:folder",
    "scope-transition:chat-stream:codex",
    "scope-transition:chat-stream:snippet",
  ]);
  assert.deepEqual(report.coverage.plannedJourneyIds, [
    "agent-stream-project-switch",
    "agent-stream-workspace-switch",
    "chronicle-ui-roundtrip",
    "lint-ui-roundtrip",
    "map-ui-roundtrip",
    "snapshot-ui-roundtrip",
  ]);

  const githubOutput = await readFile(outputPath, "utf8");
  assert.match(githubOutput, /should_run=true/);
  assert.match(
    githubOutput,
    new RegExp(`catalog_digest=${PRODUCT_JOURNEY_CATALOG_DIGEST}`),
  );
  assert.match(
    githubOutput,
    /selected_journey_ids=\["cross-feature-authoring","codex-entity-relation-review-apply-reopen"\]/,
  );
  assert.match(
    githubOutput,
    /execution_capabilities=\["electron","napi","mcp"\]/,
  );
  assert.match(
    await readFile(summaryPath, "utf8"),
    /Grimodex product journey impact/,
  );
});
