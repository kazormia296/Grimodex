import { randomUUID } from "node:crypto";

const CHRONICLE_START_TIME = 2_000_001;
const LINT_PREFERRED = "子ども";
const LINT_VARIANT = "子供";
const MAP_STICKY_TEXT = "NATIVE-MAP-ROUNDTRIP";
const SNAPSHOT_CONTENT = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "NATIVE-SNAPSHOT-ROUNDTRIP" }],
    },
  ],
});

function rowsOf(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

async function queryRows(harness, page, sql, params = []) {
  return rowsOf(
    await harness.invokeOk(page, "db_execute", {
      sql,
      params,
      method: "all",
    }),
  );
}

async function projectIdFor(harness, page) {
  return harness.waitUntil(async () => {
    const rows = await queryRows(
      harness,
      page,
      "SELECT id FROM projects ORDER BY created_at, id LIMIT 1",
    );
    const projectId = String(rows[0]?.id ?? "");
    return projectId || null;
  }, "native round-trip project authority");
}

function requireRow(rows, label) {
  if (rows.length !== 1) {
    throw new Error(`${label}: expected exactly one row, got ${rows.length}`);
  }
  return rows[0];
}

async function assertNoIntegrityOrphans(harness, page, projectId, label) {
  const report = await harness.invokeOk(page, "integrity_check", {
    projectId,
  });
  const orphanCounts = Object.entries(report ?? {}).filter(
    ([, count]) => typeof count !== "number" || count !== 0,
  );
  if (orphanCounts.length > 0) {
    throw new Error(
      `${label}: integrity_check reported orphaned records (${JSON.stringify(
        Object.fromEntries(orphanCounts),
      )})`,
    );
  }
}

async function runNativeRoundTrip(
  harness,
  { id, restoredMarker, configureWorkspace, log, write, verify },
) {
  if (restoredMarker !== `${id}-restored`) {
    throw new Error(`${id}: invalid native round-trip restored marker`);
  }
  const workspace = harness.workspacePath(id);
  await configureWorkspace(harness, workspace);

  const writing = await harness.launch(`${id}/write`);
  let state;
  try {
    const projectId = await projectIdFor(harness, writing.page);
    state = {
      projectId,
      ...(await write({
        harness,
        page: writing.page,
        projectId,
        workspace,
      })),
    };
    await verify({
      harness,
      page: writing.page,
      state,
      phase: "write",
    });
  } finally {
    await harness.close(writing.app, writing.page, `${id}/write`);
  }

  const restart = await harness.launch(`${id}/restart`);
  try {
    const restartedProjectId = await projectIdFor(harness, restart.page);
    if (restartedProjectId !== state.projectId) {
      throw new Error(
        `${id}: project authority changed across restart (${state.projectId} -> ${restartedProjectId})`,
      );
    }
    await verify({
      harness,
      page: restart.page,
      state,
      phase: "restart",
    });
    harness.recordTimeline(restoredMarker, {
      workspace,
      projectId: state.projectId,
    });
    log(`${id}: typed native write survived Electron restart`);
  } finally {
    await harness.close(restart.app, restart.page, `${id}/restart`);
  }
}

function chronicleJourney(configureWorkspace, log) {
  const id = "chronicle-native-roundtrip";
  return {
    id,
    run: (harness) =>
      runNativeRoundTrip(harness, {
        id,
        restoredMarker: "chronicle-native-roundtrip-restored",
        configureWorkspace,
        log,
        write: async ({ harness: current, page, projectId }) => {
          const eventId = `native-event-${randomUUID()}`;
          const requestId = `native-chronicle-${randomUUID()}`;
          const created = await current.invokeOk(page, "agent_event_create", {
            payload: {
              requestId: `native-create-request-${randomUUID()}`,
              eventId,
              projectId,
              sessionId: `native-create-session-${randomUUID()}`,
              surface: "manual",
              title: "Native Chronicle round-trip",
              ordinal: "native-roundtrip",
              startGranularity: "none",
              endGranularity: "none",
              precision: "exact",
              kind: "generic",
              participantCodexIds: [],
              sceneIds: [],
            },
          });
          if (created?.entityId !== eventId || created?.version !== 1) {
            throw new Error(
              `${id}: Chronicle create did not acknowledge version 1`,
            );
          }
          const result = await current.invokeOk(
            page,
            "agent_chronicle_bulk_mutate",
            {
              payload: {
                requestId,
                projectId,
                sessionId: `native-session-${randomUUID()}`,
                surface: "manual",
                operations: [
                  {
                    kind: "eventSetDate",
                    eventId,
                    baseVersion: created.version,
                    startTime: CHRONICLE_START_TIME,
                    startMinute: null,
                    startGranularity: "day",
                    endTime: null,
                    endMinute: null,
                    endGranularity: "none",
                  },
                ],
              },
            },
          );
          const eventResult = result?.eventResults?.find(
            (entry) => entry?.eventId === eventId,
          );
          if (
            eventResult?.kind !== "eventSetDate" ||
            eventResult?.version !== created.version + 1
          ) {
            throw new Error(
              `${id}: Chronicle bulk result did not advance the event version`,
            );
          }
          return { eventId, requestId, version: eventResult.version };
        },
        verify: async ({ harness: current, page, state, phase }) => {
          const row = requireRow(
            await queryRows(
              current,
              page,
              `SELECT project_id AS projectId, start_time AS startTime,
                      start_minute AS startMinute,
                      start_granularity AS startGranularity,
                      end_time AS endTime,
                      end_minute AS endMinute,
                      end_granularity AS endGranularity,
                      version
                 FROM events
                WHERE id = ?`,
              [state.eventId],
            ),
            `${id}/${phase}`,
          );
          if (
            row.projectId !== state.projectId ||
            row.startTime !== CHRONICLE_START_TIME ||
            row.startMinute !== null ||
            row.startGranularity !== "day" ||
            row.endTime !== null ||
            row.endMinute !== null ||
            row.endGranularity !== "none" ||
            row.version !== state.version
          ) {
            throw new Error(
              `${id}/${phase}: persisted Chronicle aggregate did not match the typed mutation`,
            );
          }
          await assertNoIntegrityOrphans(
            current,
            page,
            state.projectId,
            `${id}/${phase}`,
          );
        },
      }),
  };
}

function lintJourney(configureWorkspace, log) {
  const id = "lint-native-roundtrip";
  return {
    id,
    run: (harness) =>
      runNativeRoundTrip(harness, {
        id,
        restoredMarker: "lint-native-roundtrip-restored",
        configureWorkspace,
        log,
        write: async ({ harness: current, page, projectId }) => {
          const entryId = `native-lint-${randomUUID()}`;
          const timestamp = Date.now();
          const inserted = await current.invokeOk(
            page,
            "lint_term_dictionary_insert",
            {
              payload: {
                id: entryId,
                projectId,
                preferred: LINT_PREFERRED,
                variants: [LINT_VARIANT],
                severity: "warning",
                note: "Product journey native round-trip",
                enabled: true,
                sortOrder: 73,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            },
          );
          if (
            inserted?.id !== entryId ||
            inserted?.preferred !== LINT_PREFERRED
          ) {
            throw new Error(
              `${id}: typed insert did not return the inserted entry`,
            );
          }
          return { entryId, timestamp };
        },
        verify: async ({ harness: current, page, state, phase }) => {
          const entries = await current.invokeOk(
            page,
            "lint_term_dictionary_list",
            {
              projectId: state.projectId,
            },
          );
          const typed = entries?.find((entry) => entry?.id === state.entryId);
          if (
            typed?.preferred !== LINT_PREFERRED ||
            typed?.variants?.length !== 1 ||
            typed.variants[0] !== LINT_VARIANT ||
            typed?.severity !== "warning" ||
            typed?.enabled !== true ||
            typed?.sortOrder !== 73 ||
            typed?.createdAt !== state.timestamp ||
            typed?.updatedAt !== state.timestamp
          ) {
            throw new Error(
              `${id}/${phase}: typed list did not restore the inserted entry`,
            );
          }
          const row = requireRow(
            await queryRows(
              current,
              page,
              `SELECT project_id AS projectId, preferred, variants, severity,
                      enabled, sort_order AS sortOrder,
                      created_at AS createdAt, updated_at AS updatedAt
                 FROM lint_term_dictionary
                WHERE id = ?`,
              [state.entryId],
            ),
            `${id}/${phase}`,
          );
          if (
            row.projectId !== state.projectId ||
            row.preferred !== LINT_PREFERRED ||
            row.variants !== JSON.stringify([LINT_VARIANT]) ||
            row.severity !== "warning" ||
            row.enabled !== 1 ||
            row.sortOrder !== 73 ||
            row.createdAt !== state.timestamp ||
            row.updatedAt !== state.timestamp
          ) {
            throw new Error(
              `${id}/${phase}: SQLite row did not match the typed lint write`,
            );
          }
          await assertNoIntegrityOrphans(
            current,
            page,
            state.projectId,
            `${id}/${phase}`,
          );
        },
      }),
  };
}

function mapJourney(configureWorkspace, log) {
  const id = "map-native-roundtrip";
  return {
    id,
    run: (harness) =>
      runNativeRoundTrip(harness, {
        id,
        restoredMarker: "map-native-roundtrip-restored",
        configureWorkspace,
        log,
        write: async ({ harness: current, page, projectId }) => {
          const boardId = `native-board-${randomUUID()}`;
          const stickyId = `native-sticky-${randomUUID()}`;
          const positionId = `native-position-${randomUUID()}`;
          const now = new Date().toISOString();
          await current.invokeOk(page, "map_write_bundle", {
            payload: {
              requestId: `native-map-request-${randomUUID()}`,
              sessionId: `native-map-session-${randomUUID()}`,
              eventUid: `native-map-event-${randomUUID()}`,
              kind: "create-board",
              projectId,
              board: {
                id: boardId,
                projectId,
                title: "Native Map round-trip",
                sortOrder: 73,
                mode: "free",
                viewportX: 12,
                viewportY: 34,
                viewportZoom: 1.25,
                showConfig: "{}",
                colorBy: "none",
                createdAt: now,
                updatedAt: now,
              },
              stickies: [
                {
                  id: stickyId,
                  boardId,
                  title: "Native sticky",
                  body: JSON.stringify({
                    type: "doc",
                    content: [
                      {
                        type: "paragraph",
                        content: [
                          {
                            type: "text",
                            text: MAP_STICKY_TEXT,
                          },
                        ],
                      },
                    ],
                  }),
                  previewText: MAP_STICKY_TEXT,
                  paletteId: "post-it-playful",
                  colorSlot: 0,
                  aiBranchId: null,
                  aiDerived: 0,
                  sourceChatMessageId: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
              positions: [
                {
                  id: positionId,
                  boardId,
                  nodeRefType: "sticky",
                  treeNodeId: null,
                  codexEntryId: null,
                  snippetId: null,
                  stickyId,
                  aiBranchId: null,
                  x: 120,
                  y: 240,
                  pinned: 1,
                  zIndex: 7,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
              edges: [],
              frames: [],
            },
          });
          return { boardId, stickyId, positionId };
        },
        verify: async ({ harness: current, page, state, phase }) => {
          const row = requireRow(
            await queryRows(
              current,
              page,
              `SELECT b.project_id AS projectId, b.title AS boardTitle,
                      s.body AS stickyBody, s.preview_text AS previewText,
                      p.node_ref_type AS nodeRefType,
                      p.sticky_id AS stickyId, p.x, p.y, p.pinned, p.z_index AS zIndex
                 FROM map_boards b
                 JOIN map_stickies s ON s.board_id = b.id
                 JOIN map_node_positions p
                   ON p.board_id = b.id AND p.sticky_id = s.id
                WHERE b.id = ? AND s.id = ? AND p.id = ?`,
              [state.boardId, state.stickyId, state.positionId],
            ),
            `${id}/${phase}`,
          );
          if (
            row.projectId !== state.projectId ||
            row.boardTitle !== "Native Map round-trip" ||
            !String(row.stickyBody).includes(MAP_STICKY_TEXT) ||
            row.previewText !== MAP_STICKY_TEXT ||
            row.nodeRefType !== "sticky" ||
            row.stickyId !== state.stickyId ||
            row.x !== 120 ||
            row.y !== 240 ||
            row.pinned !== 1 ||
            row.zIndex !== 7
          ) {
            throw new Error(
              `${id}/${phase}: Map aggregate did not survive as one FK-linked graph`,
            );
          }
          await assertNoIntegrityOrphans(
            current,
            page,
            state.projectId,
            `${id}/${phase}`,
          );
        },
      }),
  };
}

function snapshotJourney(configureWorkspace, log) {
  const id = "snapshot-native-roundtrip";
  return {
    id,
    run: (harness) =>
      runNativeRoundTrip(harness, {
        id,
        restoredMarker: "snapshot-native-roundtrip-restored",
        configureWorkspace,
        log,
        write: async ({ harness: current, page, projectId }) => {
          const sceneId = `native-snapshot-scene-${randomUUID()}`;
          const versionId = `native-snapshot-version-${randomUUID()}`;
          const snapshotId = `native-snapshot-${randomUUID()}`;
          const snapshotName = `Native snapshot ${randomUUID()}`;
          const now = new Date().toISOString();
          const scene = await current.invokeOk(page, "tree_node_create", {
            payload: {
              projectId,
              requestId: `native-snapshot-scene-request-${randomUUID()}`,
              sessionId: `native-snapshot-scene-session-${randomUUID()}`,
              eventUid: `native-snapshot-scene-event-${randomUUID()}`,
              origin: "human",
              originalTransactionId: null,
              undoJournalId: null,
              id: sceneId,
              parentId: null,
              nodeType: "scene",
              title: "Native snapshot scene",
              sortOrder: "native-roundtrip",
              status: "draft",
              content: SNAPSHOT_CONTENT,
            },
          });
          if (
            scene?.id !== sceneId ||
            scene?.projectId !== projectId ||
            scene?.content !== SNAPSHOT_CONTENT
          ) {
            throw new Error(`${id}: typed scene seed was not persisted`);
          }
          await current.invokeOk(page, "db_execute", {
            sql: `INSERT INTO content_versions
              (id, entity_type, entity_id, content, version_number,
               snapshot_type, created_at)
              VALUES (?, 'scene', ?, ?, 1, 'manual', ?)`,
            params: [versionId, sceneId, SNAPSHOT_CONTENT, now],
            method: "run",
          });
          await current.invokeOk(page, "project_snapshot_create", {
            payload: {
              projectId,
              snapshotId,
              name: snapshotName,
              description: "Product journey native round-trip",
              createdAt: now,
              treeRows: [
                {
                  snapshot_id: snapshotId,
                  node_id: sceneId,
                  parent_id: null,
                  node_type: "scene",
                  title: "Native snapshot scene",
                  synopsis: null,
                  intent: null,
                  sort_order: "native-roundtrip",
                  story_time_order: null,
                  story_time_label: null,
                  pov_character_id: null,
                  location_id: null,
                  chronicle_start_time: null,
                  chronicle_start_minute: null,
                  chronicle_start_granularity: "none",
                  chronicle_end_time: null,
                  chronicle_end_minute: null,
                  chronicle_end_granularity: "none",
                  chronicle_precision: "exact",
                  status: "draft",
                  body_version_id: versionId,
                  unplaced_beats_doc: "[]",
                  char_count: "NATIVE-SNAPSHOT-ROUNDTRIP".length,
                  created_at: now,
                  updated_at: now,
                },
              ],
              codexRows: [],
              snippetRows: [],
              versionIds: [versionId],
            },
          });
          return {
            sceneId,
            versionId,
            snapshotId,
            snapshotName,
          };
        },
        verify: async ({ harness: current, page, state, phase }) => {
          const context = await current.invokeOk(
            page,
            "project_snapshot_restore_context",
            {
              projectId: state.projectId,
              snapshotId: state.snapshotId,
              scopes: ["body"],
            },
          );
          const treeRow = context?.treeRows?.find(
            (row) => row?.node_id === state.sceneId,
          );
          const contentRow = context?.contentRows?.find(
            (row) => row?.id === state.versionId,
          );
          if (
            context?.structural !== true ||
            treeRow?.snapshot_id !== state.snapshotId ||
            treeRow?.body_version_id !== state.versionId ||
            contentRow?.content !== SNAPSHOT_CONTENT
          ) {
            throw new Error(
              `${id}/${phase}: typed restore context did not return the structural snapshot`,
            );
          }
          const row = requireRow(
            await queryRows(
              current,
              page,
              `SELECT s.project_id AS projectId, s.name,
                      t.node_id AS nodeId, t.body_version_id AS bodyVersionId,
                      e.version_id AS versionId
                 FROM project_snapshots s
                 JOIN project_snapshot_tree_nodes t ON t.snapshot_id = s.id
                 JOIN project_snapshot_entries e ON e.snapshot_id = s.id
                WHERE s.id = ?`,
              [state.snapshotId],
            ),
            `${id}/${phase}`,
          );
          if (
            row.projectId !== state.projectId ||
            row.name !== state.snapshotName ||
            row.nodeId !== state.sceneId ||
            row.bodyVersionId !== state.versionId ||
            row.versionId !== state.versionId
          ) {
            throw new Error(
              `${id}/${phase}: SQLite snapshot rows did not match the typed aggregate`,
            );
          }
          await assertNoIntegrityOrphans(
            current,
            page,
            state.projectId,
            `${id}/${phase}`,
          );
        },
      }),
  };
}

export function createNativeRoundTripJourneys({ configureWorkspace, log }) {
  if (typeof configureWorkspace !== "function") {
    throw new Error(
      "createNativeRoundTripJourneys requires configureWorkspace",
    );
  }
  if (typeof log !== "function") {
    throw new Error("createNativeRoundTripJourneys requires log");
  }
  return [
    chronicleJourney(configureWorkspace, log),
    lintJourney(configureWorkspace, log),
    mapJourney(configureWorkspace, log),
    snapshotJourney(configureWorkspace, log),
  ];
}
