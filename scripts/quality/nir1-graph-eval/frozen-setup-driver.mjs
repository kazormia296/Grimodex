/* global window */
// CP-4 S1i: 凍結した G-case の setup の driver（DR-CP4-I-*）。
//
// frozen-setup-plan.mjs が凍結した fixture から導いた段の並び（setupOrder と
// setupTimeline の再生、SP/1 の seed の pin の段）を、製品の renderer の write API
// と IPC だけで 1 つの variant の新しい workspace に再生し、cold DB と setup の受領書
// （論理 ID → runtime ID の対応、各 phase の前後の状態、seed の pin の段の記録、候補
// の commit）を書く。SQL の書込み、状態の注入、試験専用の入口は使わない（SELECT の
// 読み戻しだけ）。
//
// 停止位置:
//   - `seed-pin`（① R5 の照合の run。S2 の r5Gate.exempt の r5-seed-pin-check）:
//     author の session で seed の pin の段と SP-P2 の記録まで。maintenance の
//     有効化、setupTimeline、typed Revision、B と Chronicle の Index の build、
//     Index の状態の記録を行わない。driver の guard が S2 の範囲の外の IPC と
//     page の入口を拒む。workspace は捨て、④⑤ に使わない。
//   - `complete`（⑤ の評価の run 用。S5 の候補で新しく作る）: 続けて maintenance
//     を実設定で有効にし、setupTimeline を順に再生し、B-ROUTE の journey seam の
//     seal の session で B の seal と Chronicle の Index を確立する。対応する
//     writer の無い step（plan の `[precheck]` の executor）に着いたら止める。
//
// 凍結した材料で実行するのは integrator（S4 の前の ①）。この lane は実行しない。
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/frozen-setup-driver.mjs --run <name> \
//     --case G-02 --variant base --stops-at seed-pin \
//     --product-receipt <standard-build receipt> --ja-model <pinned> --en-model <pinned>

import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { generateNKeysBetween } from "fractional-indexing";
import { admitFrozenDryRun } from "./admission.mjs";
import {
  DEFAULT_ADDON,
  PRODUCT_MAIN,
  ROOT,
  bundleObserver,
} from "./launcher.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import {
  R5_CHECK_FORBIDS,
  R5_CHECK_RUN,
  SETUP_STOPS,
  assertR5CheckPhases,
  executedPhaseNames,
  loadDevGraphCasePlans,
  loadFrozenSetupPlans,
  phaseCategories,
  plannedPhaseNames,
} from "./frozen-setup-plan.mjs";
import { buildSetupMain, removeSetupMain } from "./setup-main-build.mjs";
import {
  SEED_PIN_PHASE,
  SP1_CONTRACT,
  assertSeedPinSetup,
  runSeedPinStep,
} from "./seed-pin-setup.mjs";
import { HARNESS_PAGE, sha256, startSession } from "./session.mjs";
import { seedPinPageDeps } from "./setup-driver.mjs";
import {
  FROZEN_SETUP_RECEIPT_SCHEMA,
  SETUP_STATUS_BY_STOP,
} from "./setup-receipt.mjs";
import {
  readChronicleSetupRows,
  readFrozenSetupRows,
  readIndexMetadata,
  readRelationSourceTokens,
  readRunsSince,
} from "./workspace-db.mjs";
import { REQUIRED_ARTIFACTS } from "../nir1-retrieval/standard-build-receipt.mjs";

export { FROZEN_SETUP_RECEIPT_SCHEMA };

/** ① may call only these IPC commands (db_execute: SELECT only). */
export const R5_CHECK_ALLOWED_IPC = Object.freeze([
  "db_execute",
  "project_patch",
  "tree_node_create",
  "narrative_scene_scope_read",
  "narrative_scene_scope_registry_update",
  "narrative_scene_scope_update",
]);
/** ① may call only these harness page entries (the renderer write API). */
export const R5_CHECK_ALLOWED_PAGE = Object.freeze([
  "openWorkspace",
  "selectProject",
  "api.createProject",
  "api.createCodexEntry",
  "api.createCodexRelation",
  "api.createForeshadow",
  "api.addForeshadowCodexLink",
  "api.upsertScenePin",
  "api.sceneText",
  "api.humanWriteContext",
]);
/** The B-ROUTE journey seam (the same values as setup-driver.mjs). */
const MAINTENANCE_SEAM = Object.freeze({
  ci: "CI",
  ownerTokenEnv: "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN",
  ownerToken: "c2-5b-product-journey-owner-v1",
  nonceEnv: "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_NONCE",
  triggerEnv: "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER",
  trigger: "nir1-graph-index-build",
});
/**
 * S1j-2 P-0 (integrator's decision (a)): one wait for a new sealed B
 * generation, and how many times a seam session whose wait ran out is closed
 * and reopened (a new workspace-opened wake). Fixed constants (the tests pin
 * them); a setup never tunes them to its result.
 */
export const B_SEAL_WAIT_MS = 120_000;
export const B_SEAL_REOPENS = 2;
const B_SEAL_NOT_PUBLISHED = "blocked:b-seal-not-published";
/**
 * Review P2-4: the product's refusal to reuse a Relation ID (the primary key
 * conflict of `codex_relations`). Only this switches to (B'') a new ID.
 */
export const RELATION_ID_REUSE_REFUSAL =
  /UNIQUE constraint failed: codex_relations\.id/u;
/**
 * P-5 (integrator's decision (a)): one wait for the project's semantic epoch
 * and the canonical cutover marker, and how many times an author session
 * whose wait ran out is closed and reopened from the maintenance step.
 * Fixed constants (the tests pin them).
 */
export const MAINTENANCE_WAIT_MS = 180_000;
export const MAINTENANCE_REOPENS = 2;
const PREPARE_WAIT_MS = 120_000;
const SELECT_ONLY = /^\s*SELECT\b/iu;

function fail(code, detail) {
  throw new Error(`[precheck] S1i ${code}: ${detail}`);
}

/**
 * Review P2-2 (S3 の決定): a blocked setup keeps the harness's own name, and
 * names the README preconditions it leaves unmet. The receipt maps them to
 * the contract's id in a field of its own (`blockedRecord`).
 */
function failBlocked(code, harnessId, unmet, detail) {
  const error = new Error(
    `[precheck] S1i ${code}: blocked:${harnessId} — ${detail}`,
  );
  error.blocked = { harnessId, unmet: [...unmet] };
  throw error;
}

/** README の前提条件の定義順（「観測時の前提条件と blocked」の表）. */
export const README_PRECONDITION_ORDER = Object.freeze([
  "b-sealed-binding",
  "maintenance-enabled",
  "raw-membership",
  "ir-supplement-admission",
  "index-state-holding",
  "cb4-inputs",
]);

/**
 * The receipt's blocked record: the harness's name, every unmet README
 * precondition (definition order), and the contract's id — the first unmet
 * one the variant declares (`blocked:<id>`), or null with `hold: true` when
 * the variant declares none of them (G-01 is Hold; a Chronicle-only
 * mismatch is Hold and `[precheck]`).
 */
export function blockedRecord({ plan, blocked }) {
  const unmet = README_PRECONDITION_ORDER.filter((id) =>
    (blocked?.unmet ?? []).includes(id),
  );
  const declared = plan.preconditions ?? [];
  const contractBlockedId = unmet.find((id) => declared.includes(id)) ?? null;
  return {
    harnessId: blocked?.harnessId ?? null,
    unmetPreconditions: unmet,
    declaredPreconditions: [...declared],
    contractBlockedId,
    hold: contractBlockedId === null,
  };
}

const partialRun = (plan) => plan?.stopsAt === SETUP_STOPS.seedPin;
const nonBlankId = (value) => typeof value === "string" && value.length > 0;

/**
 * The driver's guard on every IPC command: SQL writes are never sent, and ①
 * sends only the commands of setupOrder up to the seed pin step.
 */
export function guardIpc(plan, cmd, args = {}) {
  if (
    cmd === "db_execute" &&
    (args.method !== "all" || !SELECT_ONLY.test(args.sql ?? ""))
  )
    fail(
      partialRun(plan) ? "r5-check" : "sql",
      `${plan?.variantKey}: db_execute is used for SELECT read-backs only`,
    );
  if (partialRun(plan) && !R5_CHECK_ALLOWED_IPC.includes(cmd))
    fail(
      "r5-check",
      `${plan.variantKey}: ${cmd} is outside ${R5_CHECK_RUN} (setup through the seed pin step and product DB reads only)`,
    );
}

/**
 * S1j-2: the Chronicle review entries run only in the setup-only Main's
 * session (the qualified-ir step); the withdrawal's Decision writer only in
 * a product Main session.
 */
export const SESSION_PAGE_ENTRIES = Object.freeze({
  "chronicle.extract": ["ir"],
  "chronicle.revise": ["ir"],
  "chronicle.decide": ["ir"],
  "chronicle.recordDecision": ["author", "seal", "hold", "reseal"],
});

/** The guard on every harness page entry. */
export function guardPage(plan, entry, session = null) {
  if (partialRun(plan) && !R5_CHECK_ALLOWED_PAGE.includes(entry))
    fail(
      "r5-check",
      `${plan.variantKey}: the page entry ${entry} is outside ${R5_CHECK_RUN}`,
    );
  const sessions = SESSION_PAGE_ENTRIES[entry];
  if (sessions && !sessions.includes(session))
    fail(
      "session",
      `${plan?.variantKey}: the page entry ${entry} does not run in the ${String(session)} session`,
    );
}

async function pageAttempt(ctx, entry, input) {
  guardPage(ctx.plan, entry, ctx.session ?? null);
  return ctx.page.evaluate(
    ([name, arg]) => {
      const harness = window.cp4Harness;
      const [head, tail] = name.split(".");
      const fn = tail ? harness[head][tail] : harness[head];
      return fn(arg);
    },
    [entry, input],
  );
}

async function pageCall(ctx, entry, input) {
  guardPage(ctx.plan, entry, ctx.session ?? null);
  const result = await ctx.page.evaluate(
    ([name, arg]) => {
      const harness = window.cp4Harness;
      const [head, tail] = name.split(".");
      const fn = tail ? harness[head][tail] : harness[head];
      return fn(arg);
    },
    [entry, input],
  );
  if (entry === "api.humanWriteContext") return result;
  if (!result?.ok)
    throw new Error(
      `${entry} failed: ${result?.error ?? JSON.stringify(result)}`,
    );
  return result.value;
}

async function ipcAttempt(ctx, cmd, args = {}) {
  guardIpc(ctx.plan, cmd, args);
  return ctx.page.evaluate(
    ([name, input]) => window.cp4Harness.call(name, input),
    [cmd, args],
  );
}

async function ipc(ctx, cmd, args = {}) {
  const result = await ipcAttempt(ctx, cmd, args);
  if (!result?.ok)
    throw new Error(
      `${cmd} failed: ${result?.error ?? JSON.stringify(result)}`,
    );
  return result.value;
}

const SWITCHING_WAIT_MS = 30_000;

async function select(ctx, sql, params = []) {
  // S1j-2: a later session's workspace open can still be settling when the
  // first read arrives (`WORKSPACE_SWITCHING`, nothing read); the read is
  // retried within a bound. ① (the author session only) keeps one attempt.
  const started = Date.now();
  for (;;) {
    const result = await ipcAttempt(ctx, "db_execute", {
      sql,
      params,
      method: "all",
    });
    if (result?.ok) return result.value.rows;
    if (
      partialRun(ctx.plan) ||
      !/WORKSPACE_SWITCHING/u.test(result?.error ?? "") ||
      Date.now() - started > SWITCHING_WAIT_MS
    )
      throw new Error(
        `db_execute failed: ${result?.error ?? JSON.stringify(result)}`,
      );
    ctx.switchingRetries = (ctx.switchingRetries ?? 0) + 1;
    await ctx.sleep(250);
  }
}

const writeContext = (ctx) => pageCall(ctx, "api.humanWriteContext");

/** The ids map of one variant's setup (logical → runtime, filled by the writers). */
export function createSetupIds({ plan, uuid = randomUUID }) {
  return {
    projectId: uuid(),
    // The logical query Scene (its runtime ID is `scenes[querySceneId]`).
    querySceneId: plan.querySceneId,
    scenes: {},
    // The harness's folders of the qualifiedIr Scenes (not fixture IDs).
    folders: {},
    entities: {},
    relations: {},
    foreshadows: {},
    pins: [],
    typedRevisions: {},
  };
}

function runtimeOf(map, logical, label) {
  const value = map?.[logical];
  if (typeof value !== "string" || value.length === 0)
    fail(
      "logical-runtime",
      `the setup maps no runtime ID to ${label} ${logical}`,
    );
  return value;
}

/** The fixture's pins with this setup's runtime IDs (SP-P2's baseline). */
export function frozenSetupFixturePins(plan, ids) {
  const pins = plan.steps.find((step) => step.phase === "pins");
  return pins.input.rows.map((row) => ({
    sceneId: ids.scenes[row.sceneId] ?? null,
    entryId: ids.entities[row.entityId] ?? null,
  }));
}

/** Counts of the setup's materials (the state before and after each phase). */
async function readPhaseState(ctx) {
  const projectId = ctx.ids.projectId;
  const [row] = await select(
    ctx,
    `SELECT
       (SELECT count(*) FROM projects WHERE id = ?) AS projects,
       (SELECT count(*) FROM tree_nodes WHERE project_id = ?) AS treeNodes,
       (SELECT count(*) FROM codex_entries WHERE project_id = ?) AS codexEntries,
       (SELECT count(*) FROM codex_relations WHERE project_id = ?) AS codexRelations,
       (SELECT count(*) FROM narrative_scene_scope_bindings
          WHERE project_id = ? AND compatibility_marker = 'explicit') AS explicitSceneScopes,
       (SELECT version FROM narrative_scope_registries WHERE project_id = ?) AS registryVersion,
       (SELECT count(*) FROM foreshadows WHERE project_id = ?) AS foreshadows,
       (SELECT count(*) FROM foreshadow_codex_links l JOIN foreshadows f ON f.id = l.foreshadow_id
          WHERE f.project_id = ?) AS foreshadowLinks,
       (SELECT count(*) FROM scene_codex_pins p JOIN tree_nodes t ON t.id = p.scene_id
          WHERE t.project_id = ?) AS pins`,
    Array(9).fill(projectId),
  );
  return Object.fromEntries(
    Object.entries(row ?? {}).map(([key, value]) => [
      key,
      value === null ? null : Number(value),
    ]),
  );
}

/** Tree order, registry and Scene Scope (the setupOrder freeze after the first typed Revision). */
async function readAuthority(ctx) {
  const projectId = ctx.ids.projectId;
  return {
    treeOrder: await select(
      ctx,
      "SELECT id, parent_id AS parentId, sort_order AS sortOrder FROM tree_nodes WHERE project_id = ? ORDER BY id",
      [projectId],
    ),
    registry: await select(
      ctx,
      `SELECT timeline_refs_json AS timelineRefs, worldline_refs_json AS worldlineRefs,
              narrative_layer_refs_json AS narrativeLayerRefs
         FROM narrative_scope_registries WHERE project_id = ?`,
      [projectId],
    ),
    sceneScope: await select(
      ctx,
      `SELECT scene_id AS sceneId, compatibility_marker AS marker,
              query_identity_json AS queryIdentity, material_constraint_json AS materialConstraint,
              knowledge_holder_json AS knowledgeHolder, audience_json AS audience
         FROM narrative_scene_scope_bindings WHERE project_id = ? ORDER BY scene_id`,
      [projectId],
    ),
  };
}

const principalOf = (ids, value) =>
  value?.kind === "character"
    ? {
        kind: "character",
        ref: runtimeOf(ids.entities, value.entityId, "the Scope holder"),
      }
    : { kind: "reader" };

/** The writer's Scope payload of one plan write (runtime holder refs). */
function scopePayload(ids, scope) {
  return {
    schemaVersion: 1,
    compatibilityMarker: "explicit",
    queryIdentity: scope.queryIdentity,
    materialConstraint: scope.materialConstraint,
    knowledgeHolder: principalOf(ids, scope.knowledgeHolder),
    audience: principalOf(ids, scope.audience),
  };
}

const doc = (body) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
  });

function precheckOf(step) {
  const { code, reason, options } = step.precheck;
  return `[precheck] S1i ${code}: ${step.phase} — ${reason}。選択肢: ${options.join(" ")}`;
}

/** The step executors (one per plan `executor`). */
const EXECUTORS = Object.freeze({
  async project({ ctx, step }) {
    const { ids, workspacePath } = ctx;
    await pageCall(ctx, "openWorkspace", { workspacePath, projectId: null });
    ctx.workspaceOpen = true;
    await pageCall(ctx, "api.createProject", {
      id: ids.projectId,
      title: step.input.title,
      language: step.input.language,
    });
    const [project] = await select(
      ctx,
      "SELECT updated_at AS updatedAt, phase_resolution_mode AS mode FROM projects WHERE id = ?",
      [ids.projectId],
    );
    if (project?.mode !== step.input.phaseResolutionMode)
      await ipc(ctx, "project_patch", {
        payload: {
          ...(await writeContext(ctx)),
          projectId: ids.projectId,
          baseUpdatedAt: project?.updatedAt,
          updatedAt: ctx.now(),
          patch: { phaseResolutionMode: step.input.phaseResolutionMode },
        },
      });
    return { projectId: ids.projectId, modeBefore: project?.mode ?? null };
  },
  async scenes({ ctx, step }) {
    const { ids } = ctx;
    const rows = step.input.rows;
    const keys = generateNKeysBetween(null, null, rows.length);
    for (const [index, scene] of rows.entries()) {
      // A Scene with a qualifiedIr row sits at `a0` inside its own folder,
      // the folder at the Scene's reading position (the 24-case setup's type).
      let parentId = null;
      let sortOrder = keys[index];
      if (scene.folder) {
        parentId = ctx.uuid();
        ids.folders[scene.folder.logicalId] = parentId;
        await ipc(ctx, "tree_node_create", {
          payload: {
            ...(await writeContext(ctx)),
            id: parentId,
            projectId: ids.projectId,
            parentId: null,
            nodeType: "folder",
            status: "draft",
            title: scene.folder.title,
            sortOrder: keys[index],
            content: null,
            canonicalPayload: {
              parentId: null,
              sortOrder: keys[index],
              title: scene.folder.title,
            },
          },
        });
        sortOrder = "a0";
      }
      const id = ctx.uuid();
      ids.scenes[scene.logicalId] = id;
      await ipc(ctx, "tree_node_create", {
        payload: {
          ...(await writeContext(ctx)),
          id,
          projectId: ids.projectId,
          parentId,
          nodeType: "scene",
          status: "draft",
          title: scene.title,
          sortOrder,
          content: doc(scene.body),
          canonicalPayload: { parentId, sortOrder, title: scene.title },
        },
      });
    }
    await pageCall(ctx, "selectProject", {
      projectId: ids.projectId,
      activeSceneId: runtimeOf(
        ids.scenes,
        ctx.plan.querySceneId,
        "the query Scene",
      ),
    });
    for (const scene of rows) {
      const text = await pageCall(
        ctx,
        "api.sceneText",
        ids.scenes[scene.logicalId],
      );
      if (text !== `${scene.body}\n`)
        throw new Error(`[artifact] Scene ${scene.logicalId} body differs`);
    }
    return {
      count: rows.length,
      folders: Object.keys(ids.folders).length,
      sortOrder: keys,
    };
  },
  async entities({ ctx, step }) {
    for (const entity of step.input.rows) {
      const created = await pageCall(ctx, "api.createCodexEntry", {
        id: ctx.uuid(),
        projectId: ctx.ids.projectId,
        type: entity.type,
        name: entity.name,
        summary: entity.summary,
      });
      ctx.ids.entities[entity.logicalId] = String(created.id);
    }
    return { count: step.input.rows.length };
  },
  async relations({ ctx, step }) {
    for (const relation of step.input.rows) {
      const created = await pageCall(ctx, "api.createCodexRelation", {
        id: ctx.uuid(),
        projectId: ctx.ids.projectId,
        fromCodexId: runtimeOf(
          ctx.ids.entities,
          relation.fromEntityId,
          "Entity",
        ),
        toCodexId: runtimeOf(ctx.ids.entities, relation.toEntityId, "Entity"),
        relationType: relation.relationType,
        label: relation.label,
        directionality: relation.directionality,
      });
      ctx.ids.relations[relation.logicalId] = String(created.id);
    }
    return { count: step.input.rows.length };
  },
  async "scope-registry"({ ctx, step }) {
    const { ids, workspacePath } = ctx;
    const firstScene = ctx.plan.steps.find((row) => row.phase === "scenes")
      .input.rows[0].logicalId;
    const current = await ipc(ctx, "narrative_scene_scope_read", {
      expectedWorkspacePath: workspacePath,
      projectId: ids.projectId,
      sceneId: runtimeOf(ids.scenes, firstScene, "Scene"),
    });
    await ipc(ctx, "narrative_scene_scope_registry_update", {
      expectedWorkspacePath: workspacePath,
      payload: {
        projectId: ids.projectId,
        requestId: ctx.uuid(),
        sessionId: ctx.uuid(),
        eventUid: ctx.uuid(),
        baseVersion: current.registryRevision,
        updatedAt: ctx.now(),
        registry: {
          ...current.registry,
          timelineRefs: [...step.input.registry.timelineRefs],
          worldlineRefs: [...step.input.registry.worldlineRefs],
          narrativeLayerRefs: [...step.input.registry.narrativeLayerRefs],
        },
      },
    });
    return { registry: step.input.registry };
  },
  async "scene-scope"({ ctx, step }) {
    const { ids, workspacePath } = ctx;
    const read = (sceneId) =>
      ipc(ctx, "narrative_scene_scope_read", {
        expectedWorkspacePath: workspacePath,
        projectId: ids.projectId,
        sceneId,
      });
    for (const write of step.input.writes) {
      const sceneId = runtimeOf(ids.scenes, write.sceneId, "Scene");
      const current = await read(sceneId);
      await ipc(ctx, "narrative_scene_scope_update", {
        expectedWorkspacePath: workspacePath,
        payload: {
          projectId: ids.projectId,
          sceneId,
          requestId: ctx.uuid(),
          sessionId: ctx.uuid(),
          eventUid: ctx.uuid(),
          baseVersion: current.binding.version,
          updatedAt: ctx.now(),
          scope: scopePayload(ids, write.scope),
        },
      });
      const after = await read(sceneId);
      if (after.binding.compatibilityMarker !== "explicit")
        throw new Error(
          `[artifact] Scene ${write.sceneId} Scope is not explicit`,
        );
    }
    return { written: step.input.writes.length, skipped: step.input.skipped };
  },
  async foreshadows({ ctx, step }) {
    for (const row of step.input.rows) {
      const created = await pageCall(ctx, "api.createForeshadow", {
        id: ctx.uuid(),
        projectId: ctx.ids.projectId,
        title: row.title,
        secret: row.secret,
        payoffSceneId:
          row.payoffSceneId === null
            ? null
            : runtimeOf(ctx.ids.scenes, row.payoffSceneId, "the payoff Scene"),
        payoffConfirmed: row.payoffConfirmed,
        abandoned: row.abandoned,
      });
      ctx.ids.foreshadows[row.logicalId] = String(created.id);
      ctx.foreshadowVersions[String(created.id)] = Number(created.version);
    }
    return { count: step.input.rows.length };
  },
  async "foreshadow-links"({ ctx, step }) {
    for (const row of step.input.rows) {
      const foreshadowId = runtimeOf(
        ctx.ids.foreshadows,
        row.foreshadowId,
        "foreshadow",
      );
      const linked = await pageCall(ctx, "api.addForeshadowCodexLink", {
        foreshadowId,
        codexId: runtimeOf(ctx.ids.entities, row.entityId, "Entity"),
        baseVersion: ctx.foreshadowVersions[foreshadowId],
      });
      ctx.foreshadowVersions[foreshadowId] = Number(linked.version);
    }
    return { count: step.input.rows.length };
  },
  async pins({ ctx, step }) {
    for (const row of step.input.rows) {
      const pin = {
        sceneId: runtimeOf(ctx.ids.scenes, row.sceneId, "Scene"),
        entryId: runtimeOf(ctx.ids.entities, row.entityId, "Entity"),
      };
      await pageCall(ctx, "api.upsertScenePin", pin);
      ctx.ids.pins.push(pin);
    }
    return { count: step.input.rows.length };
  },
  async [SEED_PIN_PHASE]({ ctx, step }) {
    // SP/1: S1g-A's step (upsertScenePin once, SELECT read-backs before and
    // after). The record is checked once the phases are recorded.
    ctx.seedPinRecord = await runSeedPinStep({
      plan: step.input,
      ids: ctx.ids,
      deps: seedPinPageDeps({
        page: ctx.page,
        projectId: ctx.ids.projectId,
        querySceneId: runtimeOf(
          ctx.ids.scenes,
          step.input.querySceneId,
          "the query Scene",
        ),
      }),
    });
    return {
      querySceneId: ctx.seedPinRecord.querySceneId,
      seed: ctx.seedPinRecord.seed,
    };
  },
  async "maintenance-enabled"({ ctx }) {
    const before = await ipc(ctx, "narrative_runtime_policy_get", {});
    // P-5: a reopened author session finds the setting already on (written
    // by the opening whose wait ran out) and does not write it again.
    const policy =
      before?.maintenanceEnabled === true
        ? before
        : await ipc(ctx, "narrative_runtime_policy_set", {
            payload: {
              expectedVersion: before.version,
              runtimeMode: before.runtimeMode,
              maintenanceEnabled: true,
              genericImportEnabled: before.genericImportEnabled,
              backgroundAiEnabled: before.backgroundAiEnabled,
            },
          });
    ctx.maintenanceSettingWrites =
      (ctx.maintenanceSettingWrites ?? 0) + (policy === before ? 0 : 1);
    if (policy?.maintenanceEnabled !== true)
      throw new Error(
        "[artifact] maintenance is not on after the runtime-policy setting",
      );
    const started = Date.now();
    const limit = ctx.limits?.maintenanceMs ?? MAINTENANCE_WAIT_MS;
    const waitFor = async (sql, params, label) => {
      while (Date.now() - started < limit) {
        const rows = await select(ctx, sql, params);
        if (rows.length > 0) return rows;
        await ctx.sleep(500);
      }
      // P-5: the session loop may reopen the author session from this step.
      const error = new Error(
        `[precheck] S1i maintenance-enabled: blocked:maintenance-enabled — ${label} did not appear within ${limit} ms`,
      );
      error.blocked = {
        harnessId: "maintenance-enabled",
        unmet: ["maintenance-enabled"],
      };
      error.maintenanceTimeout = {
        waitedMs: Date.now() - started,
        missing: label,
        stepIndex: ctx.plan.steps.findIndex(
          (row) => row.executor === "maintenance-enabled",
        ),
      };
      throw error;
    };
    const epochs = await waitFor(
      "SELECT id, epoch_number AS epochNumber, reason FROM narrative_semantic_epochs WHERE project_id = ? ORDER BY epoch_number",
      [ctx.ids.projectId],
      "the project's semantic epoch",
    );
    const marker = await waitFor(
      "SELECT migration_id AS migrationId, contract_version AS contractVersion FROM schema_data_migrations WHERE migration_id LIKE 'narrative-c2-canonical-freshness-%'",
      [],
      "the canonical cutover marker",
    );
    return {
      before,
      after: policy,
      epochs,
      cutoverMarker: marker,
      waitMs: Date.now() - started,
    };
  },
  async "typed-revision"({ ctx, step }) {
    const rows = step.input.rows ?? [step.input];
    ctx.authorityAtFirstRevision ??= await readAuthority(ctx);
    const out = [];
    for (const revision of rows) out.push(await prepareRevision(ctx, revision));
    return { revisions: out };
  },
  async "codex-entry-summary-edit"({ ctx, step }) {
    const id = runtimeOf(ctx.ids.entities, step.input.entityId, "Entity");
    const read = async () =>
      (
        await select(ctx, "SELECT summary FROM codex_entries WHERE id = ?", [
          id,
        ])
      )[0]?.summary ?? null;
    const before = await read();
    if (before !== step.input.from)
      fail(
        "mutation",
        `${step.input.id}: the summary before the edit is not the fixture's from`,
      );
    await pageCall(ctx, "api.updateCodexEntrySummary", {
      projectId: ctx.ids.projectId,
      id,
      summary: step.input.to,
    });
    const after = await read();
    if (after !== step.input.to)
      throw new Error(
        `[artifact] ${step.input.id}: the summary was not written`,
      );
    return { mutation: step.input.id, entityId: id };
  },
  async "b-seal"({ ctx }) {
    const file = path.join(ctx.workspacePath, "grimodex.db");
    const previous = ctx.bGeneration ?? 0;
    const started = Date.now();
    let metadata = null;
    const limit = ctx.limits?.bSealMs ?? B_SEAL_WAIT_MS;
    while (Date.now() - started < limit) {
      metadata = readIndexMetadata(file, ctx.ids.projectId);
      if (
        metadata.b &&
        metadata.b.generation > previous &&
        metadata.b.dirty === false
      )
        break;
      await ctx.sleep(500);
    }
    if (!(metadata?.b?.generation > previous && metadata.b.dirty === false)) {
      // P-0: the session loop may reopen the seam session (bounded).
      const error = new Error(
        `[precheck] S1i b-seal: ${B_SEAL_NOT_PUBLISHED} — no new sealed B generation within ${limit} ms`,
      );
      error.bSealTimeout = { waitedMs: Date.now() - started, metadata };
      throw error;
    }
    ctx.bGeneration = metadata.b.generation;
    ctx.bSealedInSession = true;
    return { waitedMs: Date.now() - started, metadata };
  },
  async "chronicle-index"({ ctx, step }) {
    guardPage(ctx.plan, "buildIndex");
    const index = await ctx.page.evaluate(
      (input) => window.cp4Harness.buildIndex(input),
      {
        sceneId: runtimeOf(
          ctx.ids.scenes,
          ctx.plan.querySceneId,
          "the query Scene",
        ),
        limitMs: 60_000,
      },
    );
    if (!index?.ok)
      fail("chronicle-index", "the Chronicle Index did not become usable");
    // S1j-2: the last query's snapshot is the probe's query side (B4).
    ctx.cBuiltInSession = true;
    ctx.cGeneration =
      readIndexMetadata(
        path.join(ctx.workspacePath, "grimodex.db"),
        ctx.ids.projectId,
      ).chronicle?.generation ?? null;
    ctx.lastIndexProbe = {
      session: ctx.session ?? null,
      phase: step.phase,
      ...(index.probes?.at(-1) ?? {}),
    };
    return {
      durationMs: index.durationMs,
      probes: index.probes?.length ?? null,
      lastProbe: index.probes?.at(-1) ?? null,
      metadata: readIndexMetadata(
        path.join(ctx.workspacePath, "grimodex.db"),
        ctx.ids.projectId,
      ),
    };
  },
  async "measurement-point"({ ctx, step }) {
    // B4: the probe is the read-only Index metadata and, when this session
    // built the Chronicle Index, the last query's initial snapshot.
    const metadata = readIndexMetadata(
      path.join(ctx.workspacePath, "grimodex.db"),
      ctx.ids.projectId,
    );
    const probe = indexStateProbe({
      metadata,
      lastQuery:
        ctx.lastIndexProbe?.session === (ctx.session ?? null)
          ? ctx.lastIndexProbe
          : null,
    });
    const declared = step.input.indexState ?? {
      chronicle: "usable",
      graph: "usable",
    };
    const holding = String(step.input.measurementPoint ?? "").startsWith(
      "while-",
    );
    ctx.measurementProbe = {
      measurementPoint: step.input.measurementPoint,
      declared,
      probe,
      spec: step.input.spec ?? null,
    };
    if (
      probe.graph !== declared.graph ||
      probe.chronicle !== declared.chronicle
    ) {
      const harnessId = holding
        ? "index-state-holding"
        : "measurement-point-mismatch";
      const error = new Error(
        `[precheck] S1i ${holding ? "index-state-holding" : "measurement-point"}: blocked:${harnessId} — ${ctx.plan.variantKey}: the probe shows graph ${probe.graph} and chronicle ${probe.chronicle}, the variant declares graph ${declared.graph} and chronicle ${declared.chronicle}`,
      );
      // Review P2-2: every unmet precondition. A while- variant leaves
      // index-state-holding unmet; otherwise a Graph mismatch leaves the
      // sealed binding unmet, a Chronicle-only mismatch none (Hold).
      error.blocked = {
        harnessId,
        unmet: holding
          ? ["index-state-holding"]
          : probe.graph !== declared.graph
            ? ["b-sealed-binding"]
            : [],
      };
      // S1j-2 P-1 (DR-BSEAM-3): a B the session sealed and then saw go
      // dirty again (the Freshness evaluation after the publish) is rebuilt
      // only by a new seam opening; the session loop may reopen (bounded).
      // The dev check also saw C, built by this session's query, go dirty
      // with B (the same Freshness evaluation); the reopening rebuilds both.
      if (
        declared.graph === "usable" &&
        probe.graph === "unusable" &&
        ctx.bSealedInSession === true &&
        (probe.chronicle === declared.chronicle ||
          (declared.chronicle === "usable" && ctx.cBuiltInSession === true))
      )
        error.bDirtiedAfterSeal = { metadata };
      throw error;
    }
    return ctx.measurementProbe;
  },
  async "qualified-ir"({ ctx, step }) {
    // B1: only the setup-only Main's session answers the fixture's IR.
    if (ctx.session !== "ir")
      fail(
        "qualified-ir",
        `${ctx.plan.variantKey}: the qualified-ir step runs only in the setup-only Main's session`,
      );
    const before = await ipc(ctx, "get_ai_settings", {});
    await ipc(ctx, "save_ai_settings", {
      settings: { ...before, ...SETUP_IR_AI_SETTINGS },
    });
    const after = await ipc(ctx, "get_ai_settings", {});
    const records = [];
    for (const row of step.input.rows)
      records.push(await extractAndApprove(ctx, row));
    return {
      aiSettings: {
        before: aiSettingsView(before),
        after: aiSettingsView(after),
      },
      irs: records,
    };
  },
  async "codex-relation-type-edit"({ ctx, step }) {
    return recreateRelation(ctx, step.input);
  },
  async "ir-approval-withdrawal"({ ctx, step }) {
    return withdrawIrApproval(ctx, step.input);
  },
  async precheck({ step }) {
    throw new Error(precheckOf(step));
  },
});

/** The 24-case setup's AI settings (the HTTP edge is the deterministic provider). */
export const SETUP_IR_AI_SETTINGS = Object.freeze({
  provider: "ollama",
  model: "product-journey-model",
  ollamaEndpoint: "http://127.0.0.1:11434",
});

const aiSettingsView = (settings) => ({
  provider: settings?.provider ?? null,
  model: settings?.model ?? null,
  ollamaEndpoint: settings?.ollamaEndpoint ?? null,
});

/**
 * B4's probe of the index state: an Index is usable when its metadata has a
 * generation and is not dirty, and (for the Chronicle Index, when this
 * session queried) the last query's initial snapshot was usable.
 */
export function indexStateProbe({ metadata, lastQuery = null }) {
  const clean = (row) =>
    Boolean(row && Number(row.generation) > 0 && row.dirty === false);
  const chronicleQueryUsable =
    lastQuery === null ? null : lastQuery.initialSnapshot?.indexUsable === true;
  return {
    graph: clean(metadata?.b) ? "usable" : "unusable",
    chronicle:
      clean(metadata?.chronicle) && chronicleQueryUsable !== false
        ? "usable"
        : "unusable",
    metadata,
    chronicleQuery:
      lastQuery === null
        ? null
        : {
            phase: lastQuery.phase ?? null,
            initialSnapshot: lastQuery.initialSnapshot ?? null,
            completion: lastQuery.completion ?? null,
          },
  };
}

async function reviewBundle(ctx, runId) {
  return ipc(ctx, "narrative_extraction_get_run_review_bundle", {
    payload: { projectId: ctx.ids.projectId, runId },
  });
}

/**
 * B1: one qualifiedIr row through the dialog's route — Analyze on the
 * Scene's own folder, the one initial proposal's child without the secret
 * flag, the card's approval — read back in the review bundle.
 */
async function extractAndApprove(ctx, row) {
  const { ids } = ctx;
  const folderId = runtimeOf(ids.folders, row.folderId, "the IR folder");
  const sceneId = runtimeOf(ids.scenes, row.sceneId, "the IR Scene");
  const extracted = await pageCall(ctx, "chronicle.extract", {
    projectId: ids.projectId,
    folderId,
  });
  if (JSON.stringify(extracted.sceneIds) !== JSON.stringify([sceneId]))
    fail(
      "qualified-ir",
      `${row.sceneId}: the folder's extraction read ${JSON.stringify(extracted.sceneIds)}, not the one Scene`,
    );
  if (extracted.proposals.length !== 1)
    fail(
      "qualified-ir",
      `${row.sceneId}: the extraction made ${extracted.proposals.length} proposals (one normal proposal expected)`,
    );
  const parent = extracted.proposals[0];
  if (
    parent.applicability !== "applicable" ||
    parent.secret !== true ||
    !nonBlankId(parent.revisionId)
  )
    fail(
      "qualified-ir",
      `${row.sceneId}: the initial proposal is not an applicable secret proposal (${JSON.stringify(parent)})`,
    );
  const revised = await pageCall(ctx, "chronicle.revise", {
    proposalId: parent.proposalId,
    secret: false,
  });
  const child = revised.proposals.find(
    (proposal) => proposal.proposalId === parent.proposalId,
  );
  if (
    !child ||
    child.revisionId === parent.revisionId ||
    child.secret !== false
  )
    fail("qualified-ir", `${row.sceneId}: no nonsecret child revision`);
  const decided = await pageCall(ctx, "chronicle.decide", {
    proposalId: parent.proposalId,
    status: "approved",
  });
  if (
    decided.proposals.find((p) => p.proposalId === parent.proposalId)
      ?.status !== "approved"
  )
    fail("qualified-ir", `${row.sceneId}: the card's approval did not land`);
  const bundle = await reviewBundle(ctx, extracted.runId);
  const current = (bundle?.proposals ?? []).find(
    (proposal) => proposal.proposalId === parent.proposalId,
  );
  if (
    current?.currentRevisionId !== child.revisionId ||
    current?.latestDecision?.decision !== "approved"
  )
    fail(
      "qualified-ir",
      `${row.sceneId}: the review bundle does not show the approved child`,
    );
  const record = {
    sceneId: row.sceneId,
    folderId,
    runId: String(extracted.runId),
    proposalId: String(parent.proposalId),
    rootRevisionId: String(parent.revisionId),
    childRevisionId: String(child.revisionId),
    decision: "approved",
    decisionId:
      typeof current.latestDecision?.decisionId === "string"
        ? current.latestDecision.decisionId
        : null,
  };
  ids.chronicle ??= {};
  ids.chronicle[row.sceneId] = record;
  return record;
}

/** The typed Revisions of a logical Relation and their current status. */
async function revisionStatuses(ctx, relationId) {
  const out = {};
  for (const [id, record] of Object.entries(ctx.ids.typedRevisions ?? {})) {
    if (!(record.relationIds ?? []).includes(relationId) || !record.runId)
      continue;
    const current = await ipc(
      ctx,
      "nir1_entity_relation_revision_read_current",
      {
        expectedWorkspacePath: ctx.workspacePath,
        projectId: ctx.ids.projectId,
        runId: record.runId,
      },
    );
    out[id] = current?.status ?? null;
  }
  return out;
}

/**
 * B2 (B'): relation.delete, then relation.create of the declared type under
 * the same runtime ID; (B'') a new runtime ID when the product refuses the
 * reuse. The mode, both IDs and the refusal are recorded.
 */
async function recreateRelation(ctx, input) {
  const { ids } = ctx;
  const previous = runtimeOf(ids.relations, input.relationId, "Relation");
  const readRow = async (id) =>
    (
      await select(
        ctx,
        `SELECT id, from_codex_id AS fromCodexId, to_codex_id AS toCodexId,
                relation_type AS relationType, label, directionality, version,
                updated_at AS updatedAt
           FROM codex_relations WHERE id = ?`,
        [id],
      )
    )[0] ?? null;
  const before = await readRow(previous);
  if (before?.relationType !== input.from)
    fail(
      "mutation",
      `${input.id}: the Relation before the edit is not of type ${input.from}`,
    );
  const revisionsBefore = await revisionStatuses(ctx, input.relationId);
  await pageCall(ctx, "api.deleteCodexRelation", { id: previous });
  if ((await readRow(previous)) !== null)
    throw new Error(`[artifact] ${input.id}: the Relation was not deleted`);
  const create = (id) =>
    pageAttempt(ctx, "api.createCodexRelation", {
      id,
      projectId: ids.projectId,
      fromCodexId: before.fromCodexId,
      toCodexId: before.toCodexId,
      relationType: input.to,
      label: input.label,
      directionality: before.directionality,
    });
  let mode = "same-id";
  let sameIdError = null;
  let created = await create(previous);
  if (!created?.ok) {
    sameIdError = String(created?.error ?? "").slice(0, 400);
    // Review P2-4: (B'') only when the product refuses the reuse of the ID;
    // any other failure stops the setup.
    if (!RELATION_ID_REUSE_REFUSAL.test(sameIdError))
      fail(
        "mutation",
        `${input.id}: relation.create with the same ID failed for another reason than an ID reuse refusal: ${sameIdError}`,
      );
    mode = "new-id";
    created = await create(ctx.uuid());
    if (!created?.ok)
      throw new Error(
        `${input.id}: relation.create failed after the delete: ${created?.error}`,
      );
  }
  const runtimeId = String(created.value.id);
  if ((mode === "same-id") !== (runtimeId === previous))
    fail(
      "mutation",
      `${input.id}: the ${mode} mode created ${runtimeId} (previous ${previous})`,
    );
  ids.relations[input.relationId] = runtimeId;
  const after = await readRow(runtimeId);
  if (after?.relationType !== input.to || after.label !== input.label)
    throw new Error(
      `[artifact] ${input.id}: the new Relation is not ${input.to}`,
    );
  const record = {
    mutation: input.id,
    mode,
    previousRuntimeId: previous,
    runtimeId,
    sameIdError,
    before,
    after,
    revisionsBefore,
    revisionsAfter: await revisionStatuses(ctx, input.relationId),
  };
  // Review P2-3: every approved Revision bound to the Relation was current
  // before the edit and is stale (unavailable) after it.
  const approved = Object.entries(ids.typedRevisions ?? {})
    .filter(
      ([, row]) =>
        row.decision === "approved" &&
        (row.relationIds ?? []).includes(input.relationId),
    )
    .map(([id]) => id);
  if (
    approved.length === 0 ||
    approved.some(
      (id) =>
        record.revisionsBefore[id] !== "available" ||
        record.revisionsAfter[id] !== "unavailable",
    )
  )
    fail(
      "mutation",
      `${input.id}: the approved Revisions of ${input.relationId} are not available → unavailable (${JSON.stringify({ before: record.revisionsBefore, after: record.revisionsAfter })})`,
    );
  ids.relationRecreations ??= {};
  ids.relationRecreations[input.relationId] = record;
  return record;
}

/**
 * B3: the withdrawal of an approved IR — the Decision writer the card's
 * "defer" button calls, on the run, proposal and current child revision the
 * qualified-ir step recorded.
 */
async function withdrawIrApproval(ctx, input) {
  const { ids } = ctx;
  const record = ids.chronicle?.[input.sceneId];
  if (!record)
    fail(
      "logical-runtime",
      `${input.id}: no qualified-ir record of ${input.sceneId}`,
    );
  const read = async () =>
    ((await reviewBundle(ctx, record.runId))?.proposals ?? []).find(
      (proposal) => proposal.proposalId === record.proposalId,
    ) ?? null;
  const before = await read();
  if (
    before?.currentRevisionId !== record.childRevisionId ||
    before?.latestDecision?.decision !== "approved"
  )
    fail(
      "ir-approval-withdrawal",
      `${input.id}: the IR of ${input.sceneId} is not the approved child the qualified-ir step recorded`,
    );
  await pageCall(ctx, "chronicle.recordDecision", {
    runId: record.runId,
    projectId: ids.projectId,
    proposalId: record.proposalId,
    revisionId: record.childRevisionId,
    decision: input.decision,
  });
  const after = await read();
  if (after?.latestDecision?.decision !== input.decision)
    throw new Error(
      `[artifact] ${input.id}: the ${input.decision} Decision did not land`,
    );
  const decision = {
    mutation: input.id,
    sceneId: input.sceneId,
    runId: record.runId,
    proposalId: record.proposalId,
    revisionId: record.childRevisionId,
    decision: input.decision,
    decisionId:
      typeof after.latestDecision?.decisionId === "string"
        ? after.latestDecision.decisionId
        : null,
  };
  ids.decisions ??= {};
  ids.decisions[input.id] = decision;
  return decision;
}

/**
 * Review P2-1: B and C read (read-only) just before the first mutation of
 * the hold session: both clean, at the generations the seal session left.
 */
export function assertSealedBeforeMutation(ctx, read = readIndexMetadata) {
  const metadata = read(
    path.join(ctx.workspacePath, "grimodex.db"),
    ctx.ids.projectId,
  );
  const state = {
    metadata,
    expected: {
      b: ctx.bGeneration ?? null,
      chronicle: ctx.cGeneration ?? null,
    },
  };
  const at = (row, generation) =>
    Boolean(
      row &&
      row.dirty === false &&
      generation !== null &&
      Number(row.generation) === generation,
    );
  if (
    !at(metadata?.b, state.expected.b) ||
    !at(metadata?.chronicle, state.expected.chronicle)
  )
    failBlocked(
      "maintenance-enabled",
      "pre-mutation-index-state",
      ["maintenance-enabled"],
      `${ctx.plan.variantKey}: before the first mutation B is ${JSON.stringify(metadata?.b ?? null)} and C is ${JSON.stringify(metadata?.chronicle ?? null)}, not the sealed generations ${JSON.stringify(state.expected)} clean`,
    );
  return state;
}

/** One typed Revision: prepare against its review Scene, then the declared decision. */
async function prepareRevision(ctx, revision) {
  const { ids, workspacePath } = ctx;
  const binding = await ipc(
    ctx,
    "narrative_extraction_capture_workspace_binding",
    {
      expectedWorkspacePath: workspacePath,
    },
  );
  const started = Date.now();
  const refusals = [];
  let prepared = null;
  while (!prepared) {
    const attempt = await ipcAttempt(
      ctx,
      "nir1_entity_relation_revision_prepare",
      {
        payload: {
          projectId: ids.projectId,
          sceneId: runtimeOf(
            ids.scenes,
            revision.reviewSceneId,
            "the review Scene",
          ),
          entityIds: revision.entityIds.map((id) =>
            runtimeOf(ids.entities, id, "Entity"),
          ),
          relationIds: revision.relationIds.map((id) =>
            runtimeOf(ids.relations, id, "Relation"),
          ),
        },
        workspaceBinding: binding,
      },
    );
    if (attempt?.ok) prepared = attempt.value;
    else if (
      /canonical-freshness-unavailable/u.test(attempt?.error ?? "") &&
      Date.now() - started < PREPARE_WAIT_MS
    ) {
      refusals.push({
        atMs: Date.now() - started,
        error: String(attempt.error).slice(0, 200),
      });
      await ctx.sleep(500);
    } else {
      // README / setupRefusal: a refused material is recorded, never retried.
      ctx.refusedAtSetup.push({
        revisionId: revision.id,
        stage: "prepare",
        error: String(attempt?.error ?? "").slice(0, 400),
      });
      return { id: revision.id, refusedAtSetup: "prepare" };
    }
  }
  const record = {
    id: revision.id,
    reviewSceneId: revision.reviewSceneId,
    relationIds: [...revision.relationIds],
    decision: revision.decision,
    prepareWaitMs: Date.now() - started,
    prepareRefusals: refusals.length,
    runId: String(prepared.runId),
    proposalId: String(prepared.receipt?.proposalId),
    revisionId: String(prepared.receipt?.revisionId),
  };
  if (revision.decision !== "none") {
    const decided = await ipcAttempt(
      ctx,
      "narrative_extraction_append_human_decision",
      {
        payload: {
          runId: prepared.runId,
          projectId: ids.projectId,
          proposalId: prepared.receipt.proposalId,
          revisionId: prepared.receipt.revisionId,
          decision: revision.decision,
          createdBy: "nir1-entity-relation-review",
        },
      },
    );
    if (!decided?.ok) {
      ctx.refusedAtSetup.push({
        revisionId: revision.id,
        stage: "decision",
        error: String(decided?.error ?? "").slice(0, 400),
      });
      record.refusedAtSetup = "decision";
    }
  }
  const current = await ipc(ctx, "nir1_entity_relation_revision_read_current", {
    expectedWorkspacePath: workspacePath,
    projectId: ids.projectId,
    runId: prepared.runId,
  });
  record.statusAfter = current?.status ?? null;
  ids.typedRevisions[revision.id] = record;
  return record;
}

/**
 * Runs the plan's steps of one session in order, through `plan.stopIndex`,
 * recording each phase with the state before and after it. `executors` and
 * `readState` replace the page-backed ones (tests).
 */
export async function runFrozenSetupSteps({
  plan,
  page,
  workspacePath,
  ids,
  session = "author",
  phase,
  ctx: carried = {},
  uuid = randomUUID,
  sleep = delay,
  now = () => new Date().toISOString(),
  executors = EXECUTORS,
  readState = readPhaseState,
}) {
  const ctx = Object.assign(carried, {
    plan,
    page,
    workspacePath,
    ids,
    uuid,
    sleep,
    now,
  });
  ctx.foreshadowVersions ??= {};
  ctx.refusedAtSetup ??= [];
  ctx.workspaceOpen ??= false;
  ctx.session = session;
  ctx.sessionStepsDone = 0;
  ctx.bSealedInSession = false;
  ctx.cBuiltInSession = false;
  // ① has the author session only (no B-ROUTE seam, no seal session).
  if (partialRun(plan) && session !== "author")
    fail(
      "r5-check",
      `${plan.variantKey}: the ${session} session does not run in ${R5_CHECK_RUN}`,
    );
  // S1j-2: every later session reopens the workspace (the seal sessions'
  // workspace-opened wake runs the gated B build).
  // P-5: a reopened author session resumes at its maintenance step (the
  // project and the materials before it are in the workspace already).
  const resumeFrom = session === "author" ? (ctx.resumeAuthorFrom ?? 0) : 0;
  if (session !== "author" || resumeFrom > 0) {
    await pageCall(ctx, "openWorkspace", {
      workspacePath,
      projectId: ids.projectId,
      activeSceneId: runtimeOf(
        ids.scenes,
        plan.querySceneId,
        "the query Scene",
      ),
    });
    ctx.workspaceOpen = true;
  }
  for (const [at, step] of plan.steps.entries()) {
    if (at > plan.stopIndex) break;
    if (step.session !== session) continue;
    if (at < resumeFrom) continue;
    // ①: a step of S2's forbidden set never starts, whatever the stop index.
    const forbidden = partialRun(plan)
      ? phaseCategories(step.phase, {
          timelineKind: step.timelineKind ?? null,
        }).filter((category) => R5_CHECK_FORBIDS.includes(category))
      : [];
    if (forbidden.length > 0)
      fail(
        "r5-check",
        `${plan.variantKey}: ${step.phase} (${forbidden.join(", ")}) does not run in ${R5_CHECK_RUN}`,
      );
    const executor =
      step.executor === "precheck"
        ? EXECUTORS.precheck
        : (executors[step.executor] ?? EXECUTORS[step.executor]);
    if (!executor)
      fail("phase", `${plan.variantKey}: no executor for ${step.phase}`);
    // Review P2-1 (precondition maintenance-enabled): before the first
    // mutation of the hold session, B and C are the sealed generations,
    // clean.
    if (
      session === "hold" &&
      step.timelineKind === "mutation" &&
      !ctx.preMutationIndexState
    )
      ctx.preMutationIndexState = assertSealedBeforeMutation(ctx);
    const stateBefore = ctx.workspaceOpen ? await readState(ctx) : null;
    const details = await executor({ ctx, step });
    const stateAfter = await readState(ctx);
    phase(step.phase, { session, details, stateBefore, stateAfter });
    ctx.sessionStepsDone += 1;
  }
  if (
    session === plan.steps.at(-1).session &&
    plan.stopIndex === plan.steps.length - 1 &&
    ctx.authorityAtFirstRevision
  ) {
    // setupOrder: no tree order, registry or Scene Scope change after the
    // first typed Revision (compared on their meaning, not on tokens).
    const after = await readAuthority(ctx);
    if (JSON.stringify(after) !== JSON.stringify(ctx.authorityAtFirstRevision))
      fail(
        "freeze-after-first-revision",
        `${plan.variantKey}: tree order, registry or Scene Scope changed after the first typed Revision`,
      );
    ctx.authorityUnchanged = true;
  }
  return ctx;
}

const sameJson = (left, right) => {
  const canonical = (value) =>
    value !== null && typeof value === "object"
      ? Array.isArray(value)
        ? value.map(canonical)
        : Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
      : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
};

/**
 * The cold DB's rows against the plan through the setup's logical → runtime
 * map (no mix-up): every material the plan wrote is the row of its runtime
 * ID with the fixture's values, the map is one to one, no other row exists,
 * and the pins are the fixture's plus the one seed pin. `[precheck]` on any
 * difference.
 */
/**
 * S1j-2: the values the executed mutations leave (the summary edits, the
 * G-02 type edit); the read-back compares the cold DB with these.
 */
function mutatedExpectations(plan) {
  const summaries = new Map();
  const relations = new Map();
  for (const step of plan.steps.slice(0, plan.stopIndex + 1)) {
    if (step.executor === "codex-entry-summary-edit")
      summaries.set(step.input.entityId, step.input.to);
    if (step.executor === "codex-relation-type-edit")
      relations.set(step.input.relationId, {
        relationType: step.input.to,
        label: step.input.label,
      });
  }
  return { summaries, relations };
}

export function assertLogicalRuntimeMap({ plan, ids, rows }) {
  const problems = [];
  const mutated = mutatedExpectations(plan);
  const input = (phase) =>
    plan.steps.find((step) => step.phase === phase)?.input;
  const oneToOne = (label, map, expected) => {
    const keys = Object.keys(map ?? {});
    const values = Object.values(map ?? {});
    if (new Set(values).size !== values.length)
      problems.push(`${label}: two logical IDs share a runtime ID`);
    const want = [...expected].sort();
    if (JSON.stringify([...keys].sort()) !== JSON.stringify(want))
      problems.push(`${label}: the map does not name exactly the plan's IDs`);
  };
  if (!rows?.projects?.includes(ids.projectId))
    problems.push("project: missing");
  const scenes = input("scenes").rows;
  oneToOne(
    "scenes",
    ids.scenes,
    scenes.map((row) => row.logicalId),
  );
  const byId = (list) =>
    new Map((list ?? []).map((row) => [String(row.id), row]));
  const folders = scenes.filter((row) => row.folder);
  oneToOne(
    "folders",
    ids.folders,
    folders.map((row) => row.folder.logicalId),
  );
  if (
    Object.values(ids.folders).some((id) =>
      Object.values(ids.scenes).includes(id),
    )
  )
    problems.push("folders: a folder shares a runtime ID with a Scene");
  const sceneRows = byId(rows?.scenes);
  if ((rows?.scenes ?? []).length !== scenes.length + folders.length)
    problems.push("scenes: the project holds another number of nodes");
  for (const scene of scenes) {
    const row = sceneRows.get(ids.scenes[scene.logicalId]);
    const parent = scene.folder ? ids.folders[scene.folder.logicalId] : null;
    if (
      !row ||
      row.title !== scene.title ||
      row.nodeType !== "scene" ||
      row.archivedAt !== null ||
      row.parentId !== (parent ?? null) ||
      (scene.folder && row.sortOrder !== "a0") ||
      // K2/4 :411: no story time and no POV (S1 C14 (d)).
      row.storyTimeOrder !== null ||
      row.povCharacterId !== null
    )
      problems.push(`scenes: ${scene.logicalId}`);
    if (scene.folder) {
      const folder = sceneRows.get(parent);
      if (
        !folder ||
        folder.nodeType !== "folder" ||
        folder.title !== scene.folder.title ||
        folder.parentId !== null ||
        folder.archivedAt !== null
      )
        problems.push(`folders: ${scene.folder.logicalId}`);
    }
  }
  // The reading order: the tree walked depth first in sort order.
  const children = (parentId) =>
    (rows?.scenes ?? [])
      .filter((row) => (row.parentId ?? null) === parentId)
      .sort((a, b) =>
        a.sortOrder < b.sortOrder
          ? -1
          : a.sortOrder > b.sortOrder
            ? 1
            : String(a.id) < String(b.id)
              ? -1
              : 1,
      );
  const walk = (parentId, out = [], depth = 0) => {
    if (depth > 8) return out;
    for (const row of children(parentId)) {
      if (row.nodeType === "scene") out.push(String(row.id));
      walk(String(row.id), out, depth + 1);
    }
    return out;
  };
  if (
    JSON.stringify(walk(null)) !==
    JSON.stringify(scenes.map((row) => ids.scenes[row.logicalId]))
  )
    problems.push("scenes: the tree order is not the reading order");
  const entities = input("entities").rows;
  oneToOne(
    "entities",
    ids.entities,
    entities.map((row) => row.logicalId),
  );
  const entryRows = byId(rows?.codexEntries);
  if ((rows?.codexEntries ?? []).length !== entities.length)
    problems.push(
      "entities: the project holds another number of Codex entries",
    );
  for (const entity of entities) {
    const row = entryRows.get(ids.entities[entity.logicalId]);
    if (
      !row ||
      row.type !== entity.type ||
      row.name !== entity.name ||
      (row.summary ?? "") !==
        (mutated.summaries.get(entity.logicalId) ?? entity.summary)
    )
      problems.push(`entities: ${entity.logicalId}`);
  }
  const relations = input("relations").rows;
  oneToOne(
    "relations",
    ids.relations,
    relations.map((row) => row.logicalId),
  );
  const relationRows = byId(rows?.codexRelations);
  if ((rows?.codexRelations ?? []).length !== relations.length)
    problems.push("relations: the project holds another number of Relations");
  for (const relation of relations) {
    const row = relationRows.get(ids.relations[relation.logicalId]);
    const want = mutated.relations.get(relation.logicalId) ?? relation;
    if (
      !row ||
      row.fromCodexId !== ids.entities[relation.fromEntityId] ||
      row.toCodexId !== ids.entities[relation.toEntityId] ||
      row.relationType !== want.relationType ||
      row.label !== want.label ||
      row.directionality !== relation.directionality
    )
      problems.push(`relations: ${relation.logicalId}`);
  }
  const foreshadows = input("foreshadows")?.rows ?? [];
  oneToOne(
    "foreshadows",
    ids.foreshadows,
    foreshadows.map((row) => row.logicalId),
  );
  const foreshadowRows = byId(rows?.foreshadows);
  if ((rows?.foreshadows ?? []).length !== foreshadows.length)
    problems.push(
      "foreshadows: the project holds another number of foreshadows",
    );
  for (const foreshadow of foreshadows) {
    const row = foreshadowRows.get(ids.foreshadows[foreshadow.logicalId]);
    const payoff =
      foreshadow.payoffSceneId === null
        ? null
        : ids.scenes[foreshadow.payoffSceneId];
    if (
      !row ||
      row.title !== foreshadow.title ||
      row.secret !== foreshadow.secret ||
      row.payoffSceneId !== payoff ||
      row.payoffConfirmed !== foreshadow.payoffConfirmed ||
      row.abandoned !== foreshadow.abandoned
    )
      problems.push(`foreshadows: ${foreshadow.logicalId}`);
  }
  const key = (row) => `${row.sceneId ?? row.foreshadowId}\u0000${row.entryId}`;
  const links = (input("foreshadow-links")?.rows ?? []).map((row) =>
    key({
      foreshadowId: ids.foreshadows[row.foreshadowId],
      entryId: ids.entities[row.entityId],
    }),
  );
  if (
    JSON.stringify([...links].sort()) !==
    JSON.stringify((rows?.foreshadowLinks ?? []).map(key).sort())
  )
    problems.push("foreshadow-links: the links are not the plan's");
  const seed = plan.steps.find((step) => step.phase === SEED_PIN_PHASE).input;
  const pins = [
    ...frozenSetupFixturePins(plan, ids),
    {
      sceneId: ids.scenes[seed.querySceneId],
      entryId: ids.entities[seed.seedEntityId],
    },
  ].map(key);
  if (
    JSON.stringify([...pins].sort()) !==
    JSON.stringify((rows?.pins ?? []).map(key).sort())
  )
    problems.push("pins: the pins are not the fixture's plus the one seed pin");
  const registry = input("scope-registry").registry;
  if (!sameJson(rows?.registry, registry))
    problems.push("scope-registry: the refs are not the plan's");
  const scope = input("scene-scope");
  const bindings = new Map(
    (rows?.bindings ?? []).map((row) => [row.sceneId, row]),
  );
  for (const write of scope.writes) {
    const row = bindings.get(ids.scenes[write.sceneId]);
    // An unmapped holder is a mix-up too (reported below, not thrown).
    const want = (() => {
      try {
        return scopePayload(ids, write.scope);
      } catch {
        return null;
      }
    })();
    if (
      !row ||
      !want ||
      row.marker !== "explicit" ||
      !sameJson(row.queryIdentity, want.queryIdentity) ||
      !sameJson(row.materialConstraint, want.materialConstraint) ||
      !sameJson(row.knowledgeHolder, want.knowledgeHolder) ||
      !sameJson(row.audience, want.audience)
    )
      problems.push(`scene-scope: ${write.sceneId}`);
  }
  for (const skipped of scope.skipped) {
    const row = bindings.get(ids.scenes[skipped.sceneId]);
    if (!row || row.marker !== skipped.marker)
      problems.push(`scene-scope: ${skipped.sceneId} is not ${skipped.marker}`);
  }
  if (problems.length > 0)
    fail("logical-runtime", `${plan.variantKey}: ${problems.join("; ")}`);
  return {
    ok: true,
    scenes: scenes.length,
    folders: folders.length,
    entities: entities.length,
    relations: relations.length,
    foreshadows: foreshadows.length,
    pins: pins.length,
    explicitSceneScopes: scope.writes.length,
    unwrittenSceneScopes: scope.skipped.length,
  };
}

/**
 * S1j-2: the qualified-ir step's read-back on the cold DB. Every qualifiedIr
 * row has its own run with one proposal whose current revision is the
 * recorded nonsecret child of the recorded secret root; the root's envelope
 * carries the fixture's seed for the runtime Scene and a context set of one
 * cluster and one observation (no optional story input); the child's last
 * Decision is approved, or deferred when the plan withdrew it (B3). No other
 * Chronicle run exists. `[precheck]` on any difference.
 */
export function assertChronicleSetup({ plan, ids, rows }) {
  const executed = plan.steps.slice(0, plan.stopIndex + 1);
  const irRows = executed
    .filter((step) => step.executor === "qualified-ir")
    .flatMap((step) => step.input.rows);
  const withdrawn = new Map(
    executed
      .filter((step) => step.executor === "ir-approval-withdrawal")
      .map((step) => [step.input.sceneId, step.input]),
  );
  const problems = [];
  const chronicle = ids.chronicle ?? {};
  if (
    JSON.stringify(Object.keys(chronicle).sort()) !==
    JSON.stringify(irRows.map((row) => row.sceneId).sort())
  )
    problems.push(
      "chronicle: the map does not name exactly the plan's IR Scenes",
    );
  const runIds = Object.values(chronicle).map((row) => row.runId);
  if (new Set(runIds).size !== runIds.length)
    problems.push("chronicle: two IR rows share a run");
  if ((rows ?? []).length !== irRows.length)
    problems.push(
      `chronicle: the project holds ${(rows ?? []).length} Chronicle runs, not ${irRows.length}`,
    );
  for (const row of irRows) {
    const record = chronicle[row.sceneId];
    const run = (rows ?? []).find((entry) => entry.runId === record?.runId);
    const proposal = run?.proposals?.[0];
    if (!record || !run || run.proposals.length !== 1 || !proposal) {
      problems.push(`chronicle: ${row.sceneId} has no run with one proposal`);
      continue;
    }
    const revision = (id) =>
      proposal.revisions.find((entry) => entry.revisionId === id) ?? null;
    const root = revision(record.rootRevisionId);
    const child = revision(record.childRevisionId);
    const contexts = root?.envelope?.revisionBasis?.contextSet;
    const assertion = root?.envelope?.assertion;
    const seedOk = [
      "summary",
      "actuality",
      "attribution",
      "narrativeFrame",
    ].every((key) => assertion?.payload?.[key] === row[key]);
    const decisions = proposal.decisions.filter(
      (entry) => entry.revisionId === record.childRevisionId,
    );
    const want = withdrawn.get(row.sceneId)?.decision ?? "approved";
    if (
      proposal.proposalId !== record.proposalId ||
      proposal.currentRevisionId !== record.childRevisionId ||
      !root ||
      !child ||
      root.payload?.disclosure?.secret !== true ||
      child.payload?.disclosure?.secret !== false
    )
      problems.push(`chronicle: ${row.sceneId} is not the recorded child`);
    if (
      !Array.isArray(contexts) ||
      contexts.length !== 2 ||
      contexts.filter((entry) =>
        String(entry?.contextId).startsWith("event-observation:"),
      ).length !== 1 ||
      contexts.filter((entry) =>
        String(entry?.contextId).startsWith("event-cluster:"),
      ).length !== 1
    )
      problems.push(
        `chronicle: ${row.sceneId}'s context set is not one cluster and one observation (an optional story input?)`,
      );
    if (
      assertion?.scope?.scene?.ref !== `scene:${ids.scenes[row.sceneId]}` ||
      !seedOk
    )
      problems.push(
        `chronicle: ${row.sceneId}'s envelope is not the fixture's seed for its runtime Scene`,
      );
    if (
      !decisions.some((entry) => entry.decision === "approved") ||
      decisions.at(-1)?.decision !== want
    )
      problems.push(`chronicle: ${row.sceneId}'s last Decision is not ${want}`);
  }
  if (problems.length > 0)
    fail("logical-runtime", `${plan.variantKey}: ${problems.join("; ")}`);
  return {
    ok: true,
    irs: irRows.length,
    withdrawn: [...withdrawn.keys()],
  };
}

/**
 * Review P2-3 (cold DB): for each recreated Relation, every approved typed
 * Revision bound to it keeps the Source token of the Relation as it was
 * (`codex-relation:<previous ID>`), and the cold DB's current token of that
 * key differs (same ID: a new `updated_at`; new ID: the row is gone).
 */
export function assertRelationStaleOnCold({
  cold,
  ids,
  read = readRelationSourceTokens,
}) {
  const out = {};
  for (const [logical, record] of Object.entries(
    ids.relationRecreations ?? {},
  )) {
    for (const [revision, row] of Object.entries(ids.typedRevisions ?? {})) {
      if (
        row.decision !== "approved" ||
        !(row.relationIds ?? []).includes(logical)
      )
        continue;
      const tokens = read(cold, row.revisionId, record.previousRuntimeId);
      if (
        typeof tokens.stored !== "string" ||
        tokens.stored.length === 0 ||
        tokens.stored === tokens.current
      )
        fail(
          "mutation",
          `${record.mutation}: the cold DB does not show ${revision} stale against ${logical} (${JSON.stringify(tokens)})`,
        );
      out[revision] = { relation: logical, ...tokens };
    }
  }
  return out;
}

function relativeToRoot(root, file) {
  const relative = path.relative(root, file);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? file
    : relative;
}

/**
 * One variant's setup in its own fresh workspace: the author session (and,
 * for a complete setup, the seal session on the B-ROUTE seam), the cold DB
 * copy, the read-back checks and the receipt. Returns the receipt and its
 * path; the receipt is written whatever happens (`status` says how it ended).
 */
export async function setupFrozenVariant({
  plan,
  setupDir,
  shared,
  deps = {},
}) {
  const {
    startSession: start = startSession,
    uuid = randomUUID,
    now = () => new Date().toISOString(),
    sleep = delay,
    limits = null,
  } = deps;
  const root = shared.root ?? ROOT;
  const workspacePath = path.join(setupDir, "workspace");
  const receiptPath = path.join(setupDir, "setup-receipt.json");
  // S1j P2-4: a seed-pin setup belongs to one R5 check run; a complete
  // setup (④⑤) never does.
  if (partialRun(plan) && !nonBlankId(shared.r5CheckRunId))
    fail(
      "r5-check",
      `${plan.variantKey}: a seed-pin setup needs the R5 check run ID`,
    );
  if (!partialRun(plan) && shared.r5CheckRunId !== undefined)
    fail(
      "setup",
      `${plan.variantKey}: a complete setup carries no R5 check run ID`,
    );
  // manifest isolation: every variant in its own fresh workspace.
  if (existsSync(setupDir))
    fail(
      "isolation",
      `${plan.variantKey}: ${setupDir} already exists; a variant's setup starts in a fresh directory`,
    );
  await mkdir(setupDir, { recursive: true });
  const ids = createSetupIds({ plan, uuid });
  const receipt = {
    schemaVersion: FROZEN_SETUP_RECEIPT_SCHEMA,
    status: "failed",
    stopsAt: plan.stopsAt,
    run: plan.run,
    ...(partialRun(plan) ? { r5CheckRun: { id: shared.r5CheckRunId } } : {}),
    fixture: {
      kind: plan.fixtureKind ?? "frozen",
      caseId: plan.caseId,
      variantId: plan.variantId,
      path: plan.fixturePath,
      sha256: plan.fixtureSha256,
      fixtureId: plan.fixtureId,
    },
    contracts: { sp1: { ...SP1_CONTRACT } },
    candidate: shared.candidate ?? null,
    launch: shared.launch ?? null,
    plan: {
      schema: plan.schema,
      phases: plannedPhaseNames(plan),
      executed: executedPhaseNames(plan),
      correspondence: plan.correspondence,
      skippedTimelineSteps: plan.skippedTimelineSteps,
      harnessChoices: plan.harnessChoices,
      declaration: plan.declaration,
      runnerSteps: plan.runnerSteps.map((row) => row.phase),
      ...(partialRun(plan)
        ? {}
        : { sessions: plan.sessions, measurementSpec: plan.measurementSpec }),
    },
    startedAt: now(),
    phases: [],
    sessions: [],
    errors: [],
    precheck: null,
  };
  const phase = (name, details = {}) =>
    receipt.phases.push({ name, at: now(), ...details });
  const save = () =>
    writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const ctx = limits ? { limits } : {};
  const session = async (
    label,
    extraEnv = {},
    setupMain = null,
    dirLabel = label,
  ) => {
    const handle = await start({
      runDir: setupDir,
      label: dirLabel,
      server: shared.server,
      observer: shared.observer,
      nativePath: shared.nativePath,
      d2aMode: "unrestricted",
      models: shared.models,
      tmpRoot: shared.tmpRoot ?? null,
      admission: shared.admission ?? null,
      ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
      ...(setupMain ? { setupMain } : {}),
    });
    try {
      if (handle.evidence?.problems?.length > 0)
        throw new Error(handle.evidence.problems.join("; "));
      await runFrozenSetupSteps({
        plan,
        page: handle.page,
        workspacePath,
        ids,
        session: label,
        phase,
        ctx,
        uuid,
        sleep,
        now,
      });
    } finally {
      receipt.sessions.push(await handle.stop());
      await save();
    }
  };
  try {
    // S1j-2: the plan's sessions in order (① reaches the author session only).
    const executed = plan.steps.slice(0, plan.stopIndex + 1);
    const sessions = (plan.sessions ?? [{ label: "author", seam: false }])
      .filter((row) => executed.some((step) => step.session === row.label))
      .filter((row) => !partialRun(plan) || row.label === "author");
    for (const row of sessions) {
      if (row.main === "setup-ir" && !shared.setupMain)
        fail(
          "setup-main",
          `${plan.variantKey}: the ${row.label} session needs the setup-only Main's admission`,
        );
      // P-0: a seam session whose first step (the B seal) saw no new sealed
      // generation is closed and reopened, at most B_SEAL_REOPENS times.
      for (let attempt = 0; ; attempt++) {
        const nonce = row.seam ? randomUUID() : null;
        const dirLabel =
          attempt === 0 ? row.label : `${row.label}-reopen-${attempt}`;
        const startedAt = now();
        let timeout = null;
        let failure = null;
        let maintenanceTimeout = null;
        const phasesBefore = receipt.phases.length;
        try {
          await session(
            row.label,
            nonce
              ? {
                  [MAINTENANCE_SEAM.ci]: "true",
                  [MAINTENANCE_SEAM.ownerTokenEnv]: MAINTENANCE_SEAM.ownerToken,
                  [MAINTENANCE_SEAM.nonceEnv]: nonce,
                  [MAINTENANCE_SEAM.triggerEnv]: MAINTENANCE_SEAM.trigger,
                }
              : {},
            row.main === "setup-ir" ? shared.setupMain : null,
            dirLabel,
          );
        } catch (error) {
          if ((error?.bSealTimeout || error?.bDirtiedAfterSeal) && row.seam)
            timeout = error;
          else if (
            error?.maintenanceTimeout &&
            row.label === "author" &&
            !partialRun(plan)
          )
            maintenanceTimeout = error;
          else failure = error;
        } finally {
          if (nonce) {
            receipt.seams ??= [];
            receipt.seams.push({
              session: row.label,
              attempt,
              trigger: MAINTENANCE_SEAM.trigger,
              nonceSha256: sha256(Buffer.from(nonce)),
            });
          }
        }
        if (row.seam) {
          receipt.sealAttempts ??= [];
          receipt.sealAttempts.push({
            session: row.label,
            attempt,
            dirLabel,
            outcome: failure
              ? "failed"
              : timeout === null
                ? "sealed"
                : timeout.bDirtiedAfterSeal
                  ? "sealed-then-dirty"
                  : "not-published",
            published:
              (timeout === null || Boolean(timeout.bDirtiedAfterSeal)) &&
              receipt.phases.some(
                (phaseRow) =>
                  phaseRow.session === row.label &&
                  /^b-seal(:|$)/u.test(phaseRow.name) &&
                  phaseRow.at >= startedAt,
              ),
            waitedMs: timeout?.bSealTimeout?.waitedMs ?? null,
            metadata:
              timeout?.bSealTimeout?.metadata ??
              timeout?.bDirtiedAfterSeal?.metadata ??
              null,
            // The phases of an opening that is reopened are kept here, not
            // in the receipt's phases (which hold the opening that counted).
            discardedPhases: timeout
              ? receipt.phases
                  .filter(
                    (phaseRow) =>
                      phaseRow.session === row.label &&
                      phaseRow.at >= startedAt,
                  )
                  .map((phaseRow) => ({ ...phaseRow }))
              : [],
            maintenanceRuns: (() => {
              try {
                return readRunsSince(
                  path.join(workspacePath, "grimodex.db"),
                  ids.projectId,
                  startedAt,
                );
              } catch {
                return null;
              }
            })(),
          });
        }
        // P-5: the author session's maintenance step and its openings.
        const maintenanceStep = plan.steps.findIndex(
          (step) => step.executor === "maintenance-enabled",
        );
        if (
          row.label === "author" &&
          maintenanceStep >= 0 &&
          maintenanceStep <= plan.stopIndex &&
          (maintenanceTimeout ||
            receipt.phases
              .slice(phasesBefore)
              .some((phaseRow) => phaseRow.name === "maintenance-enabled"))
        ) {
          receipt.maintenanceAttempts ??= [];
          receipt.maintenanceAttempts.push({
            attempt,
            dirLabel,
            outcome: maintenanceTimeout ? "not-reached" : "reached",
            missing: maintenanceTimeout?.maintenanceTimeout.missing ?? null,
            waitedMs: maintenanceTimeout?.maintenanceTimeout.waitedMs ?? null,
            settingWrites: ctx.maintenanceSettingWrites ?? 0,
            maintenanceRuns: (() => {
              try {
                return readRunsSince(
                  path.join(workspacePath, "grimodex.db"),
                  ids.projectId,
                  startedAt,
                );
              } catch {
                return null;
              }
            })(),
            // The failing step records no phase; the steps before it in the
            // first opening stay (they ran once and are not repeated).
            discardedPhases: [],
          });
        }
        // A later step of the session failed: the attempt is recorded above.
        if (failure) throw failure;
        if (maintenanceTimeout) {
          if (attempt >= MAINTENANCE_REOPENS) throw maintenanceTimeout;
          ctx.resumeAuthorFrom =
            maintenanceTimeout.maintenanceTimeout.stepIndex;
          continue;
        }
        if (timeout === null) break;
        // Only a session whose B seal was its first step is reopened (from
        // that step); a B that went dirty after the seal also reopens.
        const first = plan.steps.find((step) => step.session === row.label);
        if (
          first?.executor !== "b-seal" ||
          (ctx.sessionStepsDone > 0 && !timeout.bDirtiedAfterSeal)
        )
          throw timeout;
        if (attempt >= B_SEAL_REOPENS) {
          if (timeout.bDirtiedAfterSeal) throw timeout;
          failBlocked(
            "b-seal",
            "b-seal-not-published",
            ["b-sealed-binding"],
            `${plan.variantKey}: the ${row.label} session saw no new sealed B generation in ${attempt + 1} openings (${B_SEAL_REOPENS} reopens)`,
          );
        }
        receipt.phases = receipt.phases.filter(
          (phaseRow) =>
            !(phaseRow.session === row.label && phaseRow.at >= startedAt),
        );
      }
    }
    // The cold DB: the workspace closed with no WAL left, copied once.
    const live = path.join(workspacePath, "grimodex.db");
    const wal = `${live}-wal`;
    if (existsSync(wal) && statSync(wal).size > 0)
      throw new Error(
        "[artifact] the setup workspace kept a non-empty WAL after close",
      );
    const coldDir = path.join(setupDir, "cold-workspace");
    await mkdir(coldDir, { recursive: true });
    const cold = path.join(coldDir, "grimodex.db");
    await copyFile(live, cold);
    receipt.coldDatabase = {
      path: relativeToRoot(root, cold),
      sha256: sha256(await readFile(cold)),
    };
    receipt.logicalToRuntime = {
      projectId: ids.projectId,
      querySceneId: ids.querySceneId,
      scenes: { ...ids.scenes },
      folders: { ...ids.folders },
      entities: { ...ids.entities },
      relations: { ...ids.relations },
      foreshadows: { ...ids.foreshadows },
      pins: [...ids.pins],
      ...(Object.keys(ids.typedRevisions).length > 0
        ? { typedRevisions: { ...ids.typedRevisions } }
        : {}),
      // S1j-2: the IR, the G-02 Relation's runtime IDs, the withdrawal.
      ...(ids.chronicle ? { chronicle: { ...ids.chronicle } } : {}),
      ...(ids.relationRecreations
        ? { relationRecreations: { ...ids.relationRecreations } }
        : {}),
      ...(ids.decisions ? { decisions: { ...ids.decisions } } : {}),
    };
    // Product DB reads of the cold copy (① scope "product-db-read").
    const rows = readFrozenSetupRows(cold, ids.projectId);
    receipt.readBack = {
      logicalRuntimeCheck: assertLogicalRuntimeMap({ plan, ids, rows }),
      maintenanceEnabled: rows.maintenanceEnabled,
    };
    if (partialRun(plan) && rows.maintenanceEnabled)
      fail(
        "r5-check",
        `${plan.variantKey}: maintenance is on in the R5 check run's workspace`,
      );
    if (!partialRun(plan)) {
      // S1j-2: the complete setup's IR, Index state and measurement point
      // (① never reads these; DR-CP4-I-3).
      receipt.readBack.chronicle = assertChronicleSetup({
        plan,
        ids,
        rows: readChronicleSetupRows(cold, ids.projectId),
      });
      receipt.readBack.indexMetadata = readIndexMetadata(cold, ids.projectId);
      receipt.readBack.relationStaleness = assertRelationStaleOnCold({
        cold,
        ids,
      });
      receipt.measurementPoint = ctx.measurementProbe ?? null;
      if (ctx.preMutationIndexState)
        receipt.preMutationIndexState = ctx.preMutationIndexState;
      receipt.measurementSpec = plan.measurementSpec ?? null;
      if (shared.setupMain)
        receipt.setupMain = {
          path: shared.setupMain.setupMain.path,
          sha256: shared.setupMain.setupMain.sha256,
          table: shared.setupMain.table,
          productMain: shared.setupMain.productMain,
          reproducedProductMainSha256:
            shared.setupMain.reproducedProductMainSha256,
          inputDiff: shared.setupMain.inputDiff,
          env: shared.setupMain.env,
        };
      if (!ctx.measurementProbe)
        fail("measurement-point", `${plan.variantKey}: no measurement point`);
    }
    // SP/1: the step's record and its place. ① stops at the step, so its
    // place is checked on the recorded phases followed by the planned ones.
    const recorded = receipt.phases.map((row) => row.name);
    receipt.seedPinStep = ctx.seedPinRecord ?? null;
    receipt.seedPin = {
      ...assertSeedPinSetup({
        phases: partialRun(plan)
          ? [...recorded, ...plannedPhaseNames(plan).slice(recorded.length)]
          : recorded,
        record: ctx.seedPinRecord,
        fixturePins: frozenSetupFixturePins(plan, ids),
      }),
      placementCheckedOn: partialRun(plan)
        ? "recorded-through-seed-pin-then-planned"
        : "recorded",
    };
    if (partialRun(plan))
      receipt.r5CheckPhases = assertR5CheckPhases({ plan, phases: recorded });
    if (ctx.refusedAtSetup?.length > 0)
      receipt.refusedAtSetup = ctx.refusedAtSetup;
    if (ctx.authorityUnchanged)
      receipt.authorityUnchangedAfterFirstRevision = true;
    const problems = receipt.sessions.flatMap((row) => row?.problems ?? []);
    receipt.errors.push(...problems);
    receipt.status =
      problems.length === 0
        ? SETUP_STATUS_BY_STOP[plan.stopsAt]
        : "setup-with-problems";
  } catch (error) {
    const message = String(error?.message ?? error);
    receipt.errors.push(error?.stack ?? message);
    if (message.startsWith("[precheck]")) {
      receipt.status = "blocked";
      receipt.precheck = { message: message.split("\n")[0] };
      if (error?.blocked)
        receipt.blocked = blockedRecord({ plan, blocked: error.blocked });
    } else receipt.status = "failed";
  } finally {
    receipt.finishedAt = now();
    await save();
  }
  return { receipt, receiptPath };
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** The candidate a setup ran on (clean worktree required). */
export function candidateOf() {
  const clean = git(["status", "--porcelain", "--untracked-files=all"]) === "";
  return {
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
    clean,
  };
}

function parseArgs(argv, required) {
  const options = {};
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined)
      throw new Error("use --name value arguments");
    options[argv[at].slice(2)] = argv[at + 1];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.run ?? ""))
    throw new Error("--run <name> is required");
  for (const name of required)
    if (!options[name]) throw new Error(`--${name} is required`);
  return options;
}

/**
 * The shared launch side of a frozen setup run (renderer build, loopback
 * server, observer, the §15.8 dry-run admission: the product `.node`, no
 * Graph arm). Before the observation-prep commit a frozen fixture path is
 * launched only on the product `.node`.
 */
/**
 * S1j P3: the launched build is the standard-build receipt's: the candidate
 * commit and tree, and the four artifacts (the renderer `dist/index.html`,
 * Main, preload, the default `.node`) read back at their paths.
 */
export function assertBuildMatchesProductReceipt({
  root,
  candidate,
  productReceipt,
  hashFile = (file) => sha256(readFileSync(file)),
}) {
  const problems = [];
  if (productReceipt?.candidate?.resolvedHeadSha !== candidate?.commit)
    problems.push(
      `commit (receipt ${String(productReceipt?.candidate?.resolvedHeadSha)}, candidate ${String(candidate?.commit)})`,
    );
  if (productReceipt?.candidate?.resolvedHeadTreeSha !== candidate?.tree)
    problems.push("tree");
  const artifacts = {};
  for (const file of REQUIRED_ARTIFACTS) {
    const digest = (() => {
      try {
        return hashFile(path.join(root, file));
      } catch {
        return null;
      }
    })();
    artifacts[file] = digest;
    if (digest === null || digest !== productReceipt?.artifacts?.[file])
      problems.push(file);
  }
  if (problems.length > 0)
    fail(
      "build",
      `the launched build is not the standard-build receipt's: ${problems.join(", ")}`,
    );
  return { ok: true, artifacts };
}

/**
 * The shared launch side of a frozen setup run (renderer build, loopback
 * server, observer, the §15.8 dry-run admission: the product `.node`, no
 * Graph arm). Before the observation-prep commit a frozen fixture path is
 * launched only on the product `.node`. `deps` replace the build steps
 * (tests); the static server is closed when a later step fails.
 */
export async function prepareFrozenSetupShared({
  runDir,
  options,
  plans,
  irPlans = plans,
  deps = {},
}) {
  const {
    candidateOf: candidateFn = candidateOf,
    readProductReceipt = (file) => {
      const bytes = readFileSync(file);
      return { bytes, value: JSON.parse(bytes) };
    },
    root = ROOT,
    admit = admitFrozenDryRun,
    buildRenderer = buildHarnessRenderer,
    startServer = startStaticServer,
    bundle = bundleObserver,
  } = deps;
  const candidate = candidateFn();
  if (!candidate.clean)
    throw new Error(
      "[precheck] S1i: a frozen setup runs on a clean worktree (the receipt names the candidate commit)",
    );
  const nativePath = path.resolve(
    options.native ?? path.join(root, DEFAULT_ADDON),
  );
  const nativeSha256 = sha256(readFileSync(nativePath));
  const { bytes: receiptBytes, value: productReceipt } = readProductReceipt(
    path.resolve(options["product-receipt"]),
  );
  const build = assertBuildMatchesProductReceipt({
    root,
    candidate,
    productReceipt,
  });
  const admission = admit({
    fixtures: [...new Set(plans.map((plan) => plan.fixturePath))].map(
      (file) => ({ path: file }),
    ),
    nativeSha256,
    productReceipt,
  });
  // S1j-2 (B1): a complete setup builds the setup-only Main for this run.
  // Review P3 (a): the table from every plan (13 variants), not the run's.
  const setupMain = await setupMainFor({
    root,
    runDir,
    plans,
    irPlans,
    candidate,
    deps,
  });
  const rendererBuild = await buildRenderer({
    root,
    outDir: path.relative(root, path.join(runDir, "renderer-dist")),
    input: {
      index: path.join(root, "index.html"),
      harness: path.join(root, HARNESS_PAGE.slice(1)),
    },
  });
  let server = null;
  try {
    server = await startServer({ dir: path.join(runDir, "renderer-dist") });
    const observer = await bundle({ outDir: path.join(runDir, "observer") });
    return {
      root,
      server,
      observer,
      nativePath,
      models: { ja: options["ja-model"], en: options["en-model"] },
      admission,
      tmpRoot: options.tmp ? path.join(options.tmp, options.run) : null,
      candidate,
      launch: {
        native: "product",
        nativePath: path.relative(root, nativePath),
        nativeSha256,
        productReceiptSha256: sha256(receiptBytes),
        build: build.artifacts,
        productMain: {
          path: PRODUCT_MAIN,
          sha256: build.artifacts[PRODUCT_MAIN],
        },
        rendererBundleSha256: rendererBuild.rendererBundleSha256 ?? null,
        observerSha256: observer.sha256,
        admission: { dryRun: admission.dryRun, graphArm: admission.graphArm },
        ...(setupMain ? { setupMain: setupMainLaunch(setupMain) } : {}),
      },
      setupMain,
    };
  } catch (error) {
    await server?.close();
    throw error;
  }
}

const setupMainLaunch = (setupMain) => ({
  path: setupMain.setupMain.path,
  sha256: setupMain.setupMain.sha256,
  tableSha256: setupMain.table.sha256,
});

/**
 * S1j-2: the setup-only Main's table rows, from the plans' Scene and
 * qualifiedIr inputs (both copied from the fixture). One row per case and
 * Scene.
 */
export function setupIrRowsOfPlans(plans) {
  const rows = new Map();
  for (const plan of plans) {
    const scenes = plan.steps.find((step) => step.phase === "scenes").input
      .rows;
    for (const step of plan.steps.filter(
      (row) => row.executor === "qualified-ir",
    ))
      for (const ir of step.input.rows) {
        const scene = scenes.find((row) => row.logicalId === ir.sceneId);
        rows.set(`${plan.caseId}\u0000${ir.sceneId}`, {
          caseId: plan.caseId,
          id: ir.sceneId,
          title: scene.title,
          body: scene.body,
          interpretationSeed: {
            summary: ir.summary,
            actuality: ir.actuality,
            attribution: ir.attribution,
            narrativeFrame: ir.narrativeFrame,
          },
        });
      }
  }
  return [...rows.values()];
}

async function setupMainFor({
  root,
  runDir,
  plans,
  irPlans = plans,
  candidate,
  deps,
}) {
  const needed = plans.some((plan) =>
    plan.steps
      .slice(0, plan.stopIndex + 1)
      .some((step) => step.session === "ir"),
  );
  if (!needed) return null;
  const kinds = [
    ...new Set(irPlans.map((plan) => plan.fixtureKind ?? "frozen")),
  ];
  return (deps.buildSetupMain ?? buildSetupMain)({
    root,
    outDir: path.join(runDir, "setup-main"),
    rows: setupIrRowsOfPlans(irPlans),
    source:
      kinds.join(",") === "frozen"
        ? "frozen"
        : `dev-${path.basename(irPlans[0].fixturePath, ".json")}`,
    candidate,
  });
}

/**
 * S1j-2: the launch side of the dev fixture check (a dev graph-case fixture
 * in real Electron): the product `.node` (no evaluation build, no
 * admission), the current worktree (recorded, not required clean), the
 * harness renderer, the observer and the setup-only Main. Never used for a
 * frozen fixture.
 */
export async function prepareDevSetupShared({
  runDir,
  options,
  plans,
  irPlans = plans,
}) {
  if (plans.some((plan) => plan.fixtureKind !== "dev"))
    fail("dev-fixture", "the dev launch takes dev graph-case plans only");
  const root = ROOT;
  const candidate = candidateOf();
  const nativePath = path.resolve(path.join(root, DEFAULT_ADDON));
  const nativeSha256 = sha256(readFileSync(nativePath));
  const setupMain = await setupMainFor({
    root,
    runDir,
    plans,
    irPlans,
    candidate,
    deps: {},
  });
  const rendererBuild = await buildHarnessRenderer({
    root,
    outDir: path.relative(root, path.join(runDir, "renderer-dist")),
    input: {
      index: path.join(root, "index.html"),
      harness: path.join(root, HARNESS_PAGE.slice(1)),
    },
  });
  const server = await startStaticServer({
    dir: path.join(runDir, "renderer-dist"),
  });
  try {
    const observer = await bundleObserver({
      outDir: path.join(runDir, "observer"),
    });
    return {
      root,
      server,
      observer,
      nativePath,
      models: { ja: options["ja-model"], en: options["en-model"] },
      admission: null,
      tmpRoot: options.tmp ? path.join(options.tmp, options.run) : null,
      candidate,
      setupMain,
      launch: {
        native: "product",
        nativePath: path.relative(root, nativePath),
        nativeSha256,
        productMain: {
          path: PRODUCT_MAIN,
          sha256: sha256(readFileSync(path.join(root, PRODUCT_MAIN))),
        },
        rendererBundleSha256: rendererBuild.rendererBundleSha256 ?? null,
        observerSha256: observer.sha256,
        ...(setupMain ? { setupMain: setupMainLaunch(setupMain) } : {}),
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

/** S1j-2: the dev fixture check of the complete setup (real Electron). */
async function mainDev() {
  const options = parseArgs(process.argv.slice(2), [
    "dev-fixture",
    "variant",
    "ja-model",
    "en-model",
  ]);
  const plans = loadDevGraphCasePlans({
    root: ROOT,
    fixturePath: options["dev-fixture"],
    stopsAt: SETUP_STOPS.complete,
  });
  const selected =
    options.variant === "all"
      ? plans
      : plans.filter((row) => row.variantId === options.variant);
  if (selected.length === 0)
    throw new Error(`[precheck] no dev variant ${options.variant}`);
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: false });
  const shared = await prepareDevSetupShared({
    runDir,
    options,
    plans: selected,
    irPlans: plans,
  });
  try {
    for (const plan of selected) {
      const { receipt, receiptPath } = await setupFrozenVariant({
        plan,
        setupDir: path.join(runDir, "setup", plan.caseId, plan.variantId),
        shared,
      });
      process.stdout.write(
        `${JSON.stringify({ variant: plan.variantKey, status: receipt.status, receipt: path.relative(ROOT, receiptPath), precheck: receipt.precheck, errors: receipt.errors.map((row) => String(row).split("\n")[0]) })}\n`,
      );
      if (receipt.status !== SETUP_STATUS_BY_STOP.complete)
        process.exitCode = 1;
    }
  } finally {
    await shared.server?.close();
    removeSetupMain(shared.setupMain);
  }
}

async function main() {
  if (process.argv.includes("--dev-fixture")) return mainDev();
  const options = parseArgs(process.argv.slice(2), [
    "case",
    "variant",
    "stops-at",
    "product-receipt",
    "ja-model",
    "en-model",
  ]);
  const plans = loadFrozenSetupPlans({
    root: ROOT,
    stopsAt: options["stops-at"],
  });
  const plan = plans.find(
    (row) => row.caseId === options.case && row.variantId === options.variant,
  );
  if (!plan)
    throw new Error(
      `[precheck] ${options.case}/${options.variant} is not a CP-4 variant`,
    );
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: true });
  const shared = {
    ...(await prepareFrozenSetupShared({
      runDir,
      options,
      plans: [plan],
      irPlans: plans,
    })),
    // A single-variant seed-pin setup is its own R5 check run (never ①'s).
    ...(plan.stopsAt === SETUP_STOPS.seedPin
      ? { r5CheckRunId: randomUUID() }
      : {}),
  };
  try {
    const { receipt, receiptPath } = await setupFrozenVariant({
      plan,
      setupDir: path.join(runDir, "setup", plan.caseId, plan.variantId),
      shared,
    });
    process.stdout.write(
      `${JSON.stringify({ status: receipt.status, receipt: path.relative(ROOT, receiptPath), precheck: receipt.precheck })}\n`,
    );
    if (!Object.values(SETUP_STATUS_BY_STOP).includes(receipt.status))
      process.exitCode = 1;
  } finally {
    await shared.server?.close();
    removeSetupMain(shared.setupMain);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
