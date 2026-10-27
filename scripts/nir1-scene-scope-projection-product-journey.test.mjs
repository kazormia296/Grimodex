import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { CODEX_ENTITY_RELATION_REVIEW_SELECTORS } from "../electron/scripts/codex-entity-relation-product-journey.mjs";
import {
  BACKGROUND_QUIESCENCE_STABLE_MS,
  BACKGROUND_QUIESCENCE_TIMEOUT_MS,
  countRejectionTablesWhenQuiescent,
  NIR1_SCENE_SCOPE_PROJECTION_IPC_COMMANDS,
  NIR1_SCENE_SCOPE_PROJECTION_JOURNEY_ID,
  NIR1_SCENE_SCOPE_PROJECTION_REQUIRED_INTERACTIONS,
  NIR1_SCENE_SCOPE_PROJECTION_SELECTORS,
  NIR1_SCENE_SCOPE_PROJECTION_STEPS,
  TOAST_CLEAR_TIMEOUT_MS,
  createNir1SceneScopeProjectionJourney,
  waitForToastsToClear,
} from "../electron/scripts/nir1-scene-scope-projection-product-journey.mjs";
import {
  PRODUCT_CONTRACT_REQUIREMENTS,
  PRODUCT_JOURNEY_CATALOG,
} from "../electron/scripts/product-journey-catalog.mjs";
import { FIXED_PRODUCT_JOURNEY_SHARDS } from "../electron/scripts/product-journey-shards.mjs";
import { PRODUCT_JOURNEYS } from "../electron/scripts/product-journeys.mjs";

// SQL table and column names the journey spells as strings (not bridge commands).
const OBSERVED_NAMES = new Set([
  "narrative_extraction_runs",
  "narrative_proposal_sets",
  "narrative_scene_scope_bindings",
  "narrative_change_events",
  // Snapshot restore plan table names (not bridge commands).
  "tree_nodes",
  "project_calendar",
  "codex_entry_id",
]);

const repoRoot = path.resolve(import.meta.dirname, "..");
const journeySourcePath = path.join(
  repoRoot,
  "electron/scripts/nir1-scene-scope-projection-product-journey.mjs",
);

test("Scene Scope projection journey has one dependency-free contract", () => {
  assert.equal(
    NIR1_SCENE_SCOPE_PROJECTION_JOURNEY_ID,
    "nir1-scene-scope-projection-acceptance",
  );
  assert.deepEqual(
    NIR1_SCENE_SCOPE_PROJECTION_SELECTORS.slice(
      0,
      CODEX_ENTITY_RELATION_REVIEW_SELECTORS.length,
    ),
    [...CODEX_ENTITY_RELATION_REVIEW_SELECTORS],
    "the typed review click path is shared, not redefined",
  );
  assert.deepEqual(
    NIR1_SCENE_SCOPE_PROJECTION_SELECTORS.slice(
      CODEX_ENTITY_RELATION_REVIEW_SELECTORS.length,
    ),
    [
      "[data-node-row]",
      '.ProseMirror[contenteditable="true"]',
      '[data-testid="nir1-typed-unavailable-reason"]',
    ],
  );
  assert.deepEqual(NIR1_SCENE_SCOPE_PROJECTION_REQUIRED_INTERACTIONS, [
    "create-folders-and-scenes-through-scenes-panel",
    "create-codex-entries-and-typed-relations-through-codex-panel",
    "prepare-and-approve-anchor-revision-through-ui",
    "prepare-and-approve-other-revision-through-native-commands",
    "save-anchor-and-other-scene-bodies-through-editor-autosave",
    "read-current-revisions-through-native-cold-reader",
    "close-and-relaunch-electron",
    "restore-typed-run-through-ui",
    "move-anchor-through-canonical-tree-writer",
    "edit-scope-through-canonical-writers-and-observe-cold-reader",
    "delete-and-retype-codex-persons-through-canonical-writers",
    "replay-undo-journal-through-history-replay-route",
    "restore-project-snapshot-body-through-native-aggregate",
  ]);
  assert.deepEqual(NIR1_SCENE_SCOPE_PROJECTION_STEPS, [
    "e1-prepare-approve",
    "prepare-rejects-foreign-project-and-missing-anchor",
    "e1-body-saves-keep-available",
    "e1-cold-reopen-available",
    "e1-anchor-move-invalidates-anchor-only",
    "f9-body-save-keeps-revisions-available",
    "display-patches-keep-projection",
    "pov-patch-invalidates-anchor-only",
    "unversioned-patch-never-returns-body-token",
    "anchor-reorder-reparent-invalidates-anchor-only",
    "folder-roundtrip-does-not-return",
    "empty-folder-and-note-keep-everything",
    "anchor-scope-roundtrip-stays-invalid",
    "anchor-archive-roundtrip-stays-invalid",
    "story-time-order-roundtrip-stays-invalid",
    "other-scene-scope-change-keeps-anchor",
    "anchor-delete-recreate-stays-invalid",
    "trash-restore-stays-invalid",
    "body-event-does-not-make-pending",
    "scope-event-pends-anchor-only",
    "pov-only-person-delete-nulls-pov",
    "referenced-person-delete-and-type-change-rejected",
    "journal-undo-redo-guard-and-invalidate",
    "probe-def2-journal-pov-null-next-patch",
    "prepare-rejects-other-project-scene",
    "probe-def1-snapshot-restore-feed",
    "snapshot-body-restore-recreates-bindings",
    "snapshot-restore-epoch-keeps-revisions-unavailable",
    "snapshot-token-return-stays-unavailable",
  ]);
});

test("journey sends only the declared renderer-bridge commands and no Graph, Packing or AI route", async () => {
  assert.deepEqual(NIR1_SCENE_SCOPE_PROJECTION_IPC_COMMANDS, [
    "db_execute",
    "narrative_extraction_capture_workspace_binding",
    "nir1_entity_relation_revision_prepare",
    "nir1_entity_relation_revision_read_current",
    "narrative_extraction_append_human_decision",
    "tree_node_patch",
    "tree_node_create",
    "tree_node_delete",
    "save_scene_body_bundle",
    "chronicle_bulk_mutate",
    "temporal_scene_patch",
    "narrative_scene_scope_read",
    "narrative_scene_scope_update",
    "trash_bin_create",
    "trash_bin_restore",
    "codex_create",
    "codex_update",
    "codex_delete",
    "agent_apply_undo_journal",
    "project_snapshot_create",
    "project_snapshot_restore_context",
    "project_snapshot_apply_restore",
    "project_create",
  ]);
  const source = await readFile(journeySourcePath, "utf8");
  const quoted = new Set(
    [...source.matchAll(/"([a-z][a-z0-9_]*)"/gu)]
      .map(([, name]) => name)
      .filter((name) => name.includes("_")),
  );
  for (const command of NIR1_SCENE_SCOPE_PROJECTION_IPC_COMMANDS) {
    assert.ok(source.includes(`"${command}"`), `journey must send ${command}`);
  }
  const bridgeCommands = [...quoted].filter((name) =>
    /^(db|narrative|nir1|tree|save|project|codex|agent|temporal|trash)_/u.test(
      name,
    ),
  );
  assert.deepEqual(
    bridgeCommands.filter(
      (name) =>
        !NIR1_SCENE_SCOPE_PROJECTION_IPC_COMMANDS.includes(name) &&
        !OBSERVED_NAMES.has(name),
    ),
    [],
    "journey must not send an undeclared bridge command",
  );
  for (const forbidden of [
    "nir1_pack_context",
    "pack_context",
    "graph_query",
    "ai_dispatch",
    "get_run_review_bundle",
    "VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `journey must not reference ${forbidden}`,
    );
  }
  assert.ok(
    source.includes("verifyNoForbiddenDispatches") &&
      source.includes("captureJournalBoundary"),
    "journey must observe the forbidden-dispatch journal rule",
  );
});

test("journey never hands Native a token, key or incarnation", async () => {
  const source = await readFile(journeySourcePath, "utf8");
  const prepareStart = source.indexOf(
    "async function prepareAndApproveThroughNative",
  );
  assert.ok(prepareStart >= 0);
  assert.match(
    source.slice(prepareStart, prepareStart + 1600),
    /payload: \{ projectId, sceneId, entityIds, relationIds \}/u,
    "prepare payload carries identities only",
  );
  for (const forbidden of [
    "sourceToken:",
    "sceneIncarnationId:",
    "scopeGeneration:",
    "storyKey:",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `journey payloads must not carry ${forbidden}`,
    );
  }
});

/**
 * Every string literal (single, double and template) of a JavaScript source,
 * skipping comments.  A small scanner: the journey has no regular-expression
 * literal that contains a quote and no nested template literal.
 */
function stringLiterals(source) {
  const found = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < source.length && source[end] !== char) {
        end += source[end] === "\\" ? 2 : 1;
      }
      found.push(source.slice(index + 1, end));
      index = end + 1;
    } else {
      index += 1;
    }
  }
  return found;
}

/**
 * The one SQL write the journey sends: the `content_versions` row the
 * renderer's `createRevision` inserts (through Drizzle) for each body in a
 * project snapshot.  `content_versions` is outside the protected writers; the
 * statement is pinned here so no other write can ride on the exception.
 */
const SNAPSHOT_BODY_VERSION_INSERT =
  "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type, created_at) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(version_number), 0) + 1 FROM content_versions WHERE entity_type = ? AND entity_id = ?), 'manual', ?)";

function normalizeSql(text) {
  return text.replace(/\s+/gu, " ").trim();
}

test("journey changes state only through real writers, never a direct SQL write", async () => {
  const source = await readFile(journeySourcePath, "utf8");
  const literals = stringLiterals(source);
  const sqlStatements = literals.filter((text) =>
    /\b(SELECT|UPDATE|INSERT|DELETE)\b/u.test(text),
  );
  assert.ok(sqlStatements.length > 0);
  const allowedWrites = [];
  for (const statement of sqlStatements) {
    if (normalizeSql(statement) === SNAPSHOT_BODY_VERSION_INSERT) {
      allowedWrites.push(statement);
      continue;
    }
    assert.match(
      statement.trim(),
      /^SELECT\b/u,
      "every SQL the journey sends is a SELECT observation",
    );
  }
  assert.equal(
    allowedWrites.length,
    1,
    "the content_versions insert of the snapshot capture is the only SQL write",
  );
  // A statement spelled in any quote style, or split across a line, is still caught.
  for (const text of literals) {
    if (normalizeSql(text) === SNAPSHOT_BODY_VERSION_INSERT) continue;
    assert.doesNotMatch(
      text,
      /\b(UPDATE\s+\w+\s+SET|INSERT\s+(OR\s+\w+\s+)?INTO|DELETE\s+FROM|REPLACE\s+INTO|DROP\s+TABLE|ALTER\s+TABLE)\b/iu,
      "no string literal contains a SQL write",
    );
  }
  // The edit matrix uses the canonical writers the product uses.
  for (const writer of [
    "save_scene_body_bundle",
    "tree_node_patch",
    "tree_node_create",
    "tree_node_delete",
    "chronicle_bulk_mutate",
    "temporal_scene_patch",
    "narrative_scene_scope_update",
    "trash_bin_restore",
    "codex_create",
    "codex_update",
    "codex_delete",
    "agent_apply_undo_journal",
    "project_snapshot_create",
    "project_snapshot_apply_restore",
  ]) {
    assert.ok(source.includes(`"${writer}"`), `matrix uses ${writer}`);
  }
});

test("journey replays the journal and restores the snapshot without an Agent capability", async () => {
  const source = await readFile(journeySourcePath, "utf8");
  // The Interactive Agent create needs a Main-issued one-shot capability the
  // journey cannot (and must not) obtain; the renderer's Codex writer is used.
  assert.equal(source.includes("agentAuthorityCapability"), false);
  assert.equal(
    stringLiterals(source).includes("agent_codex_create"),
    false,
    "no string literal sends agent_codex_create",
  );
  // The journal replay payload is the renderer's, with Main-owned authority.
  assert.match(source, /authorityRoute: "history-replay"/u);
  assert.match(source, /caller: "undo-redo-command"/u);
  // The diagnostic probes accept both outcomes and pin the Change Feed code.
  for (const probe of [
    "probe-def1-snapshot-restore-feed",
    "probe-def2-journal-pov-null-next-patch",
  ]) {
    assert.ok(NIR1_SCENE_SCOPE_PROJECTION_STEPS.includes(probe));
  }
  assert.match(source, /NARRATIVE_CHANGE_FEED_DISCONTINUITY/u);
  // Fail-closed: the basic project's restore must succeed, no "unmet" pass.
  assert.equal(source.includes("unmet-by-DEF-1"), false);
  assert.match(source, /basic\.attempt\.restored,\s*true/u);
  assert.match(source, /unavailable:revision-restore-invalidated/u);
  // The snapshot restore is body-scope only (codex rows stay out of the plan).
  assert.match(source, /scopes: \["body"\]/u);
});

test("journey is registered once in the catalog, runner and fixed shard 6", () => {
  const journey = createNir1SceneScopeProjectionJourney({
    configureWorkspace() {},
  });
  assert.equal(journey.id, NIR1_SCENE_SCOPE_PROJECTION_JOURNEY_ID);
  assert.equal(typeof journey.run, "function");
  const entries = PRODUCT_JOURNEY_CATALOG.filter(
    ({ id }) => id === NIR1_SCENE_SCOPE_PROJECTION_JOURNEY_ID,
  );
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.deepEqual(entry.capabilities, ["electron", "napi"]);
  assert.deepEqual(entry.domains, [
    "codex",
    "scene-persistence",
    "workspace-lifecycle",
  ]);
  assert.deepEqual(entry.interactions, ["codex->sqlite", "sqlite->codex"]);
  assert.deepEqual(entry.contracts, ["scene-scope-projection:acceptance"]);
  assert.ok(
    PRODUCT_CONTRACT_REQUIREMENTS.some(
      ({ id }) => id === "scene-scope-projection:acceptance",
    ),
  );
  assert.equal(
    PRODUCT_JOURNEYS.filter(
      ({ id }) => id === NIR1_SCENE_SCOPE_PROJECTION_JOURNEY_ID,
    ).length,
    1,
  );
  assert.deepEqual(
    FIXED_PRODUCT_JOURNEY_SHARDS.findIndex((ids) =>
      ids.includes(NIR1_SCENE_SCOPE_PROJECTION_JOURNEY_ID),
    ),
    5,
    "the journey runs first in fixed shard 6 (lightest canonical shard)",
  );
});

/**
 * A fake harness whose `waitUntil` polls the predicate on a fake clock that
 * advances `stepMs` per poll, up to `timeoutMs`.
 */
function fakeQuiescenceHarness(stepMs = 500) {
  const clock = { at: 0 };
  return {
    clock,
    labels: [],
    async waitUntil(predicate, label, timeoutMs) {
      this.labels.push([label, timeoutMs]);
      for (; clock.at <= timeoutMs; clock.at += stepMs) {
        const value = await predicate();
        if (value) return value;
      }
      throw new Error(`timed out: ${label}`);
    },
  };
}

test("rejection counts start only after a stable, settled background", async () => {
  const harness = fakeQuiescenceHarness();
  // A background Run lands at t = 1000 ms (the #748 shape: runsAll + 1).
  const count = async () => ({
    runs: 90,
    runsAll: harness.clock.at < 1_000 ? 90 : 91,
  });
  const settledQueries = [];
  const counts = await countRejectionTablesWhenQuiescent(
    harness,
    null,
    "project-a",
    ["project-a", "project-b"],
    "test",
    {
      count,
      feedSettled: async (_harness, _page, id) => {
        settledQueries.push(id);
        // project-b's Feed is still pending until t = 500 ms.
        return id !== "project-b" || harness.clock.at >= 500;
      },
      now: () => harness.clock.at,
    },
  );
  assert.deepEqual(counts, { runs: 90, runsAll: 91 });
  assert.ok(
    harness.clock.at >= 1_000 + BACKGROUND_QUIESCENCE_STABLE_MS,
    `counted only after ${BACKGROUND_QUIESCENCE_STABLE_MS} ms of stability`,
  );
  assert.ok(settledQueries.includes("project-b"), "every project is settled");
  assert.deepEqual(harness.labels, [
    [
      "background owners are quiescent (test)",
      BACKGROUND_QUIESCENCE_TIMEOUT_MS,
    ],
  ]);
});

test("an unsettled Feed restarts the stability window", async () => {
  const harness = fakeQuiescenceHarness();
  let polls = 0;
  const counts = await countRejectionTablesWhenQuiescent(
    harness,
    null,
    "project-a",
    ["project-a"],
    "test",
    {
      count: async () => ({ runs: 1 }),
      // Settled, then a reservation appears once at t = 1500 ms.
      feedSettled: async () => {
        polls += 1;
        return harness.clock.at !== 1_500;
      },
      now: () => harness.clock.at,
    },
  );
  assert.deepEqual(counts, { runs: 1 });
  assert.ok(
    harness.clock.at >= 1_500 + 500 + BACKGROUND_QUIESCENCE_STABLE_MS,
    "the window restarts after the unsettled poll",
  );
  assert.ok(polls > 0);
});

test("a background that never quiesces fails instead of counting", async () => {
  const harness = fakeQuiescenceHarness();
  await assert.rejects(
    countRejectionTablesWhenQuiescent(
      harness,
      null,
      "project-a",
      ["project-a"],
      "test",
      {
        count: async () => ({ runsAll: harness.clock.at }),
        feedSettled: async () => true,
        now: () => harness.clock.at,
      },
    ),
    /timed out: background owners are quiescent \(test\)/u,
  );
});

test("both rejection comparisons start from the quiescent counts", async () => {
  const source = await readFile(journeySourcePath, "utf8");
  assert.equal(
    (
      source.match(
        /const countsBefore = await countRejectionTablesWhenQuiescent\(/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.doesNotMatch(
    source,
    /const countsBefore = await countRejectionTables\(/u,
  );
  assert.match(
    source,
    /\[rootCtx\.projectId, second\.projectId\],\s*"before the other project's Scene prepare"/u,
  );
});

test("the Details tab is clicked only after the pointer leaves and Toasts clear", async () => {
  const calls = [];
  const page = {
    mouse: {
      async move(x, y) {
        calls.push(["move", x, y]);
      },
    },
    locator(selector) {
      calls.push(["locator", selector]);
      return {
        first() {
          return {
            async waitFor(options) {
              calls.push(["waitFor", options]);
            },
          };
        },
      };
    },
  };
  await waitForToastsToClear(page);
  assert.deepEqual(calls, [
    ["move", 0, 0],
    ["locator", "[data-sonner-toast]"],
    ["waitFor", { state: "detached", timeout: TOAST_CLEAR_TIMEOUT_MS }],
  ]);
  const source = await readFile(journeySourcePath, "utf8");
  assert.match(
    source,
    /await waitForToastsToClear\(page\);\s*await page\.getByTestId\("detail-tab-details"\)\.click\(\);/u,
  );
});
