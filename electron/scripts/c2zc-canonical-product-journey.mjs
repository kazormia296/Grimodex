import { randomUUID } from "node:crypto";

const C2ZC_CUTOVER_MIGRATION_ID = "narrative-c2-canonical-freshness-v1";
const C2ZC_CUTOVER_CONTRACT_VERSION = 1;
const C2ZC_FRESHNESS_CONSUMER_KIND = "application";
const C2ZC_WAIT_MS = 60_000;

export const C2ZC_PRODUCT_JOURNEY_ID = "c2-zc-canonical-authority-cutover";
export const C2ZC_PRODUCT_JOURNEY_PHASES = Object.freeze([
  `${C2ZC_PRODUCT_JOURNEY_ID}/open`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restart`,
]);

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
  return harness.waitUntil(
    async () => {
      const rows = await queryRows(
        harness,
        page,
        "SELECT id FROM projects ORDER BY created_at, id LIMIT 1",
      );
      const projectId = String(rows[0]?.id ?? "");
      return projectId || null;
    },
    "C2-ZC product journey project authority",
    C2ZC_WAIT_MS,
    250,
  );
}

function sceneDocument(text) {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  });
}

async function createScene(harness, page, projectId) {
  const existing = await queryRows(
    harness,
    page,
    `SELECT id, project_id AS projectId
       FROM tree_nodes
      WHERE project_id = ? AND node_type = 'scene'
      ORDER BY created_at, id
      LIMIT 1`,
    [projectId],
  );
  if (existing[0]) return existing[0];

  const sceneId = `c2-zc-journey-scene-${randomUUID()}`;
  const eventUid = `c2-zc-journey-scene-create-${randomUUID()}`;
  await harness.invokeOk(page, "tree_node_create", {
    payload: {
      requestId: eventUid,
      eventUid,
      origin: "human",
      authorityRoute: "human-direct",
      caller: C2ZC_PRODUCT_JOURNEY_ID,
      controls: [
        "runtime-policy",
        "actor-context",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ],
      provenance: null,
      writesAuthorityProtectedField: false,
      originalTransactionId: null,
      undoJournalId: null,
      id: sceneId,
      projectId,
      sessionId: C2ZC_PRODUCT_JOURNEY_ID,
      nodeType: "scene",
      title: "C2-ZC canonical journey scene",
      sortOrder: "c2-zc",
      parentId: null,
      synopsis: null,
      status: null,
      sourceUri: null,
      sourceMtime: null,
      content: sceneDocument("C2-ZC canonical authority journey"),
    },
  });
  return harness.waitUntil(
    async () => {
      const rows = await queryRows(
        harness,
        page,
        "SELECT id, project_id AS projectId FROM tree_nodes WHERE id = ?",
        [sceneId],
      );
      return rows[0] ?? null;
    },
    "C2-ZC journey scene persistence",
    C2ZC_WAIT_MS,
    250,
  );
}

async function createProjectAfterCutover(harness, page) {
  const projectId = `c2-zc-journey-project-${randomUUID()}`;
  const now = new Date().toISOString();
  await harness.invokeOk(page, "project_create", {
    payload: {
      requestId: `c2-zc-journey-project-create:${projectId}`,
      projectId,
      sessionId: C2ZC_PRODUCT_JOURNEY_ID,
      eventUid: `c2-zc-journey-project-create-event:${projectId}`,
      origin: "human",
      originalTransactionId: null,
      undoJournalId: null,
      title: "C2-ZC post-marker project",
      genre: null,
      pov: null,
      tense: null,
      language: "ja",
      styleGuide: null,
      aiInstructions: null,
      outline: null,
      targetReaders: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return projectId;
}

async function readAuthoritySnapshot(harness, page, projectId) {
  const [marker, epochs, generic, legacy] = await Promise.all([
    queryRows(
      harness,
      page,
      `SELECT migration_id AS migrationId,
              contract_version AS contractVersion,
              applied_at AS appliedAt
         FROM schema_data_migrations
        WHERE migration_id = ?`,
      [C2ZC_CUTOVER_MIGRATION_ID],
    ),
    queryRows(
      harness,
      page,
      `SELECT id, epoch_number AS epochNumber
         FROM narrative_semantic_epochs
        WHERE project_id = ?
        ORDER BY epoch_number, id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT COUNT(*) AS count
         FROM narrative_consumer_freshness
        WHERE project_id = ? AND consumer_kind = ?`,
      [projectId, C2ZC_FRESHNESS_CONSUMER_KIND],
    ),
    queryRows(
      harness,
      page,
      `SELECT COUNT(*) AS count
         FROM narrative_projection_freshness f
         JOIN narrative_proposal_applications a ON a.id = f.application_id
         JOIN narrative_apply_commits c ON c.id = a.commit_id
        WHERE c.project_id = ?`,
      [projectId],
    ),
  ]);
  return {
    marker: marker[0] ?? null,
    epochs,
    genericCount: Number(generic[0]?.count ?? 0),
    legacyCount: Number(legacy[0]?.count ?? 0),
  };
}

async function waitForMarker(harness, page, projectId) {
  return harness.waitUntil(
    async () => {
      const snapshot = await readAuthoritySnapshot(harness, page, projectId);
      if (
        snapshot.marker?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID ||
        Number(snapshot.marker.contractVersion) !== C2ZC_CUTOVER_CONTRACT_VERSION ||
        snapshot.epochs.length === 0
      ) {
        return null;
      }
      return snapshot;
    },
    "C2-ZC canonical marker after main scheduler wake",
    C2ZC_WAIT_MS,
    250,
  );
}

function assertStableAuthority(before, after, label) {
  if (after.marker?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID) {
    throw new Error(`${label} lost the C2-ZC cutover marker`);
  }
  if (
    Number(after.marker.contractVersion) !== C2ZC_CUTOVER_CONTRACT_VERSION
  ) {
    throw new Error(`${label} changed the C2-ZC marker contract version`);
  }
  if (after.epochs.length !== before.epochs.length) {
    throw new Error(
      `${label} minted a second Semantic Epoch: ${JSON.stringify({
        before: before.epochs,
        after: after.epochs,
      })}`,
    );
  }
  if (
    after.epochs.some(
      (epoch, index) =>
        epoch.id !== before.epochs[index]?.id ||
        epoch.epochNumber !== before.epochs[index]?.epochNumber,
    )
  ) {
    throw new Error(`${label} changed the existing Semantic Epoch lineage`);
  }
}

/**
 * Run the production main -> N-API -> shared-Rust C2-ZC journey.  The
 * scheduler remains the only activation owner: this runner never invokes a
 * cutover command or writes the marker directly.
 */
export async function runC2ZcCanonicalAuthorityJourney(
  harness,
  configureWorkspace,
) {
  if (typeof configureWorkspace !== "function") {
    throw new Error("C2-ZC product journey requires configureWorkspace");
  }
  const workspace = harness.workspacePath(C2ZC_PRODUCT_JOURNEY_ID);
  await configureWorkspace(harness, workspace);
  const launched = await harness.launch(`${C2ZC_PRODUCT_JOURNEY_ID}/open`);
  let firstSnapshot;
  let projectId;
  try {
    projectId = await projectIdFor(harness, launched.page);
    await createScene(harness, launched.page, projectId);
    firstSnapshot = await waitForMarker(harness, launched.page, projectId);
    if (firstSnapshot.legacyCount < 0 || firstSnapshot.genericCount < 0) {
      throw new Error("C2-ZC authority counts must be non-negative");
    }
    harness.recordTimeline("c2-zc-canonical-authority-activated", {
      projectId,
      marker: firstSnapshot.marker,
      epochIds: firstSnapshot.epochs.map((epoch) => epoch.id),
      genericCount: firstSnapshot.genericCount,
      legacyCount: firstSnapshot.legacyCount,
      activationOwner: "electron-main:narrativeFreshness->napi",
    });
  } finally {
    await harness.close(launched.app, launched.page, `${C2ZC_PRODUCT_JOURNEY_ID}/open`);
  }

  const restarted = await harness.launch(`${C2ZC_PRODUCT_JOURNEY_ID}/restart`);
  try {
    const afterRestart = await waitForMarker(harness, restarted.page, projectId);
    assertStableAuthority(firstSnapshot, afterRestart, "C2-ZC restart");
    harness.recordTimeline("c2-zc-canonical-authority-restarted", {
      projectId,
      marker: afterRestart.marker,
      epochIds: afterRestart.epochs.map((epoch) => epoch.id),
    });

    const newProjectId = await createProjectAfterCutover(harness, restarted.page);
    const newProjectSnapshot = await harness.waitUntil(
      async () => {
        const snapshot = await readAuthoritySnapshot(
          harness,
          restarted.page,
          newProjectId,
        );
        return snapshot.epochs.length === 1 ? snapshot : null;
      },
      "C2-ZC post-marker project initial epoch",
      C2ZC_WAIT_MS,
      250,
    );
    if (newProjectSnapshot.epochs[0].epochNumber !== 0) {
      throw new Error(
        `C2-ZC post-marker project did not receive its one initial epoch: ${JSON.stringify(
          newProjectSnapshot.epochs,
        )}`,
      );
    }
    if (
      newProjectSnapshot.marker?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID ||
      Number(newProjectSnapshot.marker.contractVersion) !==
        C2ZC_CUTOVER_CONTRACT_VERSION
    ) {
      throw new Error("C2-ZC post-marker project lost workspace authority marker");
    }
    harness.recordTimeline("c2-zc-post-marker-project-created", {
      projectId: newProjectId,
      epochId: newProjectSnapshot.epochs[0].id,
      epochCount: newProjectSnapshot.epochs.length,
    });
  } finally {
    await harness.close(
      restarted.app,
      restarted.page,
      `${C2ZC_PRODUCT_JOURNEY_ID}/restart`,
    );
  }
}
