/* global window */
// CP-4 S1c-2 setup driver (TASK D1 (ii), D2 (A), §15.5, §15.8;
// DR-CP4-S1C2-2〜4). Replays a synthetic dev fixture's `setupOrder` through
// the product's normal writers and seams and writes the sealed workspace DB
// for the runner. It never reads a frozen G-case fixture.
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/setup-driver.mjs --run <name> \
//     --fixture scripts/quality/nir1-graph-eval/dev-fixtures/dev-lantern.v1.json \
//     --ja-model <pinned> --en-model <pinned>
//
// Two Electron sessions on the product `dist-electron/main.cjs` behind the
// NC-1 observer, with the same fresh profile (unrestricted, no D2a state):
//   1. author: project, Scenes, Scope registry and explicit Scene Scope,
//      Codex entries, a typed Relation, pins, the typed Revision (prepare +
//      explicit human approval), maintenance on (runtime policy), all through
//      the renderer API the UI uses. No SQL write; SELECTs only to read back.
//   2. seal: the B-ROUTE journey seam (unpackaged, CI=true, owner token,
//      nonce, trigger `nir1-graph-index-build`) opens the gated B build; the
//      workspace-opened wake runs the cycle; the driver waits for the sealed
//      B generation, then builds the Chronicle Index through the query route.
// Then the cold `grimodex.db` is copied (no WAL left) and the setup receipt
// (logical → runtime IDs, sealed metadata, seam receipt) is written.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { generateNKeysBetween } from "fractional-indexing";
import { admitDevPreview } from "./admission.mjs";
import { loadDevFixture, sceneRows } from "./dev-fixture.mjs";
import { ROOT, bundleObserver, PRODUCT_MAIN } from "./launcher.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { HARNESS_PAGE, sha256, startSession } from "./session.mjs";
import { readIndexMetadata, readWorkspaceRows } from "./workspace-db.mjs";
import {
  SCENE_SCOPE_BINDING_V1_COLUMNS,
  assertSeedPinSetup,
  fixturePinsRuntime,
  runSeedPinStep,
} from "./seed-pin-setup.mjs";
import { hostSnapshot } from "./window.mjs";

export const SETUP_RECEIPT_SCHEMA = "nir1-cp4-dev-setup/1";
const MAINTENANCE_SEAM = Object.freeze({
  ci: "CI",
  ownerTokenEnv: "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN",
  ownerToken: "c2-5b-product-journey-owner-v1",
  nonceEnv: "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_NONCE",
  triggerEnv: "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER",
  trigger: "nir1-graph-index-build",
});
const B_SEAL_WAIT_MS = 120_000;
const EPOCH_WAIT_MS = 180_000;
const PREPARE_WAIT_MS = 120_000;

function parseArgs(argv) {
  const options = {
    native: path.join(ROOT, ".artifacts/cp4/eval-build/grimodex-node.node"),
  };
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined)
      throw new Error("use --name value arguments");
    options[argv[at].slice(2)] = argv[at + 1];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.run ?? ""))
    throw new Error("--run <name> is required");
  for (const name of ["fixture", "ja-model", "en-model"])
    if (!options[name]) throw new Error(`--${name} is required`);
  return options;
}

async function evaluateOk(page, label, fn, arg) {
  const result = await page.evaluate(fn, arg);
  if (!result?.ok)
    throw new Error(
      `${label} failed: ${result?.error ?? JSON.stringify(result)}`,
    );
  return result.value;
}

function invokeOk(page, cmd, args = {}) {
  return evaluateOk(
    page,
    cmd,
    ([name, input]) => window.cp4Harness.call(name, input),
    [cmd, args],
  );
}

async function selectRows(page, sql, params = []) {
  return (await invokeOk(page, "db_execute", { sql, params, method: "all" }))
    .rows;
}

/**
 * SP/1 (graph-case-seed-pin-setup): the seed pin step's read and write on
 * the harness page. The write is the product renderer API `upsertScenePin`
 * (the one the fixture pins above use); the state is read back with SELECTs
 * only (the query Scene's tree node, its pins in the product's seed order,
 * every pin of the workspace and the Scene Scope binding's v1 columns).
 */
export function seedPinPageDeps({ page, projectId, querySceneId }) {
  return {
    readState: async () => {
      const node =
        (
          await selectRows(
            page,
            "SELECT project_id AS projectId, node_type AS nodeType, archived_at AS archivedAt, version, updated_at AS updatedAt FROM tree_nodes WHERE id = ?",
            [querySceneId],
          )
        )[0] ?? null;
      const queryScenePins = (
        await selectRows(
          page,
          `SELECT p.entry_id AS entryId, p.created_at AS createdAt,
                  CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS inProject
             FROM scene_codex_pins p
             LEFT JOIN codex_entries c ON c.id = p.entry_id AND c.project_id = ?
            WHERE p.scene_id = ?
            ORDER BY p.created_at, p.entry_id`,
          [projectId, querySceneId],
        )
      ).map((row) => ({
        entryId: String(row.entryId),
        createdAt: row.createdAt,
        entryInProject: Number(row.inProject) === 1,
      }));
      const workspacePins = (
        await selectRows(
          page,
          "SELECT scene_id AS sceneId, entry_id AS entryId FROM scene_codex_pins ORDER BY scene_id, entry_id",
        )
      ).map((row) => ({
        sceneId: String(row.sceneId),
        entryId: String(row.entryId),
      }));
      const binding =
        (
          await selectRows(
            page,
            `SELECT ${SCENE_SCOPE_BINDING_V1_COLUMNS.join(", ")} FROM narrative_scene_scope_bindings WHERE project_id = ? AND scene_id = ?`,
            [projectId, querySceneId],
          )
        )[0] ?? null;
      return {
        queryScene: {
          live:
            node !== null &&
            node.projectId === projectId &&
            node.nodeType === "scene" &&
            node.archivedAt === null,
          version: node?.version ?? null,
          updatedAt: node?.updatedAt ?? null,
        },
        queryScenePins,
        workspacePins,
        sceneScopeBinding: binding === null ? null : { ...binding },
      };
    },
    upsertScenePin: (input) =>
      evaluateOk(
        page,
        "seed pin",
        (value) => window.cp4Harness.api.upsertScenePin(value),
        input,
      ),
  };
}

async function author({
  page,
  workspacePath,
  loaded,
  ids,
  phase,
  seedPin = null,
}) {
  const fixture = loaded.fixture;
  const projectId = ids.projectId;
  await evaluateOk(
    page,
    "open workspace",
    (input) => window.cp4Harness.openWorkspace(input),
    {
      workspacePath,
      projectId: null,
    },
  );
  await evaluateOk(
    page,
    "create project",
    (input) => window.cp4Harness.api.createProject(input),
    {
      id: projectId,
      title: fixture.project.title,
      language: fixture.language,
    },
  );
  const project = (
    await selectRows(
      page,
      "SELECT updated_at AS updatedAt, phase_resolution_mode AS mode FROM projects WHERE id = ?",
      [projectId],
    )
  )[0];
  const writeContext = () =>
    page.evaluate(() => window.cp4Harness.api.humanWriteContext());
  if (project.mode !== "reading")
    await invokeOk(page, "project_patch", {
      payload: {
        ...(await writeContext()),
        projectId,
        baseUpdatedAt: project.updatedAt,
        updatedAt: new Date().toISOString(),
        patch: { phaseResolutionMode: "reading" },
      },
    });
  phase("project", { projectId, modeBefore: project.mode });

  const before = await invokeOk(page, "narrative_runtime_policy_get", {});
  const policy = await invokeOk(page, "narrative_runtime_policy_set", {
    payload: {
      expectedVersion: before.version,
      runtimeMode: before.runtimeMode,
      maintenanceEnabled: true,
      genericImportEnabled: before.genericImportEnabled,
      backgroundAiEnabled: before.backgroundAiEnabled,
    },
  });
  assert.equal(policy.maintenanceEnabled, true, "[artifact] maintenance on");
  // The project's initial semantic epoch is minted by the maintenance route
  // (legacy backfill / the C2ZC cutover) once maintenance runs; the typed
  // Revision cannot be prepared before it exists.
  const epochStarted = Date.now();
  let epochs = [];
  while (Date.now() - epochStarted < EPOCH_WAIT_MS) {
    epochs = await selectRows(
      page,
      "SELECT id, epoch_number AS epochNumber, reason FROM narrative_semantic_epochs WHERE project_id = ? ORDER BY epoch_number",
      [projectId],
    );
    if (epochs.length > 0) break;
    await sleep(500);
  }
  if (epochs.length === 0)
    throw new Error(
      `[precheck] blocked:maintenance-enabled — no semantic epoch for the project within ${EPOCH_WAIT_MS} ms`,
    );
  // The canonical (C2-ZC) authority is activated by the product's own
  // freshness scheduler wake once Verify evidence is complete; typed
  // Revisions and the Chronicle Index require it.
  let marker = [];
  while (Date.now() - epochStarted < EPOCH_WAIT_MS) {
    marker = await selectRows(
      page,
      "SELECT migration_id AS migrationId, contract_version AS contractVersion FROM schema_data_migrations WHERE migration_id LIKE 'narrative-c2-canonical-freshness-%'",
    );
    if (marker.length > 0) break;
    await sleep(500);
  }
  if (marker.length === 0)
    throw new Error(
      `[precheck] blocked:maintenance-enabled — the canonical cutover marker did not appear within ${EPOCH_WAIT_MS} ms`,
    );
  phase("maintenance-enabled", {
    before,
    after: policy,
    epochAndCutoverWaitMs: Date.now() - epochStarted,
    epochs,
    cutoverMarker: marker,
  });

  const rows = sceneRows(loaded);
  const keys = generateNKeysBetween(null, null, rows.length);
  for (const [index, scene] of rows.entries())
    await invokeOk(page, "tree_node_create", {
      payload: {
        ...(await writeContext()),
        id: scene.id,
        projectId,
        parentId: null,
        nodeType: "scene",
        status: "draft",
        title: scene.title,
        sortOrder: keys[index],
        content: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: scene.body }],
            },
          ],
        }),
        canonicalPayload: {
          parentId: null,
          sortOrder: keys[index],
          title: scene.title,
        },
      },
    });
  await evaluateOk(
    page,
    "select project",
    (input) => window.cp4Harness.selectProject(input),
    {
      projectId,
      activeSceneId: fixture.query.sceneId,
    },
  );
  for (const scene of rows) {
    const textBack = await evaluateOk(
      page,
      "scene text",
      (id) => window.cp4Harness.api.sceneText(id),
      scene.id,
    );
    assert.equal(
      textBack,
      `${scene.body}\n`,
      `[artifact] scene ${scene.id} body`,
    );
  }
  phase("scenes", { count: rows.length });

  const readScope = (sceneId) =>
    invokeOk(page, "narrative_scene_scope_read", {
      expectedWorkspacePath: workspacePath,
      projectId,
      sceneId,
    });
  const first = await readScope(rows[0].id);
  const refs = fixture.scopeRefs;
  await invokeOk(page, "narrative_scene_scope_registry_update", {
    expectedWorkspacePath: workspacePath,
    payload: {
      projectId,
      requestId: randomUUID(),
      sessionId: randomUUID(),
      eventUid: randomUUID(),
      baseVersion: first.registryRevision,
      updatedAt: new Date().toISOString(),
      registry: {
        ...first.registry,
        timelineRefs: [refs.timeline],
        worldlineRefs: [refs.worldline],
        narrativeLayerRefs: [refs.narrativeLayer],
      },
    },
  });
  phase("scope-registry");
  const exact = (ref) => ({ kind: "exact", ref });
  const axes = {
    timeline: exact(refs.timeline),
    worldline: exact(refs.worldline),
    narrativeLayer: exact(refs.narrativeLayer),
  };
  for (const scene of rows) {
    const current = await readScope(scene.id);
    await invokeOk(page, "narrative_scene_scope_update", {
      expectedWorkspacePath: workspacePath,
      payload: {
        projectId,
        sceneId: scene.id,
        requestId: randomUUID(),
        sessionId: randomUUID(),
        eventUid: randomUUID(),
        baseVersion: current.binding.version,
        updatedAt: new Date().toISOString(),
        scope: {
          schemaVersion: 1,
          compatibilityMarker: "explicit",
          queryIdentity: axes,
          materialConstraint: axes,
          knowledgeHolder: { kind: "reader" },
          audience: { kind: "reader" },
        },
      },
    });
  }
  const scopes = {};
  for (const scene of rows) {
    const binding = (await readScope(scene.id)).binding;
    assert.equal(binding.compatibilityMarker, "explicit", scene.id);
    scopes[scene.id] = binding;
  }
  phase("scene-scope", { scenes: Object.keys(scopes).length });

  for (const entity of fixture.entities) {
    const runtimeId = randomUUID();
    const created = await evaluateOk(
      page,
      `codex ${entity.id}`,
      (input) => window.cp4Harness.api.createCodexEntry(input),
      {
        id: runtimeId,
        projectId,
        type: entity.type,
        name: entity.name,
        summary: entity.summary,
      },
    );
    ids.entities[entity.id] = created.id;
  }
  phase("entities", { entities: ids.entities });
  for (const relation of fixture.relations) {
    const created = await evaluateOk(
      page,
      `relation ${relation.id}`,
      (input) => window.cp4Harness.api.createCodexRelation(input),
      {
        id: randomUUID(),
        projectId,
        fromCodexId: ids.entities[relation.fromEntityId],
        toCodexId: ids.entities[relation.toEntityId],
        relationType: relation.relationType,
        label: relation.label,
        directionality: relation.directionality,
      },
    );
    ids.relations[relation.id] = created.id;
  }
  phase("relations", { relations: ids.relations });
  for (const pin of fixture.pins) {
    await evaluateOk(
      page,
      `pin ${pin.sceneId}`,
      (input) => window.cp4Harness.api.upsertScenePin(input),
      {
        sceneId: pin.sceneId,
        entryId: ids.entities[pin.entityId],
      },
    );
    ids.pins.push({
      sceneId: pin.sceneId,
      entryId: ids.entities[pin.entityId],
    });
  }
  phase("pins", { pins: ids.pins });
  // SP/1: the seed pin step, outside setupOrder, right after the pins. Only a
  // frozen G-case setup passes a plan row (wired from S4); the dev fixture's
  // seed pin stays in the K6/4 runner's prep (DR-CP4-G-5). The placement and
  // the record are checked in main (assertSeedPinSetup).
  const seedPinRecord = seedPin
    ? await runSeedPinStep({
        plan: seedPin.plan,
        ids,
        deps: seedPinPageDeps({
          page,
          projectId,
          querySceneId: ids.scenes[seedPin.plan.querySceneId],
        }),
        phase,
      })
    : null;

  for (const revision of fixture.typedRevisions) {
    const workspaceBinding = await invokeOk(
      page,
      "narrative_extraction_capture_workspace_binding",
      { expectedWorkspacePath: workspacePath },
    );
    // Prepare reads the canonical Freshness of the new material, which the
    // product's freshness scheduler publishes after the writes above. A
    // `canonical-freshness-unavailable` refusal writes nothing; it is retried
    // (bounded, recorded) the way an author would retry the dialog.
    const prepareStarted = Date.now();
    const refusals = [];
    let prepared = null;
    while (!prepared) {
      const attempt = await page.evaluate(
        ([name, input]) => window.cp4Harness.call(name, input),
        [
          "nir1_entity_relation_revision_prepare",
          {
            payload: {
              projectId,
              sceneId: revision.sceneId,
              entityIds: revision.entityIds.map((id) => ids.entities[id]),
              relationIds: revision.relationIds.map((id) => ids.relations[id]),
            },
            workspaceBinding,
          },
        ],
      );
      if (attempt.ok) prepared = attempt.value;
      else if (
        /canonical-freshness-unavailable/u.test(attempt.error) &&
        Date.now() - prepareStarted < PREPARE_WAIT_MS
      ) {
        refusals.push({
          atMs: Date.now() - prepareStarted,
          error: attempt.error.slice(0, 200),
        });
        await sleep(500);
      } else
        throw new Error(
          `nir1_entity_relation_revision_prepare failed: ${attempt.error}`,
        );
    }
    assert.equal(
      prepared.status,
      "draft",
      "[artifact] typed Revision is a draft first",
    );
    await invokeOk(page, "narrative_extraction_append_human_decision", {
      payload: {
        runId: prepared.runId,
        projectId,
        proposalId: prepared.receipt.proposalId,
        revisionId: prepared.receipt.revisionId,
        decision: "approved",
        createdBy: "nir1-entity-relation-review",
      },
    });
    const current = await invokeOk(
      page,
      "nir1_entity_relation_revision_read_current",
      {
        expectedWorkspacePath: workspacePath,
        projectId,
        runId: prepared.runId,
      },
    );
    assert.equal(
      current.status,
      "available",
      "[artifact] approval makes the typed Revision available",
    );
    ids.typedRevisions[revision.id] = {
      prepareWaitMs: Date.now() - prepareStarted,
      prepareRefusals: refusals.length,
      runId: String(prepared.runId),
      proposalId: String(prepared.receipt.proposalId),
      revisionId: String(prepared.receipt.revisionId),
    };
  }
  phase("typed-revisions", { typedRevisions: ids.typedRevisions });

  return { scopes, policy, seedPin: seedPinRecord };
}

async function seal({ page, workspacePath, ids, phase, userData }) {
  await evaluateOk(
    page,
    "open workspace",
    (input) => window.cp4Harness.openWorkspace(input),
    {
      workspacePath,
      projectId: ids.projectId,
      activeSceneId: ids.querySceneId,
    },
  );
  const started = Date.now();
  let metadata = null;
  while (Date.now() - started < B_SEAL_WAIT_MS) {
    metadata = readIndexMetadata(
      path.join(workspacePath, "grimodex.db"),
      ids.projectId,
    );
    if (metadata.b && metadata.b.generation > 0 && metadata.b.dirty === false)
      break;
    await sleep(500);
  }
  const receiptRoot = path.join(userData, ".grimodex-product-journey-receipts");
  const seamReceipts = [];
  if (existsSync(receiptRoot))
    for (const entry of await readdir(receiptRoot, { recursive: true }))
      if (String(entry).endsWith(".json")) {
        const file = path.join(receiptRoot, String(entry));
        const bytes = await readFile(file);
        seamReceipts.push({
          file: String(entry),
          sha256: sha256(bytes),
          value: JSON.parse(bytes),
        });
      }
  if (!(metadata?.b?.generation > 0 && metadata.b.dirty === false))
    throw new Error(
      `[precheck] blocked:b-sealed-binding — no sealed B generation within ${B_SEAL_WAIT_MS} ms (${JSON.stringify(metadata)})`,
    );
  phase("b-seal", { waitedMs: Date.now() - started, metadata });
  const index = await page.evaluate(
    (input) => window.cp4Harness.buildIndex(input),
    {
      sceneId: ids.querySceneId,
      limitMs: 60_000,
    },
  );
  if (!index.ok)
    throw new Error(
      `[precheck] the Chronicle Index did not become usable: ${JSON.stringify(index.probes.at(-1))}`,
    );
  const after = readIndexMetadata(
    path.join(workspacePath, "grimodex.db"),
    ids.projectId,
  );
  phase("chronicle-index", {
    durationMs: index.durationMs,
    probes: index.probes.length,
    metadata: after,
  });
  return {
    metadata: after,
    seamReceipts,
    index: { durationMs: index.durationMs, probes: index.probes.length },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: true });
  const setupDir = path.join(runDir, "setup");
  await mkdir(setupDir, { recursive: false });
  const loaded = loadDevFixture({ root: ROOT, fixturePath: options.fixture });
  const nativePath = path.resolve(options.native);
  const admission = admitDevPreview({
    purpose: "setup",
    fixture: loaded,
  });
  const receipt = {
    schemaVersion: SETUP_RECEIPT_SCHEMA,
    status: "failed",
    preview: true,
    fixture: { path: loaded.path, sha256: loaded.sha256, kind: "dev" },
    startedAt: new Date().toISOString(),
    hostBefore: hostSnapshot(),
    native: {
      path: path.relative(ROOT, nativePath),
      sha256: sha256(await readFile(nativePath)),
    },
    productMain: {
      path: PRODUCT_MAIN,
      sha256: sha256(await readFile(path.join(ROOT, PRODUCT_MAIN))),
    },
    phases: [],
    sessions: [],
    errors: [],
  };
  const phase = (name, details = {}) => {
    receipt.phases.push({ name, at: new Date().toISOString(), ...details });
    process.stdout.write(`cp4 setup: ${name}\n`);
  };
  const save = () =>
    writeFile(
      path.join(setupDir, "setup-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
  let server;
  try {
    receipt.rendererBuild = await buildHarnessRenderer({
      root: ROOT,
      outDir: path.relative(ROOT, path.join(runDir, "renderer-dist")),
      input: {
        index: path.join(ROOT, "index.html"),
        harness: path.join(ROOT, HARNESS_PAGE.slice(1)),
      },
    });
    delete receipt.rendererBuild.files;
    server = await startStaticServer({
      dir: path.join(runDir, "renderer-dist"),
    });
    const observer = await bundleObserver({
      outDir: path.join(runDir, "observer"),
    });
    receipt.observerBundle = {
      sha256: observer.sha256,
      sources: observer.sources,
    };
    const workspacePath = path.join(setupDir, "workspace");
    const ids = {
      projectId: loaded.fixture.project.id,
      querySceneId: loaded.fixture.query.sceneId,
      scenes: Object.fromEntries(
        sceneRows(loaded).map((row) => [row.id, row.id]),
      ),
      entities: {},
      relations: {},
      pins: [],
      typedRevisions: {},
    };
    const models = { ja: options["ja-model"], en: options["en-model"] };
    const authorSession = await startSession({
      runDir: setupDir,
      label: "author",
      server,
      observer,
      nativePath,
      d2aMode: "unrestricted",
      models,
      tmpRoot: options.tmp ? path.join(options.tmp, options.run) : null,
      admission,
    });
    try {
      if (authorSession.evidence.problems.length > 0)
        throw new Error(authorSession.evidence.problems.join("; "));
      receipt.author = await author({
        page: authorSession.page,
        workspacePath,
        loaded,
        ids,
        phase,
        // SP/1: a dev fixture runs no seed pin step here (DR-CP4-G-5).
        seedPin: null,
      });
    } finally {
      receipt.sessions.push(await authorSession.stop());
      await save();
    }
    // Before the seal session: no B generation yet (the B build is gated to
    // the B-ROUTE seam, which the author session does not carry).
    receipt.metadataAfterAuthor = readIndexMetadata(
      path.join(workspacePath, "grimodex.db"),
      ids.projectId,
    );
    const nonce = randomUUID();
    const sealSession = await startSession({
      runDir: setupDir,
      label: "seal",
      server,
      observer,
      nativePath,
      d2aMode: "unrestricted",
      models,
      tmpRoot: options.tmp ? path.join(options.tmp, options.run) : null,
      admission,
      extraEnv: {
        [MAINTENANCE_SEAM.ci]: "true",
        [MAINTENANCE_SEAM.ownerTokenEnv]: MAINTENANCE_SEAM.ownerToken,
        [MAINTENANCE_SEAM.nonceEnv]: nonce,
        [MAINTENANCE_SEAM.triggerEnv]: MAINTENANCE_SEAM.trigger,
      },
    });
    try {
      if (sealSession.evidence.problems.length > 0)
        throw new Error(sealSession.evidence.problems.join("; "));
      receipt.seal = await seal({
        page: sealSession.page,
        workspacePath,
        ids,
        phase,
        userData: sealSession.userData,
      });
      receipt.seal.seam = {
        envNames: Object.values(MAINTENANCE_SEAM).filter((value) =>
          /^[A-Z_]+$/u.test(value),
        ),
        trigger: MAINTENANCE_SEAM.trigger,
        nonceSha256: sha256(Buffer.from(nonce)),
      };
      receipt.readBack = await readWorkspaceRows(
        path.join(workspacePath, "grimodex.db"),
        ids.projectId,
      );
    } finally {
      receipt.sessions.push(await sealSession.stop());
      await save();
    }
    const cold = path.join(setupDir, "cold-workspace");
    await mkdir(cold);
    for (const suffix of ["-wal", "-shm"]) {
      const file = path.join(workspacePath, `grimodex.db${suffix}`);
      if (existsSync(file) && suffix === "-wal" && statSync(file).size > 0)
        throw new Error(
          "[artifact] the setup workspace kept a non-empty WAL after close",
        );
    }
    await copyFile(
      path.join(workspacePath, "grimodex.db"),
      path.join(cold, "grimodex.db"),
    );
    receipt.coldDatabase = {
      path: path.relative(ROOT, path.join(cold, "grimodex.db")),
      sha256: sha256(await readFile(path.join(cold, "grimodex.db"))),
      metadata: readIndexMetadata(
        path.join(cold, "grimodex.db"),
        ids.projectId,
      ),
    };
    receipt.logicalToRuntime = ids;
    // SP/1: when the step ran, its place among the phases and its record
    // (SP-N1〜N6, N8, N9, N14, SP-P1, SP-P2); `[precheck]` otherwise.
    if (receipt.author?.seedPin)
      receipt.seedPin = assertSeedPinSetup({
        phases: receipt.phases.map((row) => row.name),
        record: receipt.author.seedPin,
        fixturePins: fixturePinsRuntime(loaded.fixture, ids),
      });
    // The precondition evidence in the shape outcome.mjs reads (dev variants
    // declare no precondition; recorded for the formal setups to come).
    const sealPhase = receipt.phases.find((row) => row.name === "b-seal");
    receipt.preconditionEvidence = {
      bSealedBinding: {
        route: "b-route-maintenance",
        publisher: "product",
        sealedGeneration: receipt.coldDatabase.metadata.b?.generation ?? null,
        bBeforeSealSession: receipt.metadataAfterAuthor.b,
      },
      maintenance: {
        enabledVia: "runtime-policy-setting",
        sqlOverride: false,
        probe: {
          sealedChronicleGeneration:
            receipt.coldDatabase.metadata.chronicle?.generation ?? null,
          sealedGraphGeneration:
            receipt.coldDatabase.metadata.b?.generation ?? null,
          sealedAtMs: sealPhase ? Date.parse(sealPhase.at) : null,
        },
      },
    };
    const problems = receipt.sessions.flatMap((row) => row.problems ?? []);
    receipt.status =
      problems.length === 0 ? "setup-complete" : "setup-with-problems";
    if (problems.length > 0) receipt.errors.push(...problems);
  } catch (error) {
    receipt.errors.push(error?.stack ?? String(error));
    process.exitCode = 1;
  } finally {
    await server?.close();
    receipt.finishedAt = new Date().toISOString();
    receipt.hostAfter = hostSnapshot();
    await save();
    process.stdout.write(
      `${JSON.stringify({ status: receipt.status, errors: receipt.errors.map((row) => String(row).split("\n")[0]) })}\n`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
