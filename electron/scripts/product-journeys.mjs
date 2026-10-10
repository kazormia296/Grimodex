#!/usr/bin/env node

import { constants, createReadStream, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { access, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { rootDir } from "./build.mjs";
import {
  digestProductJourneyCatalog,
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  NIR1_ENTITY_RELATION_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG_DIGEST,
} from "./product-journey-catalog.mjs";
import { createProductJourneyHarness } from "./product-journey-harness.mjs";
import { launchProductJourneyMcpClient } from "./product-journey-mcp-client.mjs";
import { createNativeRoundTripJourneys } from "./product-journey-native-roundtrips.mjs";
import { createChronicleExtractionJourney } from "./chronicle-extraction-product-journey.mjs";
import { createCodexEntityRelationReviewJourney } from "./codex-entity-relation-product-journey.mjs";
import { createNarrativeMaintenanceProductJourneys } from "./narrative-maintenance-product-journeys.mjs";
import {
  C2ZC_RESTORE_FIXTURE_ENV,
  C2ZC_PRODUCT_JOURNEY_ID,
  assertC2ZcFixtureCandidateBinding,
  loadC2ZcRestoreFixtureInput,
  runC2ZcCanonicalAuthorityJourney,
} from "./c2zc-canonical-product-journey.mjs";
import { runC2ZcRendererMcpDmlDenialJourney } from "./c2zc-renderer-mcp-dml-denial-product-journey.mjs";
import {
  C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST,
  C2ZC_RUST_ACCEPTANCE_RECEIPT_PATH,
  resolveC2ZcRustAcceptanceCandidate,
  verifyC2ZcRustAcceptanceReceipt,
} from "../../scripts/c2zc-rust-acceptance-receipt.mjs";

const DEFAULT_SCENE_TITLE = "シーン 1";
const SCENES_PANEL_TITLE = "シーン";
const CREATE_BUTTON_TITLE = "新規作成";
const NEW_SCENE_MENU_ITEM = "New scene";
const NEW_FOLDER_MENU_ITEM = "New folder";
const JOURNEY_TEXT = `PRODUCT-JOURNEY-${Date.now()}`;
const PENDING_SAVE_TEXT = `PENDING-SAVE-JOURNEY-${Date.now()}`;
const PENDING_PROJECT_SAVE_TEXT = `PENDING-PROJECT-SAVE-JOURNEY-${Date.now()}`;
const CLEAN_EXTERNAL_TEXT = `CLEAN-EXTERNAL-JOURNEY-${Date.now()}`;
const DIRTY_LOCAL_TEXT = `DIRTY-LOCAL-JOURNEY-${Date.now()}`;
const DIRTY_EXTERNAL_TEXT = `DIRTY-EXTERNAL-JOURNEY-${Date.now()}`;
const CHAT_AUTHORITY_PROMPT = `CHAT-AUTHORITY-JOURNEY-${Date.now()}`;
const FOLDER_CHAT_SWITCH_PROMPT = `FOLDER-CHAT-SWITCH-${Date.now()}`;
const CODEX_CHAT_SWITCH_PROMPT = `CODEX-CHAT-SWITCH-${Date.now()}`;
const CODEX_CHAT_SWITCH_A_MARKER = `CODEX-SWITCH-A-${Date.now()}`;
const CODEX_CHAT_SWITCH_B_MARKER = `CODEX-SWITCH-B-${Date.now()}`;
const SNIPPET_CHAT_SWITCH_PROMPT = `SNIPPET-CHAT-SWITCH-${Date.now()}`;
const PROJECT_CHAT_AUTHORITY_PROMPT = `PROJECT-CHAT-AUTHORITY-JOURNEY-${Date.now()}`;
const AGENT_PROJECT_SWITCH_PROMPT = `AGENT-PROJECT-SWITCH-PROMPT-${Date.now()}`;
const AGENT_PROJECT_SWITCH_OUTPUT = "AGENT-PROJECT-SWITCH-OUTPUT";
const AGENT_WORKSPACE_SWITCH_PROMPT = `AGENT-WORKSPACE-SWITCH-PROMPT-${Date.now()}`;
const AGENT_WORKSPACE_SWITCH_OUTPUT = "AGENT-WORKSPACE-SWITCH-OUTPUT";
const WORKSPACE_CHAT_AUTHORITY_PROMPT = `WORKSPACE-CHAT-AUTHORITY-JOURNEY-${Date.now()}`;
const NEW_SCOPED_CHAT_PROMPT = `NEW-SCOPE-JOURNEY-${Date.now()}`;
const CHAT_AUTHORITY_EARLY = "AUTHORITY-OLD-EARLY";
const CHAT_AUTHORITY_LATE = "AUTHORITY-OLD-LATE";
const WORKSPACE_CHAT_AUTHORITY_TITLE = WORKSPACE_CHAT_AUTHORITY_PROMPT.slice(
  0,
  30,
);
const CODEX_CONTEXT_MARKER = "CODEX-CONTEXT-JOURNEY";
const AUTHORING_PROMPT = `AUTHORING-JOURNEY-${Date.now()}`;
const AUTHORING_OUTPUT = "AUTHORING-AI-OUTPUT";
const PRODUCT_JOURNEY_MODEL = "product-journey-model";
const PENDING_SAVE_AUTOSAVE_DELAY_MS = 60_000;
const PRODUCT_JOURNEY_RESULTS_VERSION = 5;
const PRODUCT_JOURNEY_LANE_WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000;
const PRODUCT_JOURNEY_AUDIT_MANIFEST_VERSION = 1;
const C2ZC_RUST_RECEIPT_PATH_ENV = "GRIMODEX_C2ZC_RUST_RECEIPT_PATH";
const C2ZC_RUST_RECEIPT_SHA256_ENV = "GRIMODEX_C2ZC_RUST_RECEIPT_SHA256";
const C2ZC_RUST_BASE_ENV = "GRIMODEX_C2ZC_RUST_REQUESTED_BASE";
const C2ZC_RUST_HEAD_ENV = "GRIMODEX_C2ZC_RUST_REQUESTED_HEAD";
const PRODUCT_JOURNEY_BUILD_RECEIPT_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_BUILD_RECEIPT";
const PRODUCT_JOURNEY_BUILD_RECEIPT_KEYS = [
  "version",
  "verified",
  "source",
  "candidate",
  "artifacts",
];
const PRODUCT_JOURNEY_ARTIFACT_KEYS = [
  "name",
  "path",
  "requestedPath",
  "realPath",
  "size",
  "sha256",
];
const PRODUCT_JOURNEY_CANDIDATE_KEYS = [
  "requestedBase",
  "requestedHead",
  "resolvedBaseSha",
  "resolvedHeadSha",
  "resolvedHeadTreeSha",
  "currentHeadSha",
  "worktreeClean",
  "worktreeFingerprint",
  "worktreeStatusHash",
];
const PRODUCT_JOURNEY_GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/u;
const PRODUCT_JOURNEY_SHA256_HEX = /^[0-9a-f]{64}$/u;
const C2ZC_PRODUCT_JOURNEY_IDS = Object.freeze(
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
);
const REQUIRED_LIFECYCLE_TRANSITION_PHASES = [
  "switch-requested",
  "quiescence-started",
  "old-stream-completed",
  "old-scope-persisted",
  "authority-commit",
  "new-scope-hydrated",
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function log(message) {
  console.log(`[electron:product] ${message}`);
}

function readEulaVersion() {
  const source = readFileSync(
    path.join(rootDir, "src", "features", "legal", "constants.ts"),
    "utf8",
  );
  const match = source.match(/EULA_VERSION\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("could not read EULA_VERSION");
  return match[1];
}

function appVersion() {
  return JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"))
    .version;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(`sha256:${digest.digest("hex")}`));
  });
}

function resolveConfiguredPath(
  value,
  { root = rootDir, label, pathApi = path },
) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain NUL bytes`);
  }
  return pathApi.isAbsolute(value) ? value : pathApi.resolve(root, value);
}

export function resolveMcpArtifactPath({
  root = rootDir,
  overridePath,
  cargoTargetDir,
  platform = process.platform,
  env = process.env,
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const executableName =
    platform === "win32" ? "grimodex-mcp.exe" : "grimodex-mcp";
  const configuredOverridePath =
    overridePath === undefined ? env.GRIMODEX_MCP_PATH : overridePath;
  const configuredCargoTargetDir =
    cargoTargetDir === undefined ? env.CARGO_TARGET_DIR : cargoTargetDir;
  const override = resolveConfiguredPath(configuredOverridePath, {
    root,
    label: "GRIMODEX_MCP_PATH",
    pathApi,
  });
  if (override !== undefined) {
    if (!pathApi.isAbsolute(configuredOverridePath)) {
      throw new Error("GRIMODEX_MCP_PATH must be an absolute path");
    }
    return override;
  }
  const configuredTarget = resolveConfiguredPath(configuredCargoTargetDir, {
    root,
    label: "CARGO_TARGET_DIR",
    pathApi,
  });
  const targetDir =
    configuredTarget ?? pathApi.join(root, "src-tauri", "target");
  return pathApi.join(targetDir, "debug", executableName);
}

export async function resolveProductJourneyArtifact(
  requestedPath,
  { executable = false, root = rootDir, platform = process.platform } = {},
) {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.length === 0 ||
    requestedPath.includes("\0")
  ) {
    throw new Error(
      "artifact path must be a non-empty string without NUL bytes",
    );
  }
  const absoluteRequestedPath = path.resolve(root, requestedPath);
  const canonicalPath = await realpath(absoluteRequestedPath);
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) {
    throw new Error(`artifact is not a regular file: ${absoluteRequestedPath}`);
  }
  if (executable && platform !== "win32") {
    await access(canonicalPath, constants.X_OK);
  }
  return {
    path: absoluteRequestedPath,
    requestedPath: absoluteRequestedPath,
    realPath: canonicalPath,
    size: metadata.size,
    sha256: await hashFile(canonicalPath),
  };
}

export async function resolveMcpArtifact(options = {}) {
  const requestedPath = resolveMcpArtifactPath(options);
  try {
    return await resolveProductJourneyArtifact(requestedPath, {
      executable: true,
      root: options.root ?? rootDir,
      platform: options.platform ?? process.platform,
    });
  } catch (error) {
    throw new Error(`missing MCP product journey artifact: ${requestedPath}`, {
      cause: error,
    });
  }
}

const PRODUCT_JOURNEY_ARTIFACT_NAMES = Object.freeze({
  electronMain: "Electron main",
  renderer: "renderer",
  native: "N-API native module",
  mcp: "MCP sidecar",
});

/**
 * Resolve the exact executable artifact set for a catalog selection.  The
 * catalog, rather than the runner implementation, is the authority for
 * capability requirements; this keeps a focused C2-ZC run free of an
 * accidental MCP dependency.
 */
export function resolveProductJourneyArtifactRequests(
  journeys,
  {
    catalog = PRODUCT_JOURNEY_CATALOG,
    root = rootDir,
    env = process.env,
    platform = process.platform,
  } = {},
) {
  const selectedIds = new Set(
    (Array.isArray(journeys) ? journeys : []).map((journey) => journey?.id),
  );
  const selectedCatalog = catalog.filter((journey) =>
    selectedIds.has(journey?.id),
  );
  const capabilities = new Set(
    selectedCatalog.flatMap((journey) =>
      Array.isArray(journey?.capabilities) ? journey.capabilities : [],
    ),
  );
  const requests = [];
  if (capabilities.has("electron")) {
    requests.push(
      {
        name: PRODUCT_JOURNEY_ARTIFACT_NAMES.electronMain,
        path: path.join(root, "dist-electron", "main.cjs"),
      },
      {
        name: PRODUCT_JOURNEY_ARTIFACT_NAMES.renderer,
        path: path.join(root, "dist", "index.html"),
      },
    );
  }
  if (capabilities.has("napi")) {
    requests.push({
      name: PRODUCT_JOURNEY_ARTIFACT_NAMES.native,
      path:
        resolveConfiguredPath(env.GRIMODEX_NODE_PATH, {
          root,
          label: "GRIMODEX_NODE_PATH",
        }) ??
        path.join(
          root,
          "electron",
          "native",
          "grimodex-node",
          "grimodex-node.node",
        ),
    });
  }
  if (capabilities.has("mcp")) {
    requests.push({
      name: PRODUCT_JOURNEY_ARTIFACT_NAMES.mcp,
      path: resolveMcpArtifactPath({ root, env, platform }),
      executable: true,
    });
  }
  return requests;
}

export async function assertBuildArtifacts(
  journeys,
  {
    catalog = PRODUCT_JOURNEY_CATALOG,
    root = rootDir,
    env = process.env,
    platform = process.platform,
  } = {},
) {
  const requests = resolveProductJourneyArtifactRequests(journeys, {
    catalog,
    root,
    env,
    platform,
  });
  const artifacts = [];
  for (const request of requests) {
    try {
      artifacts.push({
        name: request.name,
        ...(await resolveProductJourneyArtifact(request.path, {
          executable: request.executable === true,
          root,
          platform,
        })),
      });
    } catch (error) {
      throw new Error(
        `missing Electron product journey artifact: ${request.path}\nRun the builds required by the selected journey capabilities first.`,
        { cause: error },
      );
    }
  }
  return { artifacts };
}

function scenesPanelHeader(page) {
  return page.locator(
    `[data-panel-header]:has(span[role="heading"]:text-is("${SCENES_PANEL_TITLE}"))`,
  );
}

async function workspaceOpenRevision(page) {
  const value = await page
    .getByTestId("workspace-menu-trigger")
    .getAttribute("data-workspace-open-revision");
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) {
    throw new Error(`invalid workspace open revision: ${String(value)}`);
  }
  return revision;
}

function lifecycleScopeMatches(actual, expected = {}) {
  return Object.entries(expected).every(
    ([key, value]) => value === undefined || actual?.[key] === value,
  );
}

export async function assertLifecycleTransitionOrder(
  harness,
  page,
  { kind, from, to, label },
) {
  const events = await harness.readLifecycleTrace(page);
  const grouped = new Map();
  for (const event of events) {
    if (
      event?.schemaVersion !== 1 ||
      event.kind !== kind ||
      !lifecycleScopeMatches(event.from, from) ||
      !lifecycleScopeMatches(event.to, to)
    ) {
      continue;
    }
    const group = grouped.get(event.transitionId) ?? [];
    group.push(event);
    grouped.set(event.transitionId, group);
  }

  const candidates = [...grouped.values()].map((group) =>
    [...group].sort((left, right) => left.sequence - right.sequence),
  );
  const matching = candidates.find(
    (group) =>
      JSON.stringify(group.map((event) => event.phase)) ===
        JSON.stringify(REQUIRED_LIFECYCLE_TRANSITION_PHASES) &&
      group.every((event, index) => event.sequence === index),
  );
  if (!matching) {
    throw new Error(
      `${label} did not emit the required lifecycle order: ` +
        `${REQUIRED_LIFECYCLE_TRANSITION_PHASES.join(" -> ")}; observed=${JSON.stringify(
          candidates.map((group) => ({
            transitionId: group[0]?.transitionId ?? null,
            phases: group.map((event) => event.phase),
            sequences: group.map((event) => event.sequence),
          })),
        )}`,
    );
  }

  harness.recordTimeline("application-lifecycle-order-verified", {
    transitionId: matching[0].transitionId,
    kind,
    lifecyclePhases: matching.map((event) => event.phase),
    from: matching[0].from,
    to: matching.at(-1).to,
  });
  return matching;
}

export async function configureWorkspace(
  harness,
  workspace,
  { appSettings = {}, deterministicAi = false, additionalWorkspaces = [] } = {},
) {
  const configuredWorkspaces = [
    workspace,
    ...additionalWorkspaces.filter((candidate) => candidate !== workspace),
  ];
  await Promise.all(
    configuredWorkspaces.map((candidate) =>
      mkdir(candidate, { recursive: true }),
    ),
  );
  const launched = await harness.launch("configure");
  let closed = false;
  try {
    // The bridge is ready before cold workspace initialization settles.
    // Wait for its empty-recents welcome screen (behind the EULA modal) before
    // Native Open changes settings startup could migrate from a stale snapshot.
    await launched.page
      .getByRole("button", { name: /日本語/, includeHidden: true })
      .waitFor({ state: "attached" });
    await harness.invokeOk(launched.page, "open_workspace", {
      path: workspace,
    });
    if (deterministicAi) {
      const aiSettings = await harness.invokeOk(
        launched.page,
        "get_ai_settings",
      );
      await harness.invokeOk(launched.page, "save_ai_settings", {
        settings: {
          ...aiSettings,
          provider: "ollama",
          model: PRODUCT_JOURNEY_MODEL,
          ollamaEndpoint: "http://127.0.0.1:11434",
        },
      });
    }
    // Create every secondary DB in the same initialized renderer. Launching
    // another renderer between these Native swaps would start auto-open
    // hydration alongside the test-only DB preparation again.
    for (const additionalWorkspace of configuredWorkspaces.slice(1)) {
      await harness.invokeOk(launched.page, "open_workspace", {
        path: additionalWorkspace,
      });
    }
    if (configuredWorkspaces.length > 1) {
      await harness.invokeOk(launched.page, "open_workspace", {
        path: workspace,
      });
    }
    const settings = await harness.invokeOk(
      launched.page,
      "get_global_settings",
    );
    await harness.invokeOk(launched.page, "save_global_settings", {
      settings: {
        ...settings,
        lastActiveWorkspace: workspace,
        trustedWorkspaces: configuredWorkspaces,
        showLauncherOnStartup: false,
        hasSeenWelcome: true,
        acceptedEulaVersion: readEulaVersion(),
        lastSeenReleaseNotesVersion: appVersion(),
      },
    });
    await harness.close(launched.app, launched.page, "configure");
    closed = true;
    if (Object.keys(appSettings).length > 0) {
      await harness.executeFixtureOperations(
        workspace,
        Object.entries(appSettings).map(([key, value]) => ({
          kind: "app-settings-upsert",
          key,
          value: String(value),
        })),
      );
    }
  } finally {
    if (!closed) await harness.close(launched.app, launched.page, "configure");
  }
}

/**
 * C2-5B's durable maintenance acceptance lane is canonical in the runner.
 * The `c2-5b` selector is retained for focused acceptance and reporting; the
 * default canonical run includes these IDs. C2-ZC has its own focused selector
 * because its one-way Generic-authority transition is a distinct boundary.
 */
export const NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS =
  createNarrativeMaintenanceProductJourneys({ configureWorkspace });

/** C2-ZC production reachability is a distinct acceptance journey. */
export const NARRATIVE_C2ZC_PRODUCT_JOURNEYS = [
  {
    id: C2ZC_PRODUCT_JOURNEY_ID,
    required: true,
    acceptanceRole: "required",
    run: (harness) =>
      runC2ZcCanonicalAuthorityJourney(harness, configureWorkspace),
  },
  {
    id: "c2-zc-renderer-mcp-dml-denial",
    required: true,
    acceptanceRole: "auxiliary",
    run: runC2ZcRendererMcpDmlDenialJourney,
  },
];

export function resolveProductJourneySet(
  name = process.env.GRIMODEX_PRODUCT_JOURNEY_SET,
) {
  if (name === undefined || name === "") return PRODUCT_JOURNEYS;
  if (name === "c2-5b") return NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS;
  if (name === "c2-zc") return NARRATIVE_C2ZC_PRODUCT_JOURNEYS;
  if (name === "nir1-entity-relation-review") {
    const ids = new Set(
      NIR1_ENTITY_RELATION_PRODUCT_JOURNEY_CATALOG.map(({ id }) => id),
    );
    return PRODUCT_JOURNEYS.filter((journey) => ids.has(journey.id));
  }
  throw new Error(`unknown GRIMODEX_PRODUCT_JOURNEY_SET: ${name}`);
}

export function resolveProductJourneyCatalog(
  name = process.env.GRIMODEX_PRODUCT_JOURNEY_SET,
) {
  if (name === undefined || name === "") return PRODUCT_JOURNEY_CATALOG;
  // Preserve the existing focused C2-5B selection's full-catalog binding.
  if (name === "c2-5b") return PRODUCT_JOURNEY_CATALOG;
  if (name === "c2-zc") return NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG;
  if (name === "nir1-entity-relation-review") {
    return NIR1_ENTITY_RELATION_PRODUCT_JOURNEY_CATALOG;
  }
  throw new Error(`unknown product journey catalog set: ${name}`);
}

async function queryRows(harness, page, sql, params = []) {
  const result = await harness.invokeOk(page, "db_execute", {
    sql,
    params,
    method: "all",
  });
  return result?.rows ?? [];
}

async function currentProjectRow(harness, page) {
  return harness.waitUntil(async () => {
    const rows = await queryRows(
      harness,
      page,
      `SELECT p.id, p.title
       FROM projects p
       LEFT JOIN app_settings a
         ON a.key = 'workspace.lastActiveProjectId' AND a.value = p.id
       ORDER BY CASE WHEN a.value = p.id THEN 0 ELSE 1 END, p.rowid
       LIMIT 1`,
    );
    return rows[0] ?? null;
  }, "current project database authority");
}

async function prepareSecondProject(
  harness,
  { phase, id, title, workspace, projectSettings = {} },
) {
  const prepared = await harness.launch(`${phase}/prepare-projects`);
  let closed = false;
  try {
    await prepared.page
      .getByTestId("project-menu-trigger")
      .waitFor({ state: "visible", timeout: 30_000 });
    const projectA = await currentProjectRow(harness, prepared.page);
    const existing = await queryRows(
      harness,
      prepared.page,
      "SELECT id FROM projects WHERE id = ?",
      [id],
    );
    if (existing.length === 0) {
      const now = new Date().toISOString();
      await harness.invokeOk(prepared.page, "project_create", {
        payload: {
          requestId: `product-project-create:${id}`,
          projectId: id,
          sessionId: "electron-product-journey",
          eventUid: `product-project-create-event:${id}`,
          origin: "human",
          originalTransactionId: null,
          undoJournalId: null,
          title,
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
    }
    const result = {
      projectA: {
        id: String(projectA.id),
        title: String(projectA.title),
      },
      projectB: { id, title },
    };
    await harness.close(
      prepared.app,
      prepared.page,
      `${phase}/prepare-projects`,
    );
    closed = true;
    if (Object.keys(projectSettings).length > 0) {
      await harness.executeFixtureOperations(
        workspace,
        Object.entries(projectSettings).map(([key, value]) => ({
          kind: "project-settings-upsert",
          projectId: projectA.id,
          key,
          value: String(value),
        })),
      );
    }
    return result;
  } finally {
    if (!closed) {
      await harness.close(
        prepared.app,
        prepared.page,
        `${phase}/prepare-projects`,
      );
    }
  }
}

async function prepareProjectSettings(harness, phase, workspace, settings) {
  const prepared = await harness.launch(`${phase}/prepare-settings`);
  let closed = false;
  try {
    await prepared.page
      .getByTestId("project-menu-trigger")
      .waitFor({ state: "visible", timeout: 30_000 });
    const project = await currentProjectRow(harness, prepared.page);
    const result = {
      id: String(project.id),
      title: String(project.title),
    };
    await harness.close(
      prepared.app,
      prepared.page,
      `${phase}/prepare-settings`,
    );
    closed = true;
    if (Object.keys(settings).length > 0) {
      await harness.executeFixtureOperations(
        workspace,
        Object.entries(settings).map(([key, value]) => ({
          kind: "project-settings-upsert",
          projectId: project.id,
          key,
          value: String(value),
        })),
      );
    }
    return result;
  } finally {
    if (!closed) {
      await harness.close(
        prepared.app,
        prepared.page,
        `${phase}/prepare-settings`,
      );
    }
  }
}

async function switchProjectThroughUi(harness, page, { id, title }, label) {
  await page.getByTestId("project-menu-trigger").click();
  await page.getByTestId(`project-switch-${id}`).click();
  await harness.waitUntil(async () => {
    const activeSetting = await queryRows(
      harness,
      page,
      "SELECT value FROM app_settings WHERE key = 'workspace.lastActiveProjectId'",
    );
    const triggerText = await page
      .getByTestId("project-menu-trigger")
      .textContent();
    return (
      activeSetting[0]?.value === id &&
      String(triggerText ?? "").includes(title)
    );
  }, label);
}

async function clickProjectSwitchDuringAgentTurn(page, project) {
  // Avoid Playwright's pointer-stability wait on Xvfb's software renderer.
  const trigger = page.getByTestId("project-menu-trigger");
  await trigger.waitFor({ state: "visible" });
  await trigger.evaluate((button) => button.click());
  const option = page.getByTestId(`project-switch-${project.id}`);
  await option.waitFor({ state: "visible" });
  await option.evaluate((button) => button.click());
}

async function switchWorkspaceThroughUi(harness, page, workspace, label) {
  const previousRevision = await workspaceOpenRevision(page);
  const workspaceName = path.basename(workspace);
  await page.getByTestId("workspace-menu-trigger").click();
  await page
    .getByTestId("workspace-menu-dropdown")
    .getByRole("button", { name: workspaceName, exact: true })
    .click();
  await harness.waitUntil(async () => {
    const triggerText = await page
      .getByTestId("workspace-menu-trigger")
      .textContent();
    const nextRevision = await workspaceOpenRevision(page);
    return (
      String(triggerText ?? "").includes(workspaceName) &&
      nextRevision > previousRevision
    );
  }, label);
}

async function clickWorkspaceSwitchDuringAgentTurn(page, workspace) {
  // Avoid Playwright's pointer-stability wait on Xvfb's software renderer.
  const trigger = page.getByTestId("workspace-menu-trigger");
  await trigger.waitFor({ state: "visible" });
  await trigger.evaluate((button) => button.click());
  const option = page
    .getByTestId("workspace-menu-dropdown")
    .getByRole("button", {
      name: path.basename(workspace),
      exact: true,
    });
  await option.waitFor({ state: "visible" });
  await option.evaluate((button) => button.click());
}

async function findSceneById(harness, page, sceneId) {
  const result = await harness.invokeOk(page, "db_execute", {
    sql: "SELECT id, project_id AS projectId, title, content FROM tree_nodes WHERE id = ? AND node_type = 'scene'",
    params: [sceneId],
    method: "all",
  });
  return result?.rows?.[0] ?? null;
}

async function findSceneWithTextForProject(harness, page, projectId, text) {
  const rows = await queryRows(
    harness,
    page,
    `SELECT id, project_id AS projectId, title, content
     FROM tree_nodes
     WHERE project_id = ? AND node_type = 'scene'`,
    [projectId],
  );
  return rows.find((row) => String(row.content ?? "").includes(text)) ?? null;
}

async function listChatAuthorityRows(harness, page, projectId) {
  const result = await harness.invokeOk(page, "db_execute", {
    sql: `SELECT
      s.id AS sessionId,
      s.node_id AS nodeId,
      s.codex_anchor_id AS codexAnchorId,
      s.snippet_anchor_id AS snippetAnchorId,
      s.title AS sessionTitle,
      m.id AS messageId,
      m.role AS role,
      m.content AS content,
      p.system_prompt AS systemPrompt
    FROM chat_sessions s
    LEFT JOIN chat_messages m ON m.session_id = s.id
    LEFT JOIN chat_message_prompts p ON p.message_id = m.id
    WHERE s.project_id = ?
    ORDER BY s.created_at, m.created_at`,
    params: [projectId],
    method: "all",
  });
  return result?.rows ?? [];
}

function assertCompletedChatAuthority(
  rows,
  {
    prompt,
    label,
    outputMarkers = [CHAT_AUTHORITY_EARLY, CHAT_AUTHORITY_LATE],
  },
) {
  if (
    !rows.some(
      (row) =>
        row.role === "user" && String(row.content ?? "").includes(prompt),
    )
  ) {
    throw new Error(`${label} did not persist the user prompt`);
  }
  for (const marker of outputMarkers) {
    if (
      !rows.some(
        (row) =>
          row.role === "assistant" &&
          String(row.content ?? "").includes(marker),
      )
    ) {
      throw new Error(`${label} did not drain ${marker} before switching`);
    }
  }
  if (!rows.some((row) => row.systemPrompt != null)) {
    throw new Error(`${label} did not persist its prompt snapshot`);
  }
}

function chatAuthorityLeaks(rows, prompt) {
  return rows.filter((row) => {
    const content = String(row.content ?? "");
    const systemPrompt = String(row.systemPrompt ?? "");
    return (
      content.includes(prompt) ||
      content.includes(CHAT_AUTHORITY_EARLY) ||
      content.includes(CHAT_AUTHORITY_LATE) ||
      systemPrompt.includes(prompt)
    );
  });
}

async function startAgentAuthorityTurn(harness, page, projectId, prompt) {
  const toggle = page.getByTestId("agent-mode-toggle");
  await toggle.waitFor({ state: "visible", timeout: 30_000 });
  if (await toggle.isDisabled()) {
    throw new Error("Agent mode is unavailable in the deterministic journey");
  }
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await harness.waitUntil(
    async () => (await toggle.getAttribute("aria-pressed")) === "true",
    "Agent mode enabled for lifecycle journey",
  );
  await sendChatPrompt(page, prompt);
  const preparedAudit = await harness.waitUntil(async () => {
    const rows = await queryRows(
      harness,
      page,
      `SELECT execution_id AS executionId, payload
       FROM ai_audit_events
       WHERE project_id = ? AND path_id = 'chat_agent_main'
         AND event_type = 'request.prepared'
       ORDER BY sequence DESC LIMIT 1`,
      [projectId],
    );
    return String(rows[0]?.payload ?? "").includes(prompt) ? rows[0] : null;
  }, "Agent request prepared before lifecycle switch");
  await harness.waitUntil(
    async () =>
      (
        await queryRows(
          harness,
          page,
          `SELECT sequence FROM ai_audit_events
           WHERE project_id = ? AND path_id = 'chat_agent_main'
             AND execution_id = ? AND event_type = 'request.dispatched'`,
          [projectId, preparedAudit.executionId],
        )
      ).length === 1,
    "Agent transport dispatch before lifecycle switch",
  );
  await page
    .getByTestId("chat-send")
    .waitFor({ state: "detached", timeout: 5_000 });
  return preparedAudit;
}

function assertCompletedAgentAuthority(
  rows,
  { prompt, outputMarker, label },
) {
  if (
    !rows.some(
      (row) =>
        row.role === "user" && String(row.content ?? "").includes(prompt),
    ) ||
    !rows.some(
      (row) =>
        row.role === "assistant" &&
        String(row.content ?? "").includes(outputMarker),
    ) ||
    !rows.some((row) => row.systemPrompt != null)
  ) {
    throw new Error(
      `${label} did not persist the Agent turn and prompt snapshot`,
    );
  }
}

function agentAuthorityLeaks(rows, prompt, outputMarker) {
  return rows.filter(
    (row) =>
      String(row.content ?? "").includes(prompt) ||
      String(row.content ?? "").includes(outputMarker) ||
      String(row.systemPrompt ?? "").includes(prompt),
  );
}

async function setProjectChatScope(page) {
  const picker = page.getByTestId("chat-scope-picker");
  await picker.click();
  await page.getByTestId("chat-scope-project").click();
  await picker.waitFor({ state: "visible", timeout: 30_000 });
  if ((await picker.getAttribute("data-chat-scope")) !== "project") {
    throw new Error("chat scope picker did not commit project authority");
  }
}

async function prepareCodexContextEntry(harness) {
  const prepared = await harness.launch("cross-feature-authoring/prepare");
  try {
    const projectId = await harness.waitUntil(async () => {
      const projectResult = await harness.invokeOk(
        prepared.page,
        "db_execute",
        {
          sql: "SELECT id FROM projects ORDER BY created_at LIMIT 1",
          params: [],
          method: "get",
        },
      );
      const id = String(projectResult?.rows?.[0]?.id ?? "");
      return id || null;
    }, "authoring workspace and project authority");
    const entryId = `product-codex-${Date.now()}`;
    const builtinCharacter = await queryRows(
      harness,
      prepared.page,
      `SELECT id FROM codex_types
        WHERE project_id = ? AND slug = 'character' LIMIT 1`,
      [projectId],
    );
    if (builtinCharacter.length !== 1) {
      throw new Error(
        `project '${projectId}' is missing its canonical character type`,
      );
    }
    await harness.invokeOk(prepared.page, "codex_create", {
      payload: {
        requestId: `product-codex-create-${entryId}`,
        eventUid: `product-codex-create-event:${entryId}`,
        origin: "human",
        authorityRoute: "human-direct",
        caller: "manual-wrapper",
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
        entryId,
        projectId,
        sessionId: "electron-product-journey",
        surface: "cross-feature-authoring",
        typeSlug: "character",
        name: "Product Journey Codex",
        summary: CODEX_CONTEXT_MARKER,
        content: sceneDocument(CODEX_CONTEXT_MARKER),
        aliases: null,
        excludedAliases: null,
        readings: null,
        tagsCache: null,
        parentId: null,
        sourceChatMessageId: null,
        model: null,
        chatMessageId: null,
        traceId: null,
        authorshipSpans: [],
      },
    });
    return { projectId, entryId };
  } finally {
    await harness.close(
      prepared.app,
      prepared.page,
      "cross-feature-authoring/prepare",
    );
  }
}

async function prepareCodexChatStreamEntries(harness, journeyId) {
  const prepared = await harness.launch(`${journeyId}/prepare`);
  try {
    const project = await currentProjectRow(harness, prepared.page);
    const projectId = String(project.id);
    const characterType = await queryRows(
      harness,
      prepared.page,
      `SELECT id FROM codex_types
       WHERE project_id = ? AND slug = 'character' LIMIT 1`,
      [projectId],
    );
    if (characterType.length !== 1) {
      throw new Error(
        `project '${projectId}' is missing its canonical character type`,
      );
    }

    const suffix = Date.now();
    const entries = [
      {
        id: `product-codex-chat-switch-${suffix}-a`,
        name: `Journey Codex A ${suffix}`,
        type: "character",
        marker: CODEX_CHAT_SWITCH_A_MARKER,
      },
      {
        id: `product-codex-chat-switch-${suffix}-b`,
        name: `Journey Codex B ${suffix}`,
        type: "character",
        marker: CODEX_CHAT_SWITCH_B_MARKER,
      },
    ];
    for (const entry of entries) {
      await harness.invokeOk(prepared.page, "codex_create", {
        payload: {
          requestId: `product-codex-create-${entry.id}`,
          eventUid: `product-codex-create-event:${entry.id}`,
          origin: "human",
          authorityRoute: "human-direct",
          caller: "manual-wrapper",
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
          entryId: entry.id,
          projectId,
          sessionId: "electron-product-journey",
          surface: "chat-stream-codex-switch-fixture",
          typeSlug: "character",
          name: entry.name,
          summary: entry.marker,
          content: sceneDocument(entry.marker),
          aliases: null,
          excludedAliases: null,
          readings: null,
          tagsCache: null,
          parentId: null,
          contextMode: "suppress",
          childrenBudget: null,
          sourceChatMessageId: null,
          model: null,
          chatMessageId: null,
          traceId: null,
          authorshipSpans: [],
        },
      });
    }
    return { projectId, entries };
  } finally {
    await harness.close(prepared.app, prepared.page, `${journeyId}/prepare`);
  }
}

async function sendChatPrompt(page, prompt) {
  const input = page
    .getByTestId("chat-input")
    .locator('.chat-input-prosemirror[contenteditable="true"]');
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.click();
  await page.keyboard.type(prompt);
  const send = page.getByTestId("chat-send");
  await send.waitFor({ state: "visible", timeout: 30_000 });
  await send.click();
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

async function commitExternalSceneWrite(
  harness,
  page,
  { projectId, sceneId, text, eventUid },
) {
  const now = Date.now();
  const content = sceneDocument(text);
  const rows = await queryRows(
    harness,
    page,
    "SELECT version FROM tree_nodes WHERE id = ? AND project_id = ?",
    [sceneId, projectId],
  );
  const baseVersion = Number(rows[0]?.version);
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new Error(
      `external scene write could not resolve base version: ${sceneId}`,
    );
  }
  await harness.invokeOk(page, "tree_node_patch", {
    payload: {
      projectId,
      requestId: eventUid,
      sessionId: "external-product-journey",
      eventUid,
      origin: "human",
      originalTransactionId: null,
      undoJournalId: null,
      nodeId: sceneId,
      updatedAt: new Date(now).toISOString(),
      patch: {
        content,
        charCount: text.length,
      },
      bumpVersion: true,
      baseVersion,
      changeEvent: {
        eventUid,
        sessionId: "external-product-journey",
        timestamp: now,
      },
    },
  });
  return content;
}

async function findSceneWithText(harness, page, text) {
  const result = await harness.invokeOk(page, "db_execute", {
    sql: "SELECT id, title, content FROM tree_nodes WHERE node_type = 'scene'",
    params: [],
    method: "all",
  });
  return (
    result?.rows?.find((row) => String(row?.content ?? "").includes(text)) ??
    null
  );
}

async function createSceneThroughUi(harness, page) {
  const header = scenesPanelHeader(page);
  await header.waitFor({ state: "visible", timeout: 60_000 });
  const before = await harness.invokeOk(page, "db_execute", {
    sql: "SELECT id FROM tree_nodes WHERE node_type = 'scene'",
    params: [],
    method: "all",
  });
  const existingSceneIds = new Set(
    (before?.rows ?? []).map((row) => String(row.id)),
  );
  await header.locator(`button[title="${CREATE_BUTTON_TITLE}"]`).click();
  await page
    .getByRole("menuitem", { name: NEW_SCENE_MENU_ITEM, exact: true })
    .click();

  const renameInput = page.locator(
    '[data-droptarget-id="scenes-panel"] input:focus',
  );
  if (
    await renameInput
      .waitFor({ state: "visible", timeout: 1_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await page.keyboard.press("Enter");
  }

  const created = await harness.waitUntil(async () => {
    const result = await harness.invokeOk(page, "db_execute", {
      sql: `SELECT id, project_id AS projectId, title, content
        FROM tree_nodes
        WHERE node_type = 'scene'
        ORDER BY created_at DESC`,
      params: [],
      method: "all",
    });
    return (
      (result?.rows ?? []).find(
        (row) => !existingSceneIds.has(String(row.id)),
      ) ?? null
    );
  }, "new scene persistence");
  const sceneId = String(created.id);
  const editorSurface = page
    .locator(
      `[data-editor-loaded-document-id="${sceneId}"][data-editor-document-loading="false"]:visible`,
    )
    .last();
  await editorSurface.waitFor({ state: "visible", timeout: 30_000 });
  if (
    created.title !== DEFAULT_SCENE_TITLE &&
    !/^シーン \d+$/.test(String(created.title))
  ) {
    throw new Error(`unexpected new scene title: ${String(created.title)}`);
  }
  if (!created.projectId) {
    throw new Error("new scene did not expose its project authority");
  }

  const editor = editorSurface
    .locator('.ProseMirror[contenteditable="true"]')
    .first();
  await editor.waitFor({ state: "visible", timeout: 30_000 });
  return {
    sceneId,
    projectId: String(created.projectId),
    editorSurface,
    editor,
  };
}

async function runEditorPersistenceJourney(harness) {
  const workspace = harness.workspacePath("editor-persistence");
  await configureWorkspace(harness, workspace);

  const writing = await harness.launch("editor-persistence/write");
  let sceneId;
  try {
    const { sceneId: createdSceneId, editor } = await createSceneThroughUi(
      harness,
      writing.page,
    );
    sceneId = createdSceneId;
    await editor.click();
    await writing.page.keyboard.type(JOURNEY_TEXT, { delay: 10 });
    await harness.waitUntil(
      () => findSceneWithText(harness, writing.page, JOURNEY_TEXT),
      "editor autosave",
      30_000,
    );
    log("Editor persistence: autosave reached SQLite");
  } finally {
    await harness.close(writing.app, writing.page, "editor-persistence/write");
  }

  const restart = await harness.launch("editor-persistence/restart");
  try {
    const persisted = await harness.waitUntil(
      () => findSceneWithText(harness, restart.page, JOURNEY_TEXT),
      "persisted editor text after restart",
      30_000,
    );
    const pane = restart.page.locator(
      `[data-editor-loaded-document-id="${persisted.id}"][data-editor-document-loading="false"]`,
    );
    await pane.waitFor({ state: "visible", timeout: 30_000 });
    await pane
      .getByTestId("editor-content-loading")
      .waitFor({ state: "detached", timeout: 30_000 });
    await pane
      .locator(`.ProseMirror:has-text("${JOURNEY_TEXT}")`)
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    log("Editor persistence: restart restored DB and UI content");
  } finally {
    await harness.close(
      restart.app,
      restart.page,
      "editor-persistence/restart",
    );
  }
}

async function runWorkspaceSwitchAuthorityJourney(harness) {
  const workspaceA = harness.workspacePath("workspace-a");
  const workspaceB = harness.workspacePath("workspace-b");
  await configureWorkspace(harness, workspaceA, {
    appSettings: {
      "editor.autoSaveDelay": PENDING_SAVE_AUTOSAVE_DELAY_MS,
    },
    additionalWorkspaces: [workspaceB],
  });

  const switched = await harness.launch("workspace-switch/pending-save");
  try {
    const { sceneId, editor } = await createSceneThroughUi(
      harness,
      switched.page,
    );
    await editor.click();
    await switched.page.keyboard.type(PENDING_SAVE_TEXT);
    const persistedBeforeSwitch = Boolean(
      await findSceneWithText(harness, switched.page, PENDING_SAVE_TEXT),
    );
    if (persistedBeforeSwitch) {
      throw new Error(
        "pending-save journey persisted before the workspace boundary",
      );
    }
    harness.recordTimeline("pending-editor-draft", {
      workspace: workspaceA,
      workspaceOpenRevision: await workspaceOpenRevision(switched.page),
      sceneId,
      autosaveDelayMs: PENDING_SAVE_AUTOSAVE_DELAY_MS,
      persistedBeforeSwitch,
    });

    await switched.page.getByTestId("workspace-menu-trigger").click();
    const dropdown = switched.page.getByTestId("workspace-menu-dropdown");
    await dropdown
      .getByRole("button", { name: "workspace-b", exact: true })
      .click();
    await harness.waitUntil(
      async () =>
        (
          await switched.page
            .getByTestId("workspace-menu-trigger")
            .textContent()
        )?.includes("workspace-b"),
      "workspace B UI authority",
      30_000,
    );
    const leakedIntoWorkspaceB = Boolean(
      await findSceneWithText(harness, switched.page, PENDING_SAVE_TEXT),
    );
    if (leakedIntoWorkspaceB) {
      throw new Error("workspace B received workspace A pending editor text");
    }
    harness.recordTimeline("workspace-switch-committed", {
      from: workspaceA,
      to: workspaceB,
      workspaceOpenRevision: await workspaceOpenRevision(switched.page),
      sceneId,
      leakedIntoWorkspaceB,
    });

    await switched.page.getByTestId("workspace-menu-trigger").click();
    await switched.page
      .getByTestId("workspace-menu-dropdown")
      .getByRole("button", { name: "workspace-a", exact: true })
      .click();
    const persisted = await harness.waitUntil(
      () => findSceneWithText(harness, switched.page, PENDING_SAVE_TEXT),
      "workspace A pending save after reopening",
      30_000,
    );
    if (persisted.id !== sceneId) {
      throw new Error("workspace A restored pending text under another scene");
    }
    const pane = switched.page.locator(
      `[data-editor-loaded-document-id="${sceneId}"][data-editor-document-loading="false"]`,
    );
    await pane.waitFor({ state: "visible", timeout: 30_000 });
    await pane
      .locator(`.ProseMirror:has-text("${PENDING_SAVE_TEXT}")`)
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    harness.recordTimeline("pending-editor-draft-restored", {
      workspace: workspaceA,
      workspaceOpenRevision: await workspaceOpenRevision(switched.page),
      sceneId,
      persistedAfterReturn: true,
    });
    log(
      "Workspace switch authority: quiescence drained pending save without cross-DB leakage",
    );
  } finally {
    await harness.close(
      switched.app,
      switched.page,
      "workspace-switch/pending-save",
    );
  }
}

async function runChatAuthorityIsolationJourney(harness) {
  const workspace = harness.workspacePath("chat-authority-isolation");
  await configureWorkspace(harness, workspace, {
    deterministicAi: true,
  });

  const chat = await harness.launch("chat-authority-isolation");
  try {
    const sceneA = await createSceneThroughUi(harness, chat.page);
    await sendChatPrompt(chat.page, CHAT_AUTHORITY_PROMPT);
    await chat.page
      .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
      .last()
      .waitFor({ state: "visible", timeout: 30_000 });
    harness.recordTimeline("chat-stream-started", {
      workspace,
      workspaceOpenRevision: await workspaceOpenRevision(chat.page),
      projectId: sceneA.projectId,
      sceneId: sceneA.sceneId,
      earlyChunkVisible: true,
    });

    const sceneB = await createSceneThroughUi(harness, chat.page);
    if (sceneB.sceneId === sceneA.sceneId) {
      throw new Error("chat authority journey did not change scene scope");
    }
    harness.recordTimeline("chat-scope-switched", {
      workspace,
      workspaceOpenRevision: await workspaceOpenRevision(chat.page),
      projectId: sceneA.projectId,
      fromSceneId: sceneA.sceneId,
      toSceneId: sceneB.sceneId,
    });

    // The deterministic provider publishes one in-flight late chunk four
    // seconds after the switch, even when abort has already been requested.
    await chat.page.waitForTimeout(4_500);
    const rows = await harness.waitUntil(async () => {
      const current = await listChatAuthorityRows(
        harness,
        chat.page,
        sceneA.projectId,
      );
      return current.some(
        (row) =>
          row.nodeId === sceneA.sceneId &&
          row.role === "user" &&
          String(row.content).includes(CHAT_AUTHORITY_PROMPT),
      )
        ? current
        : null;
    }, "scene A chat persistence");

    const sceneBLeaks = rows.filter(
      (row) =>
        row.nodeId === sceneB.sceneId &&
        (String(row.content ?? "").includes(CHAT_AUTHORITY_EARLY) ||
          String(row.content ?? "").includes(CHAT_AUTHORITY_LATE) ||
          String(row.systemPrompt ?? "").includes(CHAT_AUTHORITY_PROMPT)),
    );
    if (sceneBLeaks.length > 0) {
      throw new Error(
        "scene B received a stale chunk, prompt snapshot, or session mutation",
      );
    }
    if (rows.some((row) => row.nodeId === sceneB.sceneId)) {
      throw new Error("scene B received the old stream session authority");
    }
    if (
      (await chat.page
        .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
        .count()) > 0 ||
      (await chat.page
        .getByText(CHAT_AUTHORITY_LATE, { exact: false })
        .count()) > 0
    ) {
      throw new Error("scene B UI retained stale stream content");
    }

    const promptRows = rows.filter((row) => row.systemPrompt != null);
    if (
      promptRows.length === 0 ||
      promptRows.some((row) => row.nodeId !== sceneA.sceneId)
    ) {
      throw new Error("chat prompt snapshot escaped scene A authority");
    }
    harness.recordTimeline("chat-late-chunk-isolated", {
      workspace,
      workspaceOpenRevision: await workspaceOpenRevision(chat.page),
      projectId: sceneA.projectId,
      fromSceneId: sceneA.sceneId,
      toSceneId: sceneB.sceneId,
      staleChunkInNewScope: false,
      promptSnapshotInNewScope: false,
      sessionMutationInNewScope: false,
    });
    log(
      "Chat authority isolation: late chunk, prompt snapshot, and session stayed in scene A",
    );
  } finally {
    await harness.close(chat.app, chat.page, "chat-authority-isolation");
  }
}

async function createFolderThroughUi(harness, page) {
  const header = scenesPanelHeader(page);
  await header.waitFor({ state: "visible", timeout: 60_000 });
  const before = await queryRows(
    harness,
    page,
    "SELECT id FROM tree_nodes WHERE node_type = 'folder'",
  );
  const existingFolderIds = new Set(before.map((row) => String(row.id)));
  await header.locator(`button[title="${CREATE_BUTTON_TITLE}"]`).click();
  await page
    .getByRole("menuitem", { name: NEW_FOLDER_MENU_ITEM, exact: true })
    .click();

  const renameInput = page.locator(
    '[data-droptarget-id="scenes-panel"] input:focus',
  );
  if (
    await renameInput
      .waitFor({ state: "visible", timeout: 1_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await page.keyboard.press("Enter");
  }

  const created = await harness.waitUntil(async () => {
    const rows = await queryRows(
      harness,
      page,
      `SELECT id, project_id AS projectId, title
       FROM tree_nodes
       WHERE node_type = 'folder'
       ORDER BY created_at DESC`,
    );
    return rows.find((row) => !existingFolderIds.has(String(row.id))) ?? null;
  }, "new folder persistence");
  if (!created.projectId) {
    throw new Error("new folder did not expose its project authority");
  }
  return {
    folderId: String(created.id),
    projectId: String(created.projectId),
    title: String(created.title),
  };
}

async function selectChatFolder(harness, page, folder) {
  const picker = page.getByTestId("chat-scope-picker");
  await picker.click();
  const pickerLabel = await picker.getAttribute("aria-label");
  if (!pickerLabel)
    throw new Error("chat scope picker has no accessible label");
  await page
    .getByRole("tablist", { name: pickerLabel })
    .locator("xpath=..")
    .getByRole("button", { name: folder.title, exact: true })
    .click();
  await harness.waitUntil(async () => {
    const label = await picker.textContent();
    return (
      (await picker.getAttribute("data-chat-scope")) === "folder" &&
      String(label ?? "").includes(folder.title)
    );
  }, `chat folder scope ${folder.title}`);
}

async function setSnippetPanelOpen(harness, page, open) {
  const toggle = page.getByTestId("panel-toggle-root").getByRole("button");
  await toggle.click();
  const item = page.getByTestId("panel-toggle-item-snippets");
  const isOpen = (await item.getAttribute("aria-pressed")) === "true";
  if (isOpen !== open) {
    await item.focus();
    await page.keyboard.press("Space");
  }
  await toggle.click();
  await harness.waitUntil(
    async () => {
      const visible = await page
        .getByTestId("snippet-panel")
        .isVisible()
        .catch(() => false);
      return visible === open;
    },
    `Snippet panel ${open ? "opened" : "closed"}`,
  );
}

async function createSnippetThroughUi(harness, page, title) {
  const project = await currentProjectRow(harness, page);
  const existing = new Set(
    (
      await queryRows(
        harness,
        page,
        "SELECT id FROM snippets WHERE project_id = ?",
        [project.id],
      )
    ).map((row) => String(row.id)),
  );
  await setSnippetPanelOpen(harness, page, true);
  await page.getByTestId("snippet-new-button").click();
  const snippet = await harness.waitUntil(async () => {
    const rows = await queryRows(
      harness,
      page,
      `SELECT id, project_id AS projectId, title
       FROM snippets WHERE project_id = ? ORDER BY created_at DESC`,
      [project.id],
    );
    return rows.find((row) => !existing.has(String(row.id))) ?? null;
  }, "new Snippet persistence");
  await page.getByTestId("snippet-detail-title").fill(title);
  await harness.waitUntil(async () => {
    const rows = await queryRows(
      harness,
      page,
      "SELECT title FROM snippets WHERE id = ? AND project_id = ?",
      [snippet.id, project.id],
    );
    return rows[0]?.title === title;
  }, `Snippet title ${title}`);
  await setSnippetPanelOpen(harness, page, false);
  return {
    snippetId: String(snippet.id),
    projectId: String(snippet.projectId),
    title,
  };
}

async function selectChatCodex(harness, page, entry) {
  const picker = page.getByTestId("chat-scope-picker");
  await picker.click();
  const pickerLabel = await picker.getAttribute("aria-label");
  if (!pickerLabel)
    throw new Error("chat scope picker has no accessible label");
  const codexTab = page
    .getByRole("tablist", { name: pickerLabel })
    .getByRole("tab")
    .nth(1);
  if ((await codexTab.getAttribute("aria-selected")) !== "true") {
    await codexTab.focus();
    await codexTab.press("Enter");
  }
  const pickerContent = page
    .getByRole("tablist", { name: pickerLabel })
    .locator("xpath=..");
  await pickerContent
    .getByRole("button", {
      name: `${entry.name} ${entry.type}`,
      exact: true,
    })
    .click();
  await harness.waitUntil(async () => {
    const label = await picker.textContent();
    return (
      (await picker.getAttribute("data-chat-scope")) === "codex" &&
      String(label ?? "").includes(entry.name)
    );
  }, `chat Codex scope ${entry.name}`);
}

async function selectChatSnippet(harness, page, snippet) {
  const picker = page.getByTestId("chat-scope-picker");
  await picker.click();
  const pickerLabel = await picker.getAttribute("aria-label");
  if (!pickerLabel)
    throw new Error("chat scope picker has no accessible label");
  const tabs = page
    .getByRole("tablist", { name: pickerLabel })
    .getByRole("tab");
  const snippetTab = tabs.nth(2);
  if ((await snippetTab.getAttribute("aria-selected")) !== "true") {
    await snippetTab.focus();
    await snippetTab.press("Enter");
  }
  const snippetOption = page.getByRole("button", {
    name: snippet.title,
    exact: true,
  });
  await snippetOption.focus();
  await snippetOption.press("Enter");
  await harness.waitUntil(async () => {
    const label = await picker.textContent();
    return (
      (await picker.getAttribute("data-chat-scope")) === "snippet" &&
      String(label ?? "").includes(snippet.title)
    );
  }, `chat Snippet scope ${snippet.title}`);
}

async function runFolderStreamSwitchJourney(harness, laneContext) {
  const workspace = harness.workspacePath("chat-stream-folder-switch");
  await configureWorkspace(harness, workspace, { deterministicAi: true });

  const chat = await harness.launch("chat-stream-folder-switch");
  try {
    const project = await currentProjectRow(harness, chat.page);
    const folderA = await createFolderThroughUi(harness, chat.page);
    const folderB = await createFolderThroughUi(harness, chat.page);
    if (
      folderA.folderId === folderB.folderId ||
      folderA.projectId !== String(project.id) ||
      folderB.projectId !== String(project.id)
    ) {
      throw new Error(
        "folder chat journey did not create distinct same-project folders",
      );
    }
    await selectChatFolder(harness, chat.page, folderA);
    await sendChatPrompt(chat.page, FOLDER_CHAT_SWITCH_PROMPT);
    await chat.page
      .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
      .last()
      .waitFor({ state: "visible", timeout: 30_000 });

    const preparedAudit = await harness.waitUntil(async () => {
      const rows = await queryRows(
        harness,
        chat.page,
        `SELECT execution_id AS executionId, payload
         FROM ai_audit_events
         WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
           AND event_type = 'request.prepared'
         ORDER BY sequence DESC LIMIT 1`,
        [project.id],
      );
      return String(rows[0]?.payload ?? "").includes(FOLDER_CHAT_SWITCH_PROMPT)
        ? rows[0]
        : null;
    }, "folder A chat request prepared");
    await harness.waitUntil(
      async () =>
        (
          await queryRows(
            harness,
            chat.page,
            `SELECT sequence
             FROM ai_audit_events
             WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
               AND execution_id = ? AND event_type = 'request.dispatched'`,
            [project.id, preparedAudit.executionId],
          )
        ).length === 1,
      "folder A chat request dispatched",
    );
    const completionBeforeSwitch = await queryRows(
      harness,
      chat.page,
      `SELECT sequence
       FROM ai_audit_events
       WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
         AND execution_id = ? AND event_type = 'response.completed'`,
      [project.id, preparedAudit.executionId],
    );
    if (completionBeforeSwitch.length !== 0) {
      throw new Error("folder A chat stream completed before switching to B");
    }
    harness.recordTimeline("folder-chat-stream-started", {
      workspace,
      projectId: project.id,
      folderAId: folderA.folderId,
      folderBId: folderB.folderId,
      executionId: preparedAudit.executionId,
      pathId: "chat_stream_non_agent",
      earlyChunkVisible: true,
      responseStillPending: true,
    });

    await selectChatFolder(harness, chat.page, folderB);
    const staleUiBeforeCompletion =
      (await chat.page
        .getByText(FOLDER_CHAT_SWITCH_PROMPT, { exact: false })
        .count()) > 0 ||
      (await chat.page
        .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
        .count()) > 0;
    const completionAfterSwitch = await queryRows(
      harness,
      chat.page,
      `SELECT sequence
       FROM ai_audit_events
       WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
         AND execution_id = ? AND event_type = 'response.completed'`,
      [project.id, preparedAudit.executionId],
    );
    if (staleUiBeforeCompletion || completionAfterSwitch.length !== 0) {
      throw new Error(
        "folder B did not become an isolated visible scope while folder A was pending",
      );
    }
    harness.recordTimeline("folder-chat-scope-switched", {
      workspace,
      projectId: project.id,
      fromFolderId: folderA.folderId,
      toFolderId: folderB.folderId,
      responseStillPending: true,
      oldContentVisibleInNewScope: false,
    });

    const auditEvents = await harness.waitUntil(async () => {
      const rows = await queryRows(
        harness,
        chat.page,
        `SELECT sequence, event_type AS eventType, payload
         FROM ai_audit_events
         WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
           AND execution_id = ?
         ORDER BY sequence`,
        [project.id, preparedAudit.executionId],
      );
      return rows.some((event) => event.eventType === "response.completed")
        ? rows
        : null;
    }, "folder A correlated chat terminal audit");
    const authorityRows = await harness.waitUntil(async () => {
      const rows = await listChatAuthorityRows(harness, chat.page, project.id);
      try {
        assertCompletedChatAuthority(
          rows.filter((row) => row.nodeId === folderA.folderId),
          { prompt: FOLDER_CHAT_SWITCH_PROMPT, label: "folder A chat" },
        );
        return rows;
      } catch {
        return null;
      }
    }, "folder A transcript and prompt snapshot persistence");

    const preparedEvent = auditEvents.find(
      (event) => event.eventType === "request.prepared",
    );
    const dispatchedEvent = auditEvents.find(
      (event) => event.eventType === "request.dispatched",
    );
    const completedEvents = auditEvents.filter(
      (event) => event.eventType === "response.completed",
    );
    if (
      !preparedEvent ||
      !dispatchedEvent ||
      completedEvents.length !== 1 ||
      !(preparedEvent.sequence < dispatchedEvent.sequence) ||
      !(dispatchedEvent.sequence < completedEvents[0].sequence) ||
      !String(completedEvents[0].payload ?? "").includes(
        CHAT_AUTHORITY_EARLY,
      ) ||
      !String(completedEvents[0].payload ?? "").includes(CHAT_AUTHORITY_LATE)
    ) {
      throw new Error("folder A terminal audit is incomplete or uncorrelated");
    }

    const folderARows = authorityRows.filter(
      (row) => row.nodeId === folderA.folderId,
    );
    const userRows = folderARows.filter(
      (row) =>
        row.role === "user" &&
        String(row.content ?? "").includes(FOLDER_CHAT_SWITCH_PROMPT),
    );
    const assistantRows = folderARows.filter(
      (row) =>
        row.role === "assistant" &&
        String(row.content ?? "").includes(CHAT_AUTHORITY_EARLY) &&
        String(row.content ?? "").includes(CHAT_AUTHORITY_LATE),
    );
    const ownerSessionIds = new Set(
      [...userRows, ...assistantRows].map((row) => String(row.sessionId)),
    );
    const folderBLeaks = chatAuthorityLeaks(
      authorityRows.filter((row) => row.nodeId === folderB.folderId),
      FOLDER_CHAT_SWITCH_PROMPT,
    );
    if (
      userRows.length !== 1 ||
      assistantRows.length !== 1 ||
      ownerSessionIds.size !== 1 ||
      folderBLeaks.length > 0
    ) {
      throw new Error(
        "folder A transcript ownership or folder B database isolation failed",
      );
    }

    await chat.page
      .getByTestId("chat-send")
      .waitFor({ state: "visible", timeout: 30_000 });
    const picker = chat.page.getByTestId("chat-scope-picker");
    if (
      (await picker.getAttribute("data-chat-scope")) !== "folder" ||
      !String(await picker.textContent()).includes(folderB.title) ||
      (await chat.page
        .getByText(FOLDER_CHAT_SWITCH_PROMPT, { exact: false })
        .count()) > 0 ||
      (await chat.page
        .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
        .count()) > 0 ||
      (await chat.page
        .getByText(CHAT_AUTHORITY_LATE, { exact: false })
        .count()) > 0
    ) {
      throw new Error(
        "folder B UI contains folder A chat content after completion",
      );
    }

    await selectChatFolder(harness, chat.page, folderA);
    await harness.waitUntil(
      async () =>
        (await chat.page
          .getByText(FOLDER_CHAT_SWITCH_PROMPT, { exact: false })
          .count()) > 0 &&
        (await chat.page
          .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
          .count()) > 0 &&
        (await chat.page
          .getByText(CHAT_AUTHORITY_LATE, { exact: false })
          .count()) > 0,
      "folder A persisted transcript restored on return",
    );
    harness.recordTimeline("folder-chat-stream-completed", {
      workspace,
      projectId: project.id,
      folderAId: folderA.folderId,
      folderBId: folderB.folderId,
      sessionId: [...ownerSessionIds][0],
      executionId: preparedAudit.executionId,
      terminalRecordsOwnedByFolderA: true,
      folderBDatabaseLeak: false,
      folderBUiLeak: false,
      folderARestoredOnReturn: true,
    });
    log(
      "Folder chat switch: pending stream terminal records stayed in folder A with no folder B transcript/UI leak",
    );
  } finally {
    await harness.close(chat.app, chat.page, "chat-stream-folder-switch");
  }
  const anchorScopeDiagnostics = await runIsolatedChatStreamAnchorScopeJourney(
    harness,
    "folder",
    laneContext,
  );
  return { anchorScopeDiagnostics };
}

async function runSnippetStreamSwitchJourney(harness, laneContext) {
  const journeyId = "chat-stream-snippet-switch";
  const workspace = harness.workspacePath(journeyId);
  await configureWorkspace(harness, workspace, { deterministicAi: true });

  const chat = await harness.launch(journeyId);
  try {
    const project = await currentProjectRow(harness, chat.page);
    const suffix = Date.now();
    const snippetA = await createSnippetThroughUi(
      harness,
      chat.page,
      `Journey Snippet A ${suffix}`,
    );
    const snippetB = await createSnippetThroughUi(
      harness,
      chat.page,
      `Journey Snippet B ${suffix}`,
    );
    if (
      snippetA.snippetId === snippetB.snippetId ||
      snippetA.projectId !== String(project.id) ||
      snippetB.projectId !== String(project.id)
    ) {
      throw new Error(
        "snippet chat journey did not create distinct same-project snippets",
      );
    }
    await selectChatSnippet(harness, chat.page, snippetA);
    await sendChatPrompt(chat.page, SNIPPET_CHAT_SWITCH_PROMPT);
    await chat.page
      .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
      .last()
      .waitFor({ state: "visible", timeout: 30_000 });

    const preparedAudit = await harness.waitUntil(async () => {
      const rows = await queryRows(
        harness,
        chat.page,
        `SELECT execution_id AS executionId, payload
         FROM ai_audit_events
         WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
           AND event_type = 'request.prepared'
         ORDER BY sequence DESC LIMIT 1`,
        [project.id],
      );
      return String(rows[0]?.payload ?? "").includes(SNIPPET_CHAT_SWITCH_PROMPT)
        ? rows[0]
        : null;
    }, "snippet A chat request prepared");
    await harness.waitUntil(
      async () =>
        (
          await queryRows(
            harness,
            chat.page,
            `SELECT sequence
             FROM ai_audit_events
             WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
               AND execution_id = ? AND event_type = 'request.dispatched'`,
            [project.id, preparedAudit.executionId],
          )
        ).length === 1,
      "snippet A chat request dispatched",
    );
    const completionBeforeSwitch = await queryRows(
      harness,
      chat.page,
      `SELECT sequence
       FROM ai_audit_events
       WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
         AND execution_id = ? AND event_type = 'response.completed'`,
      [project.id, preparedAudit.executionId],
    );
    if (completionBeforeSwitch.length !== 0) {
      throw new Error("snippet A chat stream completed before switching to B");
    }
    harness.recordTimeline("snippet-chat-stream-started", {
      workspace,
      projectId: project.id,
      snippetAId: snippetA.snippetId,
      snippetBId: snippetB.snippetId,
      executionId: preparedAudit.executionId,
      pathId: "chat_stream_non_agent",
      earlyChunkVisible: true,
      responseStillPending: true,
    });

    await selectChatSnippet(harness, chat.page, snippetB);
    const staleUiBeforeCompletion =
      (await chat.page
        .getByText(SNIPPET_CHAT_SWITCH_PROMPT, { exact: false })
        .count()) > 0 ||
      (await chat.page
        .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
        .count()) > 0;
    const completionAfterSwitch = await queryRows(
      harness,
      chat.page,
      `SELECT sequence
       FROM ai_audit_events
       WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
         AND execution_id = ? AND event_type = 'response.completed'`,
      [project.id, preparedAudit.executionId],
    );
    if (staleUiBeforeCompletion || completionAfterSwitch.length !== 0) {
      throw new Error(
        "snippet B did not become isolated while snippet A was pending",
      );
    }
    harness.recordTimeline("snippet-chat-scope-switched", {
      workspace,
      projectId: project.id,
      fromSnippetId: snippetA.snippetId,
      toSnippetId: snippetB.snippetId,
      responseStillPending: true,
      oldContentVisibleInNewScope: false,
    });

    const auditEvents = await harness.waitUntil(async () => {
      const rows = await queryRows(
        harness,
        chat.page,
        `SELECT sequence, event_type AS eventType, payload
         FROM ai_audit_events
         WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
           AND execution_id = ?
         ORDER BY sequence`,
        [project.id, preparedAudit.executionId],
      );
      return rows.some((event) => event.eventType === "response.completed")
        ? rows
        : null;
    }, "snippet A correlated chat terminal audit");
    const authorityRows = await harness.waitUntil(async () => {
      const rows = await listChatAuthorityRows(harness, chat.page, project.id);
      try {
        assertCompletedChatAuthority(
          rows.filter((row) => row.snippetAnchorId === snippetA.snippetId),
          { prompt: SNIPPET_CHAT_SWITCH_PROMPT, label: "snippet A chat" },
        );
        return rows;
      } catch {
        return null;
      }
    }, "snippet A transcript and prompt snapshot persistence");

    const preparedEvent = auditEvents.find(
      (event) => event.eventType === "request.prepared",
    );
    const dispatchedEvent = auditEvents.find(
      (event) => event.eventType === "request.dispatched",
    );
    const completedEvents = auditEvents.filter(
      (event) => event.eventType === "response.completed",
    );
    if (
      !preparedEvent ||
      !dispatchedEvent ||
      completedEvents.length !== 1 ||
      !(preparedEvent.sequence < dispatchedEvent.sequence) ||
      !(dispatchedEvent.sequence < completedEvents[0].sequence) ||
      !String(completedEvents[0].payload ?? "").includes(
        CHAT_AUTHORITY_EARLY,
      ) ||
      !String(completedEvents[0].payload ?? "").includes(CHAT_AUTHORITY_LATE)
    ) {
      throw new Error("snippet A terminal audit is incomplete or uncorrelated");
    }

    const snippetARows = authorityRows.filter(
      (row) => row.snippetAnchorId === snippetA.snippetId,
    );
    const userRows = snippetARows.filter(
      (row) =>
        row.role === "user" &&
        String(row.content ?? "").includes(SNIPPET_CHAT_SWITCH_PROMPT),
    );
    const assistantRows = snippetARows.filter(
      (row) =>
        row.role === "assistant" &&
        String(row.content ?? "").includes(CHAT_AUTHORITY_EARLY) &&
        String(row.content ?? "").includes(CHAT_AUTHORITY_LATE),
    );
    const ownerSessionIds = new Set(
      [...userRows, ...assistantRows].map((row) => String(row.sessionId)),
    );
    const snippetBLeaks = chatAuthorityLeaks(
      authorityRows.filter((row) => row.snippetAnchorId === snippetB.snippetId),
      SNIPPET_CHAT_SWITCH_PROMPT,
    );
    if (
      userRows.length !== 1 ||
      assistantRows.length !== 1 ||
      ownerSessionIds.size !== 1 ||
      snippetARows.some((row) => row.nodeId != null) ||
      snippetBLeaks.length > 0
    ) {
      throw new Error(
        "snippet A transcript ownership or snippet B database isolation failed",
      );
    }

    await chat.page
      .getByTestId("chat-send")
      .waitFor({ state: "visible", timeout: 30_000 });
    const picker = chat.page.getByTestId("chat-scope-picker");
    if (
      (await picker.getAttribute("data-chat-scope")) !== "snippet" ||
      !String(await picker.textContent()).includes(snippetB.title) ||
      (await chat.page
        .getByText(SNIPPET_CHAT_SWITCH_PROMPT, { exact: false })
        .count()) > 0 ||
      (await chat.page
        .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
        .count()) > 0 ||
      (await chat.page
        .getByText(CHAT_AUTHORITY_LATE, { exact: false })
        .count()) > 0
    ) {
      throw new Error(
        "snippet B UI contains snippet A chat content after completion",
      );
    }

    await selectChatSnippet(harness, chat.page, snippetA);
    await harness.waitUntil(
      async () =>
        (await chat.page
          .getByText(SNIPPET_CHAT_SWITCH_PROMPT, { exact: false })
          .count()) > 0 &&
        (await chat.page
          .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
          .count()) > 0 &&
        (await chat.page
          .getByText(CHAT_AUTHORITY_LATE, { exact: false })
          .count()) > 0,
      "snippet A persisted transcript restored on return",
    );
    harness.recordTimeline("snippet-chat-stream-completed", {
      workspace,
      projectId: project.id,
      snippetAId: snippetA.snippetId,
      snippetBId: snippetB.snippetId,
      sessionId: [...ownerSessionIds][0],
      executionId: preparedAudit.executionId,
      terminalRecordsOwnedBySnippetA: true,
      snippetBDatabaseLeak: false,
      snippetBUiLeak: false,
      snippetARestoredOnReturn: true,
    });
    log(
      "Snippet chat switch: pending stream terminal records stayed in snippet A with no snippet B transcript/UI leak",
    );
  } finally {
    await harness.close(chat.app, chat.page, journeyId);
  }
  const anchorScopeDiagnostics = await runIsolatedChatStreamAnchorScopeJourney(
    harness,
    "snippet",
    laneContext,
  );
  return { anchorScopeDiagnostics };
}

async function runCodexStreamSwitchJourney(harness, laneContext) {
  const journeyId = "chat-stream-codex-switch";
  const workspace = harness.workspacePath(journeyId);
  await configureWorkspace(harness, workspace, { deterministicAi: true });
  const prepared = await prepareCodexChatStreamEntries(harness, journeyId);
  const chat = await harness.launch(`${journeyId}/write`);
  try {
    const project = await currentProjectRow(harness, chat.page);
    const [codexA, codexB] = prepared.entries;
    if (
      String(project.id) !== prepared.projectId ||
      !codexA ||
      !codexB ||
      codexA.id === codexB.id
    ) {
      throw new Error("Codex chat journey lost distinct same-project anchors");
    }

    await selectChatCodex(harness, chat.page, codexA);
    await sendChatPrompt(chat.page, CODEX_CHAT_SWITCH_PROMPT);
    await chat.page
      .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
      .last()
      .waitFor({ state: "visible", timeout: 30_000 });

    const preparedAudit = await harness.waitUntil(async () => {
      const rows = await queryRows(
        harness,
        chat.page,
        `SELECT execution_id AS executionId, payload
         FROM ai_audit_events
         WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
           AND event_type = 'request.prepared'
         ORDER BY sequence DESC LIMIT 1`,
        [project.id],
      );
      return String(rows[0]?.payload ?? "").includes(CODEX_CHAT_SWITCH_PROMPT)
        ? rows[0]
        : null;
    }, "Codex A chat request prepared");
    await harness.waitUntil(
      async () =>
        (
          await queryRows(
            harness,
            chat.page,
            `SELECT sequence
             FROM ai_audit_events
             WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
               AND execution_id = ? AND event_type = 'request.dispatched'`,
            [project.id, preparedAudit.executionId],
          )
        ).length === 1,
      "Codex A chat request dispatched",
    );
    const completionBeforeSwitch = await queryRows(
      harness,
      chat.page,
      `SELECT sequence
       FROM ai_audit_events
       WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
         AND execution_id = ? AND event_type = 'response.completed'`,
      [project.id, preparedAudit.executionId],
    );
    if (completionBeforeSwitch.length !== 0) {
      throw new Error("Codex A chat stream completed before switching to B");
    }
    if (
      !String(preparedAudit.payload).includes(CODEX_CHAT_SWITCH_A_MARKER) ||
      String(preparedAudit.payload).includes(CODEX_CHAT_SWITCH_B_MARKER)
    ) {
      throw new Error(
        "Codex A audit request did not retain isolated A context",
      );
    }
    harness.recordTimeline("codex-chat-stream-started", {
      workspace,
      projectId: project.id,
      codexAId: codexA.id,
      codexBId: codexB.id,
      executionId: preparedAudit.executionId,
      pathId: "chat_stream_non_agent",
      earlyChunkVisible: true,
      responseStillPending: true,
      promptOwnedByCodexA: true,
    });

    await selectChatCodex(harness, chat.page, codexB);
    const staleUiBeforeCompletion =
      (await chat.page
        .getByText(CODEX_CHAT_SWITCH_PROMPT, { exact: false })
        .count()) > 0 ||
      (await chat.page
        .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
        .count()) > 0;
    const completionAfterSwitch = await queryRows(
      harness,
      chat.page,
      `SELECT sequence
       FROM ai_audit_events
       WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
         AND execution_id = ? AND event_type = 'response.completed'`,
      [project.id, preparedAudit.executionId],
    );
    if (staleUiBeforeCompletion || completionAfterSwitch.length !== 0) {
      throw new Error(
        "Codex B did not remain isolated while Codex A was pending",
      );
    }
    harness.recordTimeline("codex-chat-scope-switched", {
      workspace,
      projectId: project.id,
      fromCodexId: codexA.id,
      toCodexId: codexB.id,
      responseStillPending: true,
      oldContentVisibleInNewScope: false,
    });

    const auditEvents = await harness.waitUntil(async () => {
      const rows = await queryRows(
        harness,
        chat.page,
        `SELECT sequence, event_type AS eventType, payload
         FROM ai_audit_events
         WHERE project_id = ? AND path_id = 'chat_stream_non_agent'
           AND execution_id = ?
         ORDER BY sequence`,
        [project.id, preparedAudit.executionId],
      );
      return rows.some((event) => event.eventType === "response.completed")
        ? rows
        : null;
    }, "Codex A correlated chat terminal audit");
    const authorityRows = await harness.waitUntil(async () => {
      const rows = await listChatAuthorityRows(harness, chat.page, project.id);
      try {
        assertCompletedChatAuthority(
          rows.filter((row) => row.codexAnchorId === codexA.id),
          { prompt: CODEX_CHAT_SWITCH_PROMPT, label: "Codex A chat" },
        );
        return rows;
      } catch {
        return null;
      }
    }, "Codex A transcript and prompt snapshot persistence");

    const preparedEvent = auditEvents.find(
      (event) => event.eventType === "request.prepared",
    );
    const dispatchedEvent = auditEvents.find(
      (event) => event.eventType === "request.dispatched",
    );
    const completedEvents = auditEvents.filter(
      (event) => event.eventType === "response.completed",
    );
    if (
      !preparedEvent ||
      !dispatchedEvent ||
      completedEvents.length !== 1 ||
      !(preparedEvent.sequence < dispatchedEvent.sequence) ||
      !(dispatchedEvent.sequence < completedEvents[0].sequence) ||
      !String(completedEvents[0].payload ?? "").includes(
        CHAT_AUTHORITY_EARLY,
      ) ||
      !String(completedEvents[0].payload ?? "").includes(CHAT_AUTHORITY_LATE)
    ) {
      throw new Error("Codex A terminal audit is incomplete or uncorrelated");
    }

    const codexARows = authorityRows.filter(
      (row) => row.codexAnchorId === codexA.id,
    );
    const userRows = codexARows.filter(
      (row) =>
        row.role === "user" &&
        String(row.content ?? "").includes(CODEX_CHAT_SWITCH_PROMPT),
    );
    const assistantRows = codexARows.filter(
      (row) =>
        row.role === "assistant" &&
        String(row.content ?? "").includes(CHAT_AUTHORITY_EARLY) &&
        String(row.content ?? "").includes(CHAT_AUTHORITY_LATE),
    );
    const promptRows = userRows.filter((row) => row.systemPrompt != null);
    const promptSnapshot = String(promptRows[0]?.systemPrompt ?? "");
    const ownerSessionIds = new Set(
      [...userRows, ...assistantRows].map((row) => String(row.sessionId)),
    );
    const codexBRows = authorityRows.filter(
      (row) => row.codexAnchorId === codexB.id,
    );
    if (
      userRows.length !== 1 ||
      assistantRows.length !== 1 ||
      promptRows.length !== 1 ||
      !promptSnapshot.includes(CODEX_CHAT_SWITCH_A_MARKER) ||
      promptSnapshot.includes(CODEX_CHAT_SWITCH_B_MARKER) ||
      ownerSessionIds.size !== 1 ||
      codexARows.some(
        (row) => row.nodeId != null || row.snippetAnchorId != null,
      ) ||
      codexBRows.length > 0 ||
      String(preparedEvent.payload ?? "").includes(CODEX_CHAT_SWITCH_B_MARKER)
    ) {
      throw new Error(
        "Codex A transcript/prompt ownership or Codex B isolation failed",
      );
    }

    await chat.page
      .getByTestId("chat-send")
      .waitFor({ state: "visible", timeout: 30_000 });
    const picker = chat.page.getByTestId("chat-scope-picker");
    if (
      (await picker.getAttribute("data-chat-scope")) !== "codex" ||
      !String(await picker.textContent()).includes(codexB.name) ||
      (await chat.page
        .getByText(CODEX_CHAT_SWITCH_PROMPT, { exact: false })
        .count()) > 0 ||
      (await chat.page
        .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
        .count()) > 0 ||
      (await chat.page
        .getByText(CHAT_AUTHORITY_LATE, { exact: false })
        .count()) > 0
    ) {
      throw new Error(
        "Codex B UI contains Codex A chat content after completion",
      );
    }

    await selectChatCodex(harness, chat.page, codexA);
    await harness.waitUntil(
      async () =>
        (await chat.page
          .getByText(CODEX_CHAT_SWITCH_PROMPT, { exact: false })
          .count()) > 0 &&
        (await chat.page
          .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
          .count()) > 0 &&
        (await chat.page
          .getByText(CHAT_AUTHORITY_LATE, { exact: false })
          .count()) > 0,
      "Codex A persisted transcript restored on return",
    );
    harness.recordTimeline("codex-chat-stream-completed", {
      workspace,
      projectId: project.id,
      codexAId: codexA.id,
      codexBId: codexB.id,
      sessionId: [...ownerSessionIds][0],
      executionId: preparedAudit.executionId,
      terminalRecordsOwnedByCodexA: true,
      codexBDatabaseLeak: false,
      codexBUiLeak: false,
      codexARestoredOnReturn: true,
    });
    log(
      "Codex chat switch: pending stream records stayed in Codex A with no Codex B transcript/UI leak",
    );
  } finally {
    await harness.close(chat.app, chat.page, `${journeyId}/write`);
  }
  const anchorScopeDiagnostics = await runIsolatedChatStreamAnchorScopeJourney(
    harness,
    "codex",
    laneContext,
  );
  return { anchorScopeDiagnostics };
}

async function runChatStreamProjectSwitchJourney(harness) {
  const workspace = harness.workspacePath("chat-stream-project-switch");
  await configureWorkspace(harness, workspace, {
    deterministicAi: true,
  });
  const projects = await prepareSecondProject(harness, {
    phase: "chat-stream-project-switch",
    workspace,
    id: `product-chat-project-b-${Date.now()}`,
    title: "Product Chat Project B",
  });

  const chat = await harness.launch("chat-stream-project-switch");
  try {
    const sceneA = await createSceneThroughUi(harness, chat.page);
    if (sceneA.projectId !== projects.projectA.id) {
      throw new Error("project chat journey started under the wrong project");
    }
    await setProjectChatScope(chat.page);
    await sendChatPrompt(chat.page, PROJECT_CHAT_AUTHORITY_PROMPT);
    await chat.page
      .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
      .last()
      .waitFor({ state: "visible", timeout: 30_000 });
    harness.recordTimeline("project-chat-stream-started", {
      workspace,
      workspaceOpenRevision: await workspaceOpenRevision(chat.page),
      projectId: sceneA.projectId,
      sceneId: sceneA.sceneId,
      earlyChunkVisible: true,
    });

    await switchProjectThroughUi(
      harness,
      chat.page,
      projects.projectB,
      "project B UI authority after chat drain",
    );
    await assertLifecycleTransitionOrder(harness, chat.page, {
      kind: "project",
      from: {
        workspacePath: workspace,
        projectId: projects.projectA.id,
      },
      to: {
        workspacePath: workspace,
        projectId: projects.projectB.id,
      },
      label: "project chat switch",
    });
    await sceneA.editorSurface.waitFor({
      state: "detached",
      timeout: 30_000,
    });

    const projectARows = await harness.waitUntil(async () => {
      const rows = await listChatAuthorityRows(
        harness,
        chat.page,
        projects.projectA.id,
      );
      try {
        assertCompletedChatAuthority(rows, {
          prompt: PROJECT_CHAT_AUTHORITY_PROMPT,
          label: "project A stream",
        });
        return rows;
      } catch {
        return null;
      }
    }, "project A stream drain before project switch");
    const projectBRows = await listChatAuthorityRows(
      harness,
      chat.page,
      projects.projectB.id,
    );
    if (
      chatAuthorityLeaks(projectBRows, PROJECT_CHAT_AUTHORITY_PROMPT).length > 0
    ) {
      throw new Error(
        "project B received project A prompt, stream chunk, or prompt snapshot",
      );
    }
    await harness.waitUntil(
      async () =>
        (await chat.page
          .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
          .count()) === 0 &&
        (await chat.page
          .getByText(CHAT_AUTHORITY_LATE, { exact: false })
          .count()) === 0,
      "project B chat UI isolation",
    );
    harness.recordTimeline("project-chat-stream-drained", {
      workspace,
      workspaceOpenRevision: await workspaceOpenRevision(chat.page),
      fromProjectId: projects.projectA.id,
      toProjectId: projects.projectB.id,
      sessionIds: [
        ...new Set(projectARows.map((row) => String(row.sessionId))),
      ],
      oldScopeCompleted: true,
      newScopeLeak: false,
    });
    log(
      "Project chat switch: strict quiescence drained the old stream before authority commit",
    );
  } finally {
    await harness.close(chat.app, chat.page, "chat-stream-project-switch");
  }
}

async function runAgentStreamProjectSwitchJourney(harness) {
  const workspace = harness.workspacePath("agent-stream-project-switch");
  await configureWorkspace(harness, workspace, {
    deterministicAi: true,
  });
  const projects = await prepareSecondProject(harness, {
    phase: "agent-stream-project-switch",
    workspace,
    id: `product-agent-project-b-${Date.now()}`,
    title: "Product Agent Project B",
  });

  const chat = await harness.launch("agent-stream-project-switch");
  try {
    const sceneA = await createSceneThroughUi(harness, chat.page);
    if (sceneA.projectId !== projects.projectA.id) {
      throw new Error("Agent project journey started under the wrong project");
    }
    await setProjectChatScope(chat.page);
    const preparedAudit = await startAgentAuthorityTurn(
      harness,
      chat.page,
      projects.projectA.id,
      AGENT_PROJECT_SWITCH_PROMPT,
    );
    harness.recordTimeline("agent-project-switch-transport-started", {
      workspace,
      projectId: projects.projectA.id,
      executionId: preparedAudit.executionId,
      pathId: "chat_agent_main",
      transport: "send_agent_message",
    });

    await clickProjectSwitchDuringAgentTurn(
      chat.page,
      projects.projectB,
    );
    const transitionEvents = await harness.waitUntil(async () => {
      const events = await harness.readLifecycleTrace(chat.page);
      const matching = events.filter(
        (event) =>
          event.kind === "project" &&
          lifecycleScopeMatches(event.from, {
            workspacePath: workspace,
            projectId: projects.projectA.id,
          }) &&
          lifecycleScopeMatches(event.to, {
            workspacePath: workspace,
            projectId: projects.projectB.id,
          }),
      );
      return matching.some((event) => event.phase === "quiescence-started")
        ? matching
        : null;
    }, "Agent project switch entered strict quiescence");
    if (transitionEvents.some((event) => event.phase === "authority-commit")) {
      throw new Error(
        "project authority committed before Agent transport drained",
      );
    }
    const activeProject = await queryRows(
      harness,
      chat.page,
      "SELECT value FROM app_settings WHERE key = 'workspace.lastActiveProjectId'",
    );
    if (activeProject[0]?.value !== projects.projectA.id) {
      throw new Error(
        "project authority changed while Agent transport was pending",
      );
    }
    const earlyCompletion = await queryRows(
      harness,
      chat.page,
      `SELECT sequence
       FROM ai_audit_events
       WHERE project_id = ? AND path_id = 'chat_agent_main'
         AND execution_id = ? AND event_type = 'response.completed'`,
      [projects.projectA.id, preparedAudit.executionId],
    );
    if (earlyCompletion.length > 0) {
      throw new Error(
        "deterministic Agent response completed before switch quiescence",
      );
    }
    harness.recordTimeline("agent-project-switch-quiescence-blocked", {
      fromProjectId: projects.projectA.id,
      toProjectId: projects.projectB.id,
      authorityStayedWithOldProject: true,
      responseStillPending: true,
    });

    await harness.waitUntil(async () => {
      const active = await queryRows(
        harness,
        chat.page,
        "SELECT value FROM app_settings WHERE key = 'workspace.lastActiveProjectId'",
      );
      const triggerText = await chat.page
        .getByTestId("project-menu-trigger")
        .textContent();
      return (
        active[0]?.value === projects.projectB.id &&
        String(triggerText ?? "").includes(projects.projectB.title)
      );
    }, "project B UI authority after Agent transport drain");
    await sceneA.editorSurface.waitFor({ state: "detached", timeout: 30_000 });
    await assertLifecycleTransitionOrder(harness, chat.page, {
      kind: "project",
      from: {
        workspacePath: workspace,
        projectId: projects.projectA.id,
      },
      to: {
        workspacePath: workspace,
        projectId: projects.projectB.id,
      },
      label: "Agent project switch",
    });
    const projectARows = await harness.waitUntil(async () => {
      const rows = await listChatAuthorityRows(
        harness,
        chat.page,
        projects.projectA.id,
      );
      try {
        assertCompletedAgentAuthority(rows, {
          prompt: AGENT_PROJECT_SWITCH_PROMPT,
          outputMarker: AGENT_PROJECT_SWITCH_OUTPUT,
          label: "project A Agent turn",
        });
        return rows;
      } catch {
        return null;
      }
    }, "project A Agent transcript persistence");
    const completedAudit = await queryRows(
      harness,
      chat.page,
      `SELECT payload
       FROM ai_audit_events
       WHERE project_id = ? AND path_id = 'chat_agent_main'
         AND execution_id = ? AND event_type = 'response.completed'`,
      [projects.projectA.id, preparedAudit.executionId],
    );
    if (
      completedAudit.length !== 1 ||
      !String(completedAudit[0]?.payload ?? "").includes(
        AGENT_PROJECT_SWITCH_OUTPUT,
      )
    ) {
      throw new Error("Agent response audit did not remain under project A");
    }
    const projectBRows = await listChatAuthorityRows(
      harness,
      chat.page,
      projects.projectB.id,
    );
    if (
      agentAuthorityLeaks(
        projectBRows,
        AGENT_PROJECT_SWITCH_PROMPT,
        AGENT_PROJECT_SWITCH_OUTPUT,
      ).length > 0
    ) {
      throw new Error(
        "project B received project A Agent conversation content",
      );
    }
    const projectBAudit = await queryRows(
      harness,
      chat.page,
      `SELECT payload
       FROM ai_audit_events
       WHERE project_id = ? AND path_id = 'chat_agent_main'`,
      [projects.projectB.id],
    );
    if (
      projectBAudit.some((row) => {
        const payload = String(row.payload ?? "");
        return (
          payload.includes(AGENT_PROJECT_SWITCH_PROMPT) ||
          payload.includes(AGENT_PROJECT_SWITCH_OUTPUT)
        );
      })
    ) {
      throw new Error("project B received project A Agent audit content");
    }
    await harness.waitUntil(
      async () =>
        (await chat.page
          .getByText(AGENT_PROJECT_SWITCH_PROMPT, { exact: false })
          .count()) === 0 &&
        (await chat.page
          .getByText(AGENT_PROJECT_SWITCH_OUTPUT, { exact: false })
          .count()) === 0,
      "project B Agent UI isolation",
    );
    harness.recordTimeline("agent-project-switch-drained", {
      workspace,
      fromProjectId: projects.projectA.id,
      toProjectId: projects.projectB.id,
      executionId: preparedAudit.executionId,
      oldScopeCompleted: true,
      oldProjectTranscriptPersisted: projectARows.some(
        (row) =>
          row.role === "assistant" &&
          String(row.content ?? "").includes(AGENT_PROJECT_SWITCH_OUTPUT),
      ),
      newScopeLeak: false,
    });
    log(
      "Agent project switch: send_agent_message drained and persisted in project A before authority committed to project B",
    );
  } finally {
    await harness.close(chat.app, chat.page, "agent-stream-project-switch");
  }
}

async function runAgentStreamWorkspaceSwitchJourney(harness) {
  const workspaceA = harness.workspacePath("agent-workspace-a");
  const workspaceB = harness.workspacePath("agent-workspace-b");
  await configureWorkspace(harness, workspaceA, {
    deterministicAi: true,
    additionalWorkspaces: [workspaceB],
  });

  const chat = await harness.launch("agent-stream-workspace-switch");
  try {
    const sceneA = await createSceneThroughUi(harness, chat.page);
    await setProjectChatScope(chat.page);
    const preparedAudit = await startAgentAuthorityTurn(
      harness,
      chat.page,
      sceneA.projectId,
      AGENT_WORKSPACE_SWITCH_PROMPT,
    );

    const previousRevision = await workspaceOpenRevision(chat.page);
    harness.recordTimeline("agent-workspace-switch-transport-started", {
      workspace: workspaceA,
      workspaceOpenRevision: previousRevision,
      projectId: sceneA.projectId,
      executionId: preparedAudit.executionId,
      pathId: "chat_agent_main",
      transport: "send_agent_message",
    });
    await clickWorkspaceSwitchDuringAgentTurn(chat.page, workspaceB);

    const transitionEvents = await harness.waitUntil(async () => {
      const events = await harness.readLifecycleTrace(chat.page);
      const matching = events.filter(
        (event) =>
          event.kind === "workspace" &&
          lifecycleScopeMatches(event.from, {
            workspacePath: workspaceA,
            projectId: sceneA.projectId,
          }) &&
          lifecycleScopeMatches(event.to, { workspacePath: workspaceB }),
      );
      return matching.some((event) => event.phase === "quiescence-started")
        ? matching
        : null;
    }, "Agent workspace switch entered strict quiescence");
    if (transitionEvents.some((event) => event.phase === "authority-commit")) {
      throw new Error(
        "workspace authority committed before Agent transport drained",
      );
    }
    if ((await workspaceOpenRevision(chat.page)) !== previousRevision) {
      throw new Error(
        "workspace authority revision changed while Agent transport was pending",
      );
    }
    const workspaceTriggerText = await chat.page
      .getByTestId("workspace-menu-trigger")
      .textContent();
    if (
      !String(workspaceTriggerText ?? "").includes(path.basename(workspaceA))
    ) {
      throw new Error(
        "workspace A remained not visible as authority during Agent transport",
      );
    }
    harness.recordTimeline("agent-workspace-switch-quiescence-blocked", {
      fromWorkspace: workspaceA,
      toWorkspace: workspaceB,
      workspaceOpenRevision: previousRevision,
      authorityStayedWithOldWorkspace: true,
      responseStillPending: true,
    });

    await harness.waitUntil(async () => {
      const triggerText = await chat.page
        .getByTestId("workspace-menu-trigger")
        .textContent();
      return (
        String(triggerText ?? "").includes(path.basename(workspaceB)) &&
        (await workspaceOpenRevision(chat.page)) > previousRevision
      );
    }, "workspace B UI authority after Agent transport drain");
    await assertLifecycleTransitionOrder(harness, chat.page, {
      kind: "workspace",
      from: {
        workspacePath: workspaceA,
        projectId: sceneA.projectId,
      },
      to: { workspacePath: workspaceB },
      label: "Agent workspace switch",
    });

    const projectB = await currentProjectRow(harness, chat.page);
    const workspaceBRows = await listChatAuthorityRows(
      harness,
      chat.page,
      String(projectB.id),
    );
    if (
      agentAuthorityLeaks(
        workspaceBRows,
        AGENT_WORKSPACE_SWITCH_PROMPT,
        AGENT_WORKSPACE_SWITCH_OUTPUT,
      ).length > 0
    ) {
      throw new Error("workspace B received workspace A Agent conversation");
    }
    const workspaceBAudit = await queryRows(
      harness,
      chat.page,
      "SELECT payload FROM ai_audit_events WHERE path_id = 'chat_agent_main'",
    );
    if (
      workspaceBAudit.some((row) => {
        const payload = String(row.payload ?? "");
        return (
          payload.includes(AGENT_WORKSPACE_SWITCH_PROMPT) ||
          payload.includes(AGENT_WORKSPACE_SWITCH_OUTPUT)
        );
      })
    ) {
      throw new Error("workspace B received workspace A Agent audit content");
    }
    await harness.waitUntil(
      async () =>
        (await chat.page
          .getByText(AGENT_WORKSPACE_SWITCH_PROMPT, { exact: false })
          .count()) === 0 &&
        (await chat.page
          .getByText(AGENT_WORKSPACE_SWITCH_OUTPUT, { exact: false })
          .count()) === 0,
      "workspace B Agent UI isolation",
    );

    await switchWorkspaceThroughUi(
      harness,
      chat.page,
      workspaceA,
      "workspace A Agent authority after return",
    );
    const workspaceARows = await harness.waitUntil(async () => {
      const rows = await listChatAuthorityRows(
        harness,
        chat.page,
        sceneA.projectId,
      );
      try {
        assertCompletedAgentAuthority(rows, {
          prompt: AGENT_WORKSPACE_SWITCH_PROMPT,
          outputMarker: AGENT_WORKSPACE_SWITCH_OUTPUT,
          label: "workspace A Agent turn",
        });
        return rows;
      } catch {
        return null;
      }
    }, "workspace A Agent transcript persistence");
    const completedAudit = await queryRows(
      harness,
      chat.page,
      `SELECT payload
       FROM ai_audit_events
       WHERE project_id = ? AND path_id = 'chat_agent_main'
         AND execution_id = ? AND event_type = 'response.completed'`,
      [sceneA.projectId, preparedAudit.executionId],
    );
    if (
      completedAudit.length !== 1 ||
      !String(completedAudit[0]?.payload ?? "").includes(
        AGENT_WORKSPACE_SWITCH_OUTPUT,
      )
    ) {
      throw new Error("Agent response audit did not remain under workspace A");
    }
    harness.recordTimeline("agent-workspace-switch-drained", {
      from: workspaceA,
      to: workspaceB,
      workspaceOpenRevision: await workspaceOpenRevision(chat.page),
      projectId: sceneA.projectId,
      executionId: preparedAudit.executionId,
      oldScopeCompleted: true,
      oldWorkspaceTranscriptPersisted: workspaceARows.some(
        (row) =>
          row.role === "assistant" &&
          String(row.content ?? "").includes(AGENT_WORKSPACE_SWITCH_OUTPUT),
      ),
      newScopeLeak: false,
    });
    log(
      "Agent workspace switch: send_agent_message drained and persisted in workspace A before authority committed to workspace B",
    );
  } finally {
    await harness.close(chat.app, chat.page, "agent-stream-workspace-switch");
  }
}

async function runChatStreamWorkspaceSwitchJourney(harness) {
  const workspaceA = harness.workspacePath("chat-workspace-a");
  const workspaceB = harness.workspacePath("chat-workspace-b");
  await configureWorkspace(harness, workspaceA, {
    deterministicAi: true,
    additionalWorkspaces: [workspaceB],
  });

  const chat = await harness.launch("chat-stream-workspace-switch");
  try {
    const sceneA = await createSceneThroughUi(harness, chat.page);
    await sendChatPrompt(chat.page, WORKSPACE_CHAT_AUTHORITY_PROMPT);
    await chat.page
      .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
      .last()
      .waitFor({ state: "visible", timeout: 30_000 });
    harness.recordTimeline("workspace-chat-stream-started", {
      workspace: workspaceA,
      workspaceOpenRevision: await workspaceOpenRevision(chat.page),
      projectId: sceneA.projectId,
      sceneId: sceneA.sceneId,
      earlyChunkVisible: true,
    });

    await switchWorkspaceThroughUi(
      harness,
      chat.page,
      workspaceB,
      "workspace B UI authority after chat drain",
    );
    await assertLifecycleTransitionOrder(harness, chat.page, {
      kind: "workspace",
      from: {
        workspacePath: workspaceA,
        projectId: sceneA.projectId,
      },
      to: {
        workspacePath: workspaceB,
      },
      label: "workspace chat switch",
    });
    const projectB = await currentProjectRow(harness, chat.page);
    const workspaceBRows = await listChatAuthorityRows(
      harness,
      chat.page,
      String(projectB.id),
    );
    if (
      chatAuthorityLeaks(workspaceBRows, WORKSPACE_CHAT_AUTHORITY_PROMPT)
        .length > 0
    ) {
      throw new Error(
        "workspace B received workspace A prompt, stream chunk, or prompt snapshot",
      );
    }
    if (
      workspaceBRows.some(
        (row) =>
          String(row.sessionTitle ?? "") === WORKSPACE_CHAT_AUTHORITY_TITLE,
      )
    ) {
      throw new Error("workspace B received workspace A generated chat title");
    }
    await harness.waitUntil(
      async () =>
        (await chat.page
          .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
          .count()) === 0 &&
        (await chat.page
          .getByText(CHAT_AUTHORITY_LATE, { exact: false })
          .count()) === 0,
      "workspace B chat UI isolation",
    );

    await switchWorkspaceThroughUi(
      harness,
      chat.page,
      workspaceA,
      "workspace A chat authority after return",
    );
    const workspaceARows = await harness.waitUntil(async () => {
      const rows = await listChatAuthorityRows(
        harness,
        chat.page,
        sceneA.projectId,
      );
      try {
        assertCompletedChatAuthority(rows, {
          prompt: WORKSPACE_CHAT_AUTHORITY_PROMPT,
          label: "workspace A stream",
        });
        if (
          !rows.some(
            (row) =>
              String(row.sessionTitle ?? "") === WORKSPACE_CHAT_AUTHORITY_TITLE,
          )
        ) {
          throw new Error(
            "workspace A stream did not persist its generated chat title",
          );
        }
        return rows;
      } catch {
        return null;
      }
    }, "workspace A stream drain before workspace switch");
    harness.recordTimeline("workspace-chat-stream-drained", {
      from: workspaceA,
      to: workspaceB,
      workspaceOpenRevision: await workspaceOpenRevision(chat.page),
      fromProjectId: sceneA.projectId,
      toProjectId: String(projectB.id),
      sessionIds: [
        ...new Set(workspaceARows.map((row) => String(row.sessionId))),
      ],
      oldScopeCompleted: true,
      newScopeLeak: false,
    });
    log(
      "Workspace chat switch: strict quiescence drained the old stream without cross-database leakage",
    );
  } finally {
    await harness.close(chat.app, chat.page, "chat-stream-workspace-switch");
  }
}

async function prepareSnippetScopeAnchor(harness) {
  const prepared = await harness.launch("chat-stream-snippet-scope/prepare");
  try {
    const project = await currentProjectRow(harness, prepared.page);
    const snippetId = `product-snippet-${Date.now()}`;
    await harness.invokeOk(prepared.page, "snippet_create", {
      payload: {
        requestId: `product-snippet-create:${snippetId}`,
        projectId: String(project.id),
        sessionId: "electron-product-journey",
        eventUid: `product-snippet-create-event:${snippetId}`,
        origin: "human",
        authorityRoute: "human-direct",
        caller: "manual-wrapper",
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
        snippetId,
        title: "Product Journey Snippet",
        content: sceneDocument("Product Journey Snippet Context"),
        tagsCache: null,
        contentSource: "human",
        sceneId: null,
        sourceChatMessageId: null,
        canonicalPayload: {
          title: "Product Journey Snippet",
          sceneId: null,
        },
      },
    });
    return { projectId: String(project.id), anchorId: snippetId };
  } finally {
    await harness.close(
      prepared.app,
      prepared.page,
      "chat-stream-snippet-scope/prepare",
    );
  }
}

async function createFolderScopeAnchor(harness, page) {
  const title = "Product Journey Folder";
  const existing = new Set(
    (
      await queryRows(
        harness,
        page,
        "SELECT id FROM tree_nodes WHERE node_type = 'folder'",
      )
    ).map((row) => String(row.id)),
  );
  await scenesPanelHeader(page)
    .locator(`button[title="${CREATE_BUTTON_TITLE}"]`)
    .click();
  await page
    .getByRole("menuitem", { name: "New folder", exact: true })
    .evaluate((item) => item.click());
  const renameInput = page.locator(
    '[data-droptarget-id="scenes-panel"] input:focus',
  );
  await renameInput.waitFor({ state: "visible", timeout: 5_000 });
  await renameInput.fill(title);
  await renameInput.press("Enter");
  return harness.waitUntil(async () => {
    const rows = await queryRows(
      harness,
      page,
      "SELECT id, title FROM tree_nodes WHERE node_type = 'folder'",
    );
    return selectPersistedFolderScopeAnchor(rows, existing, title);
  }, "folder scope anchor persistence");
}

/** Keep the folder picker bound to the renamed row, not its initial title. */
export function selectPersistedFolderScopeAnchor(rows, existing, title) {
  return (
    rows.find(
      (row) => !existing.has(String(row.id)) && row.title === title,
    ) ?? null
  );
}

async function pickScopeAnchor(page, kind, title) {
  const picker = page.getByTestId("chat-scope-picker");
  await picker.click();
  if (kind !== "folder") {
    const tab = page.getByRole("tab", {
      name: kind === "codex" ? /Codex/ : /Snippet/i,
    });
    await tab.evaluate((button) => button.click());
  }
  await page
    .getByRole("button", { name: title, exact: kind === "folder" })
    .last()
    .click();
  return picker.getAttribute("data-chat-scope");
}

async function runChatStreamAnchorScopeJourney(harness, kind) {
  const phase = `chat-stream-${kind}-scope`;
  const workspace = harness.workspacePath(phase);
  await configureWorkspace(harness, workspace, { deterministicAi: true });
  let prepared = null;
  if (kind === "codex") {
    const codex = await prepareCodexContextEntry(harness);
    prepared = {
      projectId: codex.projectId,
      anchorId: codex.entryId,
      title: "Product Journey Codex",
    };
  } else if (kind === "snippet") {
    prepared = {
      ...(await prepareSnippetScopeAnchor(harness)),
      title: "Product Journey Snippet",
    };
  }
  const chat = await harness.launch(phase);
  try {
    const scene = await createSceneThroughUi(harness, chat.page);
    if (prepared && prepared.projectId !== scene.projectId) {
      throw new Error(`${kind} anchor belongs to a different project`);
    }
    if (kind === "folder") {
      const folder = await createFolderScopeAnchor(harness, chat.page);
      prepared = {
        projectId: scene.projectId,
        anchorId: String(folder.id),
        title: String(folder.title),
      };
    }
    const oldPrompt = `${CHAT_AUTHORITY_PROMPT}-${kind}`;
    await sendChatPrompt(chat.page, oldPrompt);
    await chat.page
      .getByText(CHAT_AUTHORITY_EARLY, { exact: false })
      .last()
      .waitFor({ state: "visible", timeout: 30_000 });
    harness.recordTimeline("anchor-chat-stream-started", {
      workspace,
      kind,
      sceneId: scene.sceneId,
      workspaceOpenRevision: await workspaceOpenRevision(chat.page),
    });
    const blockedScope = await pickScopeAnchor(chat.page, kind, prepared.title);
    if (blockedScope !== "scene") {
      throw new Error(`${kind} scope changed during the old stream`);
    }
    harness.recordTimeline("anchor-chat-switch-blocked-during-stream", {
      workspace,
      kind,
      oldScope: "scene",
      targetAnchorId: prepared.anchorId,
    });
    const oldRows = await harness.waitUntil(async () => {
      const rows = (
        await listChatAuthorityRows(harness, chat.page, scene.projectId)
      ).filter((row) => row.nodeId === scene.sceneId);
      try {
        assertCompletedChatAuthority(rows, {
          prompt: oldPrompt,
          label: `${kind} old scene stream`,
        });
        return rows;
      } catch {
        return null;
      }
    }, `${kind} old scene stream completion`);
    await chat.page
      .getByTestId("chat-send")
      .waitFor({ state: "visible", timeout: 30_000 });
    const committedScope = await pickScopeAnchor(
      chat.page,
      kind,
      prepared.title,
    );
    if (committedScope !== kind) {
      throw new Error(`${kind} scope did not commit after stream completion`);
    }
    const newPrompt = `${NEW_SCOPED_CHAT_PROMPT}-${kind}`;
    await sendChatPrompt(chat.page, newPrompt);
    const newRows = await harness.waitUntil(async () => {
      const rows = await listChatAuthorityRows(
        harness,
        chat.page,
        scene.projectId,
      );
      const scoped = rows.filter((row) =>
        kind === "folder"
          ? row.nodeId === prepared.anchorId
          : kind === "codex"
            ? row.codexAnchorId === prepared.anchorId
            : row.snippetAnchorId === prepared.anchorId,
      );
      try {
        assertCompletedChatAuthority(scoped, {
          prompt: newPrompt,
          label: `${kind} new scope stream`,
          outputMarkers:
            kind === "codex"
              ? [AUTHORING_OUTPUT]
              : [CHAT_AUTHORITY_EARLY, CHAT_AUTHORITY_LATE],
        });
        return scoped;
      } catch {
        return null;
      }
    }, `${kind} new scope persistence`);
    if (
      newRows.some((row) => String(row.content ?? "").includes(oldPrompt)) ||
      newRows.some((row) =>
        oldRows.some((old) => old.sessionId === row.sessionId),
      )
    ) {
      throw new Error(`${kind} scope reused the old stream session authority`);
    }
    harness.recordTimeline("anchor-chat-stream-isolated", {
      workspace,
      kind,
      fromSceneId: scene.sceneId,
      toAnchorId: prepared.anchorId,
      oldSessionIds: [...new Set(oldRows.map((row) => String(row.sessionId)))],
      newSessionIds: [...new Set(newRows.map((row) => String(row.sessionId)))],
      oldScopeCompleted: true,
      newScopeLeak: false,
    });
  } finally {
    await harness.close(chat.app, chat.page, phase);
  }
}

async function runIsolatedChatStreamAnchorScopeJourney(
  harness,
  kind,
  laneContext,
) {
  if (
    !laneContext?.signal ||
    typeof laneContext.registerChild !== "function" ||
    typeof laneContext.registerCleanup !== "function"
  ) {
    throw new Error(
      "isolated anchor-scope journey requires outer lane ownership",
    );
  }
  const name = `chat-stream-${kind}-scope`;
  const scopeHarness = createProductJourneyHarness({
    mainCjs: path.join(rootDir, "dist-electron", "main.cjs"),
    onChildProcess: laneContext.registerChild,
  });
  let succeeded = false;
  const nestedTask = (async () => {
    try {
      let operationError = null;
      let diagnostics;
      try {
        await scopeHarness.withLaneWatchdog(
          async () => {
            await runChatStreamAnchorScopeJourney(scopeHarness, kind);
            diagnostics = await scopeHarness.finalizeDiagnostics();
          },
          {
            phase: name,
            timeoutMs: PRODUCT_JOURNEY_LANE_WATCHDOG_TIMEOUT_MS,
            signal: laneContext.signal,
          },
        );
      } catch (error) {
        diagnostics = error?.diagnostics ?? scopeHarness.diagnostics();
        operationError = error;
      }
      harness.recordTimeline("nested-product-journey-diagnostics", {
        kind,
        diagnostics,
        passed: operationError === null,
      });
      if (operationError) {
        const error =
          operationError instanceof Error
            ? operationError
            : new Error(String(operationError), { cause: operationError });
        error.diagnostics = diagnostics;
        error.nestedDiagnostics = diagnostics;
        throw error;
      }
      succeeded = true;
      return diagnostics;
    } finally {
      await scopeHarness.dispose({ success: succeeded, name });
    }
  })();
  const unregisterCleanup = laneContext.registerCleanup(({ error }) => {
    const attachDiagnostics = (diagnostics) => {
      if (error && typeof error === "object") {
        error.diagnostics = diagnostics;
        error.nestedDiagnostics = diagnostics;
      }
    };
    attachDiagnostics(scopeHarness.diagnostics());
    return nestedTask.catch((nestedError) => {
      attachDiagnostics(
        nestedError?.nestedDiagnostics ??
          nestedError?.diagnostics ??
          scopeHarness.diagnostics(),
      );
    });
  });
  try {
    return await nestedTask;
  } finally {
    unregisterCleanup();
  }
}

async function runEditorPendingProjectSwitchJourney(harness) {
  const workspace = harness.workspacePath("editor-pending-project-switch");
  await configureWorkspace(harness, workspace, {
    appSettings: {
      "editor.autoSaveDelay": PENDING_SAVE_AUTOSAVE_DELAY_MS,
    },
  });
  const projects = await prepareSecondProject(harness, {
    phase: "editor-pending-project-switch",
    workspace,
    id: `product-editor-project-b-${Date.now()}`,
    title: "Product Editor Project B",
  });

  const switched = await harness.launch("editor-pending-project-switch");
  try {
    const sceneA = await createSceneThroughUi(harness, switched.page);
    if (sceneA.projectId !== projects.projectA.id) {
      throw new Error("pending editor journey started under the wrong project");
    }
    await sceneA.editor.click();
    await switched.page.keyboard.type(PENDING_PROJECT_SAVE_TEXT);
    if (
      await findSceneWithTextForProject(
        harness,
        switched.page,
        projects.projectA.id,
        PENDING_PROJECT_SAVE_TEXT,
      )
    ) {
      throw new Error(
        "pending editor project journey autosaved before the boundary",
      );
    }
    harness.recordTimeline("project-pending-editor-draft", {
      workspace,
      projectId: projects.projectA.id,
      sceneId: sceneA.sceneId,
      autosaveDelayMs: PENDING_SAVE_AUTOSAVE_DELAY_MS,
      persistedBeforeSwitch: false,
    });

    await switchProjectThroughUi(
      harness,
      switched.page,
      projects.projectB,
      "project B UI authority after pending editor drain",
    );
    const persistedAfterSwitch = await harness.waitUntil(async () => {
      const scene = await findSceneById(harness, switched.page, sceneA.sceneId);
      return String(scene?.content ?? "").includes(PENDING_PROJECT_SAVE_TEXT)
        ? scene
        : null;
    }, "project A pending editor save");
    if (persistedAfterSwitch.projectId !== projects.projectA.id) {
      throw new Error("pending editor text changed project ownership");
    }
    if (
      await findSceneWithTextForProject(
        harness,
        switched.page,
        projects.projectB.id,
        PENDING_PROJECT_SAVE_TEXT,
      )
    ) {
      throw new Error("project B received project A pending editor text");
    }
    await sceneA.editorSurface.waitFor({
      state: "detached",
      timeout: 30_000,
    });

    await switchProjectThroughUi(
      harness,
      switched.page,
      projects.projectA,
      "project A UI authority after return",
    );
    const restoredPane = switched.page.locator(
      `[data-editor-loaded-document-id="${sceneA.sceneId}"][data-editor-document-loading="false"]`,
    );
    await restoredPane.waitFor({ state: "visible", timeout: 30_000 });
    await restoredPane
      .locator(`.ProseMirror:has-text("${PENDING_PROJECT_SAVE_TEXT}")`)
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    harness.recordTimeline("project-pending-editor-restored", {
      workspace,
      projectId: projects.projectA.id,
      sceneId: sceneA.sceneId,
      persistedAfterSwitch: true,
      newProjectLeak: false,
      restoredAfterReturn: true,
    });
    log(
      "Project editor switch: strict quiescence drained pending text and restored the original scene",
    );
  } finally {
    await harness.close(
      switched.app,
      switched.page,
      "editor-pending-project-switch",
    );
  }
}

async function runExternalWriteConflictJourney(harness) {
  const workspace = harness.workspacePath("external-write-conflict");
  await configureWorkspace(harness, workspace, {
    appSettings: {
      "editor.autoSaveDelay": PENDING_SAVE_AUTOSAVE_DELAY_MS,
    },
  });

  const external = await harness.launch("external-write-conflict");
  let journeyFailure = null;
  try {
    const clean = await createSceneThroughUi(harness, external.page);
    await commitExternalSceneWrite(harness, external.page, {
      projectId: clean.projectId,
      sceneId: clean.sceneId,
      text: CLEAN_EXTERNAL_TEXT,
      eventUid: `product-clean-${Date.now()}`,
    });
    await clean.editor
      .locator(`text=${CLEAN_EXTERNAL_TEXT}`)
      .waitFor({ state: "visible", timeout: 30_000 });
    if (
      await clean.editorSurface.getByTestId("external-edit-conflict").count()
    ) {
      throw new Error("clean external write incorrectly opened a conflict");
    }
    harness.recordTimeline("clean-external-write-reloaded", {
      workspace,
      workspaceOpenRevision: await workspaceOpenRevision(external.page),
      projectId: clean.projectId,
      sceneId: clean.sceneId,
      persistedContentMatched: true,
    });

    const dirty = await createSceneThroughUi(harness, external.page);
    const undoButton = external.page.getByTestId("history-undo");
    await harness.waitUntil(
      async () => !(await undoButton.isDisabled()),
      "scene create undo history",
      10_000,
    );
    await dirty.editor.click();
    await external.page.keyboard.type(DIRTY_LOCAL_TEXT);
    if (await findSceneWithText(harness, external.page, DIRTY_LOCAL_TEXT)) {
      throw new Error("dirty external-write setup autosaved too early");
    }

    await commitExternalSceneWrite(harness, external.page, {
      projectId: dirty.projectId,
      sceneId: dirty.sceneId,
      text: DIRTY_EXTERNAL_TEXT,
      eventUid: `product-dirty-${Date.now()}`,
    });
    const conflict = dirty.editorSurface.getByTestId("external-edit-conflict");
    await conflict.waitFor({ state: "visible", timeout: 30_000 });
    if (!(await dirty.editor.textContent())?.includes(DIRTY_LOCAL_TEXT)) {
      throw new Error(
        "dirty editor was overwritten before conflict resolution",
      );
    }
    if (
      !(await findSceneWithText(harness, external.page, DIRTY_EXTERNAL_TEXT))
    ) {
      throw new Error("external dirty write did not reach SQLite");
    }
    await harness.waitUntil(
      () => undoButton.isDisabled(),
      "external write history invalidation",
      10_000,
    );
    harness.recordTimeline("dirty-external-write-conflict", {
      workspace,
      workspaceOpenRevision: await workspaceOpenRevision(external.page),
      projectId: dirty.projectId,
      sceneId: dirty.sceneId,
      localDraftPreserved: true,
      persistedExternalVersion: true,
      undoHistoryInvalidated: true,
    });

    await conflict.getByTestId("external-edit-reload").click();
    await dirty.editor
      .locator(`text=${DIRTY_EXTERNAL_TEXT}`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await conflict.waitFor({ state: "detached", timeout: 30_000 });
    if ((await dirty.editor.textContent())?.includes(DIRTY_LOCAL_TEXT)) {
      throw new Error("reload retained the rejected dirty editor content");
    }
    harness.recordTimeline("dirty-external-write-reloaded", {
      workspace,
      workspaceOpenRevision: await workspaceOpenRevision(external.page),
      projectId: dirty.projectId,
      sceneId: dirty.sceneId,
      persistedContentMatched: true,
    });
    log(
      "External write conflict: clean reload, dirty conflict, history invalidation, and reload passed",
    );
  } catch (error) {
    journeyFailure = error;
    throw error;
  } finally {
    if (journeyFailure && !external.page.isClosed()) {
      const visibleReload = external.page.locator(
        '[data-testid="external-edit-conflict"]:visible [data-testid="external-edit-reload"]',
      );
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if ((await visibleReload.count()) === 0) break;
        await visibleReload
          .first()
          .click()
          .then(() => external.page.waitForTimeout(250))
          .catch(() => undefined);
      }
    }
    try {
      await harness.close(
        external.app,
        external.page,
        "external-write-conflict",
      );
    } catch (closeError) {
      if (!journeyFailure) throw closeError;
      console.error(
        `[electron:product] external-write-conflict cleanup failed after the primary assertion: ${
          closeError instanceof Error ? closeError.message : String(closeError)
        }`,
      );
    }
  }
}

async function runMcpD2aEgressDenialJourney(harness) {
  const journeyId = "mcp-external-write-conflict";
  const workspace = harness.workspacePath(journeyId);
  await configureWorkspace(harness, workspace);

  const external = await harness.launch(journeyId);
  let mcpClient = null;
  let journeyFailure = null;
  try {
    const scene = await createSceneThroughUi(harness, external.page);
    const beforeRows = await queryRows(
      harness,
      external.page,
      `SELECT id, project_id AS projectId, version, content
       FROM tree_nodes
       WHERE id = ? AND project_id = ? AND node_type = 'scene'`,
      [scene.sceneId, scene.projectId],
    );
    if (beforeRows.length !== 1) {
      throw new Error("MCP D2a journey could not read its scene snapshot");
    }
    const beforeEvents = await queryRows(
      harness,
      external.page,
      `SELECT domain, op_type AS opType, entity_id AS entityId, sequence
       FROM change_events
       WHERE project_id = ? AND domain = 'prose'
       ORDER BY sequence`,
      [scene.projectId],
    );

    const mcpArtifact = await resolveMcpArtifact();
    mcpClient = await launchProductJourneyMcpClient({
      binaryPath: mcpArtifact.path,
      workspacePath: workspace,
      projectId: scene.projectId,
      onStderr: (chunk) =>
        process.stderr.write(`  [product:${journeyId}:mcp] ${String(chunk)}`),
    });
    const tools = await mcpClient.listTools();
    if (
      !Array.isArray(tools.tools) ||
      !tools.tools.some((tool) => tool?.name === "propose_scene_body")
    ) {
      throw new Error("MCP server did not advertise propose_scene_body");
    }

    const sentinel = `D2A-MCP-DENIAL-${Date.now()}`;
    const denialMarker = "D2A_EGRESS_DENIED:";
    const expectedRpcPrefix = `MCP JSON-RPC error (-32602): ${denialMarker}`;
    try {
      await mcpClient.callTool("propose_scene_body", {
        scene_id: scene.sceneId,
        text: sentinel,
        mode: "append",
      });
      throw new Error("MCP propose_scene_body unexpectedly succeeded");
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!message.startsWith(expectedRpcPrefix)) {
        throw new Error(`MCP D2a denial had an unexpected cause: ${message}`, {
          cause: error,
        });
      }
      if (message.includes(sentinel)) {
        throw new Error("MCP D2a denial leaked the proposed sentinel");
      }
    }

    const afterRows = await queryRows(
      harness,
      external.page,
      `SELECT id, project_id AS projectId, version, content
       FROM tree_nodes
       WHERE id = ? AND project_id = ? AND node_type = 'scene'`,
      [scene.sceneId, scene.projectId],
    );
    const afterEvents = await queryRows(
      harness,
      external.page,
      `SELECT domain, op_type AS opType, entity_id AS entityId, sequence
       FROM change_events
       WHERE project_id = ? AND domain = 'prose'
       ORDER BY sequence`,
      [scene.projectId],
    );
    const beforeScene = beforeRows[0];
    const afterScene = afterRows[0];
    const sceneContentUnchanged = beforeScene?.content === afterScene?.content;
    if (
      afterRows.length !== 1 ||
      String(afterScene?.id) !== String(beforeScene?.id) ||
      String(afterScene?.projectId) !== String(beforeScene?.projectId) ||
      Number(afterScene?.version) !== Number(beforeScene?.version) ||
      !sceneContentUnchanged
    ) {
      throw new Error("MCP D2a denial changed the scene row");
    }
    const changeEventsUnchanged =
      JSON.stringify(beforeEvents) === JSON.stringify(afterEvents);
    if (!changeEventsUnchanged) {
      throw new Error("MCP D2a denial changed prose change-event metadata");
    }
    if (
      (await scene.editorSurface
        .getByTestId("external-edit-conflict")
        .count()) !== 0
    ) {
      throw new Error("MCP D2a denial opened an editor conflict");
    }

    harness.recordTimeline("mcp-d2a-pre-dispatch-denial", {
      workspace,
      projectId: scene.projectId,
      sceneId: scene.sceneId,
      tool: "propose_scene_body",
      denial: { code: -32602, marker: denialMarker },
      handlerDispatch: false,
      sceneVersionBefore: beforeScene.version,
      sceneVersionAfter: afterScene.version,
      sceneContentUnchanged,
      changeEventsBefore: beforeEvents.length,
      changeEventsAfter: afterEvents.length,
      changeEventsUnchanged,
      editorConflict: false,
    });
    log(
      "MCP D2a egress denial: pre-dispatch, no DB or external-write-feed mutation",
    );
    return {
      id: journeyId,
      workspace,
      projectId: scene.projectId,
      sceneId: scene.sceneId,
      d2aDenial: { code: -32602, marker: denialMarker },
      handlerDispatch: false,
      sceneContentUnchanged,
      changeEventsUnchanged,
      editorConflict: false,
    };
  } catch (error) {
    journeyFailure = error;
    throw error;
  } finally {
    await mcpClient?.close().catch((error) => {
      if (!journeyFailure) throw error;
      console.error(
        `[electron:product] MCP cleanup failed after the primary assertion: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    try {
      await harness.close(external.app, external.page, journeyId);
    } catch (closeError) {
      if (!journeyFailure) throw closeError;
      console.error(
        `[electron:product] MCP Electron cleanup failed after the primary assertion: ${
          closeError instanceof Error ? closeError.message : String(closeError)
        }`,
      );
    }
  }
}

async function runCrossFeatureAuthoringJourney(harness) {
  const workspace = harness.workspacePath("cross-feature-authoring");
  await configureWorkspace(harness, workspace, {
    deterministicAi: true,
  });
  const prepared = await prepareCodexContextEntry(harness);

  const authoring = await harness.launch("cross-feature-authoring/write");
  let sceneId;
  let assistantMessageId;
  try {
    const scene = await createSceneThroughUi(harness, authoring.page);
    sceneId = scene.sceneId;
    if (scene.projectId !== prepared.projectId) {
      throw new Error("authoring journey project authority changed");
    }

    const pinButton = authoring.page.getByTestId("context-pin-entry");
    if (!(await pinButton.isVisible())) {
      await authoring.page.getByTestId("context-bar-toggle").click();
    }
    await pinButton.waitFor({ state: "visible", timeout: 30_000 });
    await pinButton.click();
    const pin = authoring.page.getByTestId(
      `pin-entry-toggle-${prepared.entryId}`,
    );
    await pin.waitFor({ state: "visible", timeout: 30_000 });
    await pin.click();
    await harness.waitUntil(
      () => pin.isChecked(),
      "Codex context pin persistence",
      10_000,
    );
    await authoring.page.keyboard.press("Escape");

    await sendChatPrompt(authoring.page, AUTHORING_PROMPT);
    await authoring.page
      .getByText(AUTHORING_OUTPUT, { exact: false })
      .last()
      .waitFor({ state: "visible", timeout: 30_000 });
    await authoring.page
      .getByTestId("streaming-indicator")
      .waitFor({ state: "detached", timeout: 30_000 });

    const rows = await harness.waitUntil(async () => {
      const current = await listChatAuthorityRows(
        harness,
        authoring.page,
        scene.projectId,
      );
      const assistant = current.find(
        (row) =>
          row.nodeId === scene.sceneId &&
          row.role === "assistant" &&
          String(row.content).includes(AUTHORING_OUTPUT),
      );
      const prompt = current.find(
        (row) =>
          row.nodeId === scene.sceneId &&
          String(row.systemPrompt ?? "").includes(CODEX_CONTEXT_MARKER),
      );
      return assistant && prompt ? current : null;
    }, "Codex-backed authoring response and prompt snapshot");
    const assistant = rows.find(
      (row) =>
        row.nodeId === scene.sceneId &&
        row.role === "assistant" &&
        String(row.content).includes(AUTHORING_OUTPUT),
    );
    assistantMessageId = String(assistant?.messageId ?? "");
    if (!assistantMessageId) {
      throw new Error("authoring journey did not persist its AI response");
    }

    await authoring.page
      .getByTestId(`insert-to-editor-${assistantMessageId}`)
      .click();
    // The insert button's hover preview is a ProseMirror decoration. Clear it
    // before reading editor.textContent(), which includes decoration text.
    await scene.editor.hover();
    await scene.editor
      .locator(".ghost-preview-text")
      .waitFor({ state: "detached", timeout: 10_000 });
    await harness.waitUntil(
      async () =>
        (await scene.editor.textContent())?.includes(AUTHORING_OUTPUT),
      "AI output insertion into editor",
      10_000,
    );

    const assertScenePersisted = async (label) => {
      const rows = await queryRows(
        harness,
        authoring.page,
        "SELECT id FROM tree_nodes WHERE id = ?",
        [scene.sceneId],
      );
      if (rows.length !== 1 || String(rows[0]?.id) !== scene.sceneId) {
        throw new Error(`${label}: authoring scene was removed`);
      }
    };
    await assertScenePersisted("before editor undo");
    await scene.editor.click();
    const editorFocused = await scene.editor.evaluate(
      (element) =>
        element === element.ownerDocument.activeElement ||
        element.contains(element.ownerDocument.activeElement),
    );
    if (!editorFocused) {
      throw new Error("editor did not hold focus before undo");
    }
    await scene.editor.press("Control+z");
    await assertScenePersisted("after editor undo");
    await harness.waitUntil(
      async () =>
        !(await scene.editor.textContent())?.includes(AUTHORING_OUTPUT),
      "editor undo after chat insertion",
      10_000,
    );
    await scene.editor.press("Control+Shift+z");
    await harness.waitUntil(
      async () =>
        (await scene.editor.textContent())?.includes(AUTHORING_OUTPUT),
      "editor redo after chat insertion",
      10_000,
    );

    const persisted = await harness.waitUntil(
      () => findSceneWithText(harness, authoring.page, AUTHORING_OUTPUT),
      "authoring flow autosave",
      30_000,
    );
    if (
      persisted.id !== scene.sceneId ||
      !String(persisted.content).includes(assistantMessageId) ||
      !String(persisted.content).includes('"source":"ai"')
    ) {
      throw new Error(
        "authoring flow did not persist AI attribution under the active scene",
      );
    }
    harness.recordTimeline("cross-feature-authoring-persisted", {
      workspace,
      workspaceOpenRevision: await workspaceOpenRevision(authoring.page),
      projectId: scene.projectId,
      sceneId: scene.sceneId,
      codexEntryId: prepared.entryId,
      assistantMessageId,
      promptIncludedCodex: true,
      undoPassed: true,
      redoPassed: true,
      aiAttributionPersisted: true,
    });
  } finally {
    await harness.close(
      authoring.app,
      authoring.page,
      "cross-feature-authoring/write",
    );
  }

  const restart = await harness.launch("cross-feature-authoring/restart");
  try {
    const persisted = await harness.waitUntil(
      () => findSceneWithText(harness, restart.page, AUTHORING_OUTPUT),
      "authoring output after restart",
      30_000,
    );
    if (persisted.id !== sceneId) {
      throw new Error("authoring output restarted under another scene");
    }
    const pane = restart.page.locator(
      `[data-editor-loaded-document-id="${sceneId}"][data-editor-document-loading="false"]`,
    );
    await pane.waitFor({ state: "visible", timeout: 30_000 });
    await pane
      .locator(`.ProseMirror:has-text("${AUTHORING_OUTPUT}")`)
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    harness.recordTimeline("cross-feature-authoring-restored", {
      workspace,
      workspaceOpenRevision: await workspaceOpenRevision(restart.page),
      projectId: prepared.projectId,
      sceneId,
      assistantMessageId,
    });
    log(
      "Cross-feature authoring: Codex context, AI response, insert, undo/redo, save, and restart passed",
    );
  } finally {
    await harness.close(
      restart.app,
      restart.page,
      "cross-feature-authoring/restart",
    );
  }
}

/**
 * The isolated native module owns these typed production boundaries and their
 * restart evidence:
 * - chronicle_bulk_mutate -> chronicle-native-roundtrip-restored
 * - lint_term_dictionary_insert / lint_term_dictionary_list
 *   -> lint-native-roundtrip-restored
 * - map_write_bundle -> map-native-roundtrip-restored
 * - project_snapshot_create / project_snapshot_restore_context
 *   -> snapshot-native-roundtrip-restored
 */
const NATIVE_ROUND_TRIP_JOURNEYS = createNativeRoundTripJourneys({
  configureWorkspace,
  log,
});

export const PRODUCT_JOURNEYS = [
  { id: "editor-persistence", run: runEditorPersistenceJourney },
  {
    id: "chat-authority-isolation",
    run: runChatAuthorityIsolationJourney,
  },
  {
    id: "chat-stream-folder-switch",
    run: runFolderStreamSwitchJourney,
  },
  {
    id: "chat-stream-snippet-switch",
    run: runSnippetStreamSwitchJourney,
  },
  {
    id: "chat-stream-codex-switch",
    run: runCodexStreamSwitchJourney,
  },
  {
    id: "workspace-switch-authority",
    run: runWorkspaceSwitchAuthorityJourney,
  },
  {
    id: "external-write-conflict",
    run: runExternalWriteConflictJourney,
  },
  {
    id: "cross-feature-authoring",
    run: runCrossFeatureAuthoringJourney,
  },
  {
    id: "chat-stream-project-switch",
    run: runChatStreamProjectSwitchJourney,
  },
  {
    id: "agent-stream-project-switch",
    run: runAgentStreamProjectSwitchJourney,
  },
  {
    id: "chat-stream-workspace-switch",
    run: runChatStreamWorkspaceSwitchJourney,
  },
  {
    id: "agent-stream-workspace-switch",
    run: runAgentStreamWorkspaceSwitchJourney,
  },
  {
    id: "editor-pending-project-switch",
    run: runEditorPendingProjectSwitchJourney,
  },
  {
    id: "mcp-external-write-conflict",
    run: runMcpD2aEgressDenialJourney,
  },
  ...NATIVE_ROUND_TRIP_JOURNEYS,
  createChronicleExtractionJourney({
    configureWorkspace,
    evidenceDirectory: path.dirname(resolveResultsPath()),
  }),
  createCodexEntityRelationReviewJourney({ configureWorkspace }),
  ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS,
  ...NARRATIVE_C2ZC_PRODUCT_JOURNEYS,
];

export function resolveSelectedProductJourneys(
  journeys,
  serializedIds,
  { requireAll = false } = {},
) {
  if (requireAll && serializedIds !== undefined && serializedIds !== "") {
    throw new Error(
      "GRIMODEX_PRODUCT_JOURNEY_IDS must not be set for Full product journey execution; subset execution is rejected",
    );
  }
  if (serializedIds === undefined || serializedIds === "") return journeys;

  let requested;
  try {
    requested = JSON.parse(serializedIds);
  } catch (error) {
    throw new Error("GRIMODEX_PRODUCT_JOURNEY_IDS must be a valid JSON array", {
      cause: error,
    });
  }
  if (!Array.isArray(requested)) {
    throw new Error("GRIMODEX_PRODUCT_JOURNEY_IDS must be a valid JSON array");
  }
  if (requested.length === 0) {
    throw new Error(
      "GRIMODEX_PRODUCT_JOURNEY_IDS must include at least one journey ID",
    );
  }

  const requestedIds = new Set();
  for (const id of requested) {
    if (typeof id !== "string" || id.trim() !== id || id.length === 0) {
      throw new Error(
        "GRIMODEX_PRODUCT_JOURNEY_IDS must contain non-empty canonical strings",
      );
    }
    if (requestedIds.has(id)) {
      throw new Error(`duplicate product journey ID: ${id}`);
    }
    requestedIds.add(id);
  }
  const knownIds = new Set(journeys.map((journey) => journey.id));
  const unknownIds = [...requestedIds].filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`unknown product journey ID(s): ${unknownIds.join(", ")}`);
  }
  return journeys.filter((journey) => requestedIds.has(journey.id));
}

/**
 * Bind the executable selection to the immutable catalog before any artifact
 * preflight.  A fail-fast subset must never be reported as if another lane
 * ran, and duplicate/unknown IDs must not disappear in a filtered result.
 */
export function assertProductJourneySelectionBinding({
  catalog,
  journeys,
  requireAll = false,
  selectionName = "",
}) {
  if (!Array.isArray(catalog) || !Array.isArray(journeys)) {
    throw new Error("product journey catalog and selection must be arrays");
  }
  const catalogJourneyIds = catalog.map((journey) => journey?.id);
  const journeyIds = journeys.map((journey) => journey?.id);
  if (
    catalogJourneyIds.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(catalogJourneyIds).size !== catalogJourneyIds.length
  ) {
    throw new Error(
      "product journey catalog contains invalid or duplicate IDs",
    );
  }
  if (
    journeyIds.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(journeyIds).size !== journeyIds.length
  ) {
    throw new Error(
      "product journey selection contains invalid or duplicate IDs",
    );
  }
  const catalogIds = new Set(catalogJourneyIds);
  if (journeyIds.some((id) => !catalogIds.has(id))) {
    throw new Error(
      "product journey selection contains an ID absent from catalog",
    );
  }
  if (
    requireAll &&
    JSON.stringify(journeyIds) !== JSON.stringify(catalogJourneyIds)
  ) {
    throw new Error(
      "Full product journey execution requires all canonical product journey IDs in catalog order",
    );
  }
  if (selectionName === "c2-zc") {
    if (
      JSON.stringify(catalogJourneyIds) !==
      JSON.stringify(C2ZC_PRODUCT_JOURNEY_IDS)
    ) {
      throw new Error(
        "c2-zc selection must use the exact canonical-plus-auxiliary C2-ZC catalog",
      );
    }
    if (
      JSON.stringify(journeyIds) !== JSON.stringify(C2ZC_PRODUCT_JOURNEY_IDS)
    ) {
      throw new Error(
        "c2-zc selection requires all atomic lanes in catalog order",
      );
    }
  }
  return {
    catalogJourneyIds: [...catalogJourneyIds],
    journeyIds: [...journeyIds],
    requireAll,
    selectionName,
    complete: journeyIds.length === catalogJourneyIds.length,
  };
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function elapsedMilliseconds(clock, startedAt) {
  const duration = clock() - startedAt;
  if (!Number.isFinite(duration)) {
    throw new Error("product journey clock returned a non-finite duration");
  }
  return Math.max(0, Math.round(duration));
}

function normalizeProductJourneyDiagnostics(diagnostics) {
  return {
    rendererErrorCount: 0,
    pageErrors: [],
    mainErrorCount: 0,
    unallowedMainErrors: [],
    mainCleanPass: true,
    cleanPass: true,
    ...(diagnostics ?? {}),
  };
}

function resolveResultsPath(
  resultsPath,
  { root = rootDir, environment = process.env } = {},
) {
  if (resultsPath) return path.resolve(root, resultsPath);
  const artifactDir =
    environment.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR ??
    path.join(root, ".artifacts", "product-journeys");
  return path.resolve(root, artifactDir, "results.json");
}

async function writeResults(resultsPath, report) {
  await mkdir(path.dirname(resultsPath), { recursive: true });
  await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function normalizeArtifactEvidence(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.artifacts)) {
    return value.artifacts;
  }
  return [];
}

function artifactIdentityKeysMatch(identity) {
  return (
    identity &&
    typeof identity === "object" &&
    !Array.isArray(identity) &&
    JSON.stringify(Object.keys(identity).sort()) ===
      JSON.stringify([...PRODUCT_JOURNEY_ARTIFACT_KEYS].sort())
  );
}

function isValidProductJourneyArtifact(identity) {
  return (
    artifactIdentityKeysMatch(identity) &&
    typeof identity.name === "string" &&
    identity.name.length > 0 &&
    typeof identity.path === "string" &&
    identity.path.length > 0 &&
    typeof identity.requestedPath === "string" &&
    identity.requestedPath.length > 0 &&
    typeof identity.realPath === "string" &&
    identity.realPath.length > 0 &&
    !identity.path.includes("\0") &&
    !identity.requestedPath.includes("\0") &&
    !identity.realPath.includes("\0") &&
    Number.isSafeInteger(identity.size) &&
    identity.size >= 0 &&
    /^sha256:[0-9a-f]{64}$/u.test(String(identity.sha256 ?? ""))
  );
}

function artifactIdentityEqual(left, right) {
  return (
    isValidProductJourneyArtifact(left) &&
    isValidProductJourneyArtifact(right) &&
    PRODUCT_JOURNEY_ARTIFACT_KEYS.every((field) => left[field] === right[field])
  );
}

function assertProductJourneyArtifactSet(
  actual,
  expected,
  label = "product journey artifacts",
) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    throw new Error(`${label} must be an artifact array`);
  }
  if (actual.length !== expected.length) {
    throw new Error(
      `${label} must contain exactly ${expected.length} artifacts (received ${actual.length})`,
    );
  }
  const expectedNames = expected.map((artifact) => artifact.name);
  const actualNames = actual.map((artifact) => artifact?.name);
  if (
    new Set(actualNames).size !== actualNames.length ||
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
  ) {
    throw new Error(
      `${label} names/set mismatch: expected ${expectedNames.join(", ")}, received ${actualNames.join(", ")}`,
    );
  }
  for (const [index, artifact] of actual.entries()) {
    if (!isValidProductJourneyArtifact(artifact)) {
      throw new Error(`${label} entry ${index} has invalid identity`);
    }
    if (!artifactIdentityEqual(artifact, expected[index])) {
      throw new Error(
        `${label} entry ${artifact.name} path/realPath/size/sha256 mismatch`,
      );
    }
  }
  return actual;
}

export function assertProductJourneyArtifactEvidence(actual, expected, label) {
  return assertProductJourneyArtifactSet(actual, expected, label);
}

const C2ZC_FIXTURE_SUMMARY_KEYS = Object.freeze([
  "manifestVersion",
  "manifestSha256",
  "fixtureSha256",
  "fixtureSizeBytes",
  "semanticContentsDigest",
  "contractVersion",
  "builderVersion",
  "candidateHeadSha",
  "candidateTreeSha",
  "candidateStatusSha256",
]);

function normalizeSha256(value) {
  return String(value ?? "").startsWith("sha256:")
    ? String(value)
    : `sha256:${String(value ?? "")}`;
}

function assertC2ZcFixtureSummary(
  summary,
  { candidate = null, label = "C2-ZC fixture summary" } = {},
) {
  if (
    !isPlainObject(summary) ||
    JSON.stringify(Object.keys(summary).sort()) !==
      JSON.stringify([...C2ZC_FIXTURE_SUMMARY_KEYS].sort()) ||
    !Number.isSafeInteger(summary.manifestVersion) ||
    summary.manifestVersion < 1 ||
    !PRODUCT_JOURNEY_SHA256_HEX.test(
      normalizeSha256(summary.manifestSha256).slice(7),
    ) ||
    !PRODUCT_JOURNEY_SHA256_HEX.test(
      normalizeSha256(summary.fixtureSha256).slice(7),
    ) ||
    !Number.isSafeInteger(summary.fixtureSizeBytes) ||
    summary.fixtureSizeBytes < 0 ||
    !PRODUCT_JOURNEY_SHA256_HEX.test(
      normalizeSha256(summary.semanticContentsDigest).slice(7),
    ) ||
    typeof summary.contractVersion !== "number" ||
    typeof summary.builderVersion !== "string" ||
    !PRODUCT_JOURNEY_GIT_OBJECT_ID.test(summary.candidateHeadSha) ||
    !PRODUCT_JOURNEY_GIT_OBJECT_ID.test(summary.candidateTreeSha) ||
    !/^sha256:[0-9a-f]{64}$/u.test(summary.candidateStatusSha256)
  ) {
    throw new Error(`${label} has an invalid compact evidence shape`);
  }
  if (candidate) {
    const candidateStatusSha256 = normalizeSha256(
      candidate.fixtureStatusSha256 ??
        candidate.worktreeStatusHash ??
        candidate.statusSha256,
    );
    if (
      summary.candidateHeadSha !== candidate.resolvedHeadSha ||
      summary.candidateTreeSha !==
        (candidate.resolvedHeadTreeSha ?? candidate.resolvedTreeSha) ||
      summary.candidateStatusSha256 !== candidateStatusSha256
    ) {
      throw new Error(`${label} is bound to a different candidate`);
    }
  }
  return summary;
}

export function assertC2ZcProductJourneyFixtureSummary(
  actual,
  expected,
  label = "C2-ZC product journey fixture summary",
) {
  assertC2ZcFixtureSummary(actual, { label });
  assertC2ZcFixtureSummary(expected, { label: `${label} expected` });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the verified fixture evidence`);
  }
  return actual;
}

function createC2ZcFixtureSummary(manifest, manifestIdentity) {
  return {
    manifestVersion: manifest.manifestVersion,
    manifestSha256: manifestIdentity.sha256,
    fixtureSha256: manifest.fixtureSha256,
    fixtureSizeBytes: manifest.fixtureSizeBytes,
    semanticContentsDigest: manifest.semantic.contentsDigest,
    contractVersion: manifest.contractVersion,
    builderVersion: manifest.builderVersion,
    candidateHeadSha: manifest.candidate.resolvedHeadSha,
    candidateTreeSha: manifest.candidate.resolvedTreeSha,
    candidateStatusSha256: manifest.candidate.statusSha256,
  };
}

function productJourneyPathInsideRoot(root, value, label) {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay inside the product artifact root`);
  }
}

/** Load and hash the stable C2-ZC fixture, returning only its bound summary. */
export async function readC2ZcProductJourneyFixtureEvidence({
  root = rootDir,
  environment = process.env,
  candidate = null,
} = {}) {
  const raw = environment[C2ZC_RESTORE_FIXTURE_ENV];
  if (raw === undefined || raw === "") return null;
  const input = await loadC2ZcRestoreFixtureInput(undefined, environment);
  if (typeof input.manifestPath !== "string" || input.manifestPath === "") {
    throw new Error("C2-ZC product journey fixture must use a manifest path");
  }
  const fixturePath = path.resolve(input.path);
  const manifestPath = path.resolve(input.manifestPath);
  const databasePath = path.resolve(
    path.dirname(manifestPath),
    input.manifest.artifacts.database.path,
  );
  const expectedFixturePath = path.resolve(
    path.dirname(manifestPath),
    input.manifest.artifacts.fixture.path,
  );
  for (const [label, value] of [
    ["C2-ZC fixture", fixturePath],
    ["C2-ZC fixture database", databasePath],
    ["C2-ZC fixture manifest", manifestPath],
  ]) {
    productJourneyPathInsideRoot(root, value, label);
  }
  const [fixtureIdentity, databaseIdentity, manifestIdentity, expectedFixture] =
    await Promise.all([
      resolveProductJourneyArtifact(fixturePath, { root }),
      resolveProductJourneyArtifact(databasePath, { root }),
      resolveProductJourneyArtifact(manifestPath, { root }),
      resolveProductJourneyArtifact(expectedFixturePath, { root }),
    ]);
  if (
    fixtureIdentity.realPath !== expectedFixture.realPath ||
    fixtureIdentity.sha256 !== input.manifest.artifacts.fixture.sha256 ||
    fixtureIdentity.size !== input.manifest.artifacts.fixture.sizeBytes ||
    databaseIdentity.sha256 !== input.manifest.artifacts.database.sha256 ||
    databaseIdentity.size !== input.manifest.artifacts.database.sizeBytes ||
    input.manifest.fixtureSha256 !== fixtureIdentity.sha256 ||
    input.manifest.fixtureSizeBytes !== fixtureIdentity.size
  ) {
    throw new Error(
      "C2-ZC product journey fixture bytes, realpaths, or manifest artifacts do not match",
    );
  }
  assertC2ZcFixtureCandidateBinding(
    input.manifest.candidate,
    candidate ?? input.manifest.candidate,
    "C2-ZC product journey fixture candidate",
  );
  return assertC2ZcFixtureSummary(
    createC2ZcFixtureSummary(input.manifest, manifestIdentity),
    { candidate },
  );
}

function productJourneyFixtureEvidenceEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function resolveAndVerifyProductJourneyArtifacts(
  journeys,
  {
    catalog = PRODUCT_JOURNEY_CATALOG,
    root = rootDir,
    env = process.env,
    platform = process.platform,
    preflightArtifacts,
  } = {},
) {
  const requests = resolveProductJourneyArtifactRequests(journeys, {
    catalog,
    root,
    env,
    platform,
  });
  const resolved = [];
  for (const request of requests) {
    resolved.push({
      name: request.name,
      ...(await resolveProductJourneyArtifact(request.path, {
        executable: request.executable === true,
        root,
        platform,
      })),
    });
  }
  if (preflightArtifacts !== undefined) {
    assertProductJourneyArtifactSet(
      normalizeArtifactEvidence(preflightArtifacts),
      resolved,
      "product journey preflight artifacts",
    );
  }
  return resolved;
}

function hasC2ZcAcceptanceJourney(journeys) {
  const selectedIds = new Set(journeys.map((journey) => journey?.id));
  return selectedIds.has(C2ZC_PRODUCT_JOURNEY_ID);
}

function requiresC2ZcRustAcceptance({ journeys, selectionName }) {
  return selectionName === "c2-zc" || hasC2ZcAcceptanceJourney(journeys);
}

export function readProductJourneyBuildReceipt(environment = process.env) {
  const raw = environment[PRODUCT_JOURNEY_BUILD_RECEIPT_ENV];
  if (!raw) return null;
  try {
    const receipt = JSON.parse(raw);
    assertProductJourneyBuildReceipt(receipt);
    return receipt;
  } catch {
    return null;
  }
}

function isValidProductJourneyCandidate(candidate) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify([...PRODUCT_JOURNEY_CANDIDATE_KEYS].sort())
  ) {
    return false;
  }
  if (
    ["requestedBase", "requestedHead"].some(
      (field) =>
        typeof candidate[field] !== "string" ||
        candidate[field].length === 0 ||
        candidate[field].includes("\u0000"),
    ) ||
    [
      "resolvedBaseSha",
      "resolvedHeadSha",
      "resolvedHeadTreeSha",
      "currentHeadSha",
    ].some(
      (field) =>
        typeof candidate[field] !== "string" ||
        !PRODUCT_JOURNEY_GIT_OBJECT_ID.test(candidate[field]),
    ) ||
    typeof candidate.worktreeClean !== "boolean" ||
    !PRODUCT_JOURNEY_SHA256_HEX.test(candidate.worktreeFingerprint ?? "") ||
    !PRODUCT_JOURNEY_SHA256_HEX.test(candidate.worktreeStatusHash ?? "")
  ) {
    return false;
  }
  return true;
}

function productJourneyCandidatesEqual(left, right) {
  return (
    isValidProductJourneyCandidate(left) &&
    isValidProductJourneyCandidate(right) &&
    PRODUCT_JOURNEY_CANDIDATE_KEYS.every(
      (field) => left[field] === right[field],
    )
  );
}

function assertProductJourneyBuildReceipt(
  receipt,
  {
    candidate = null,
    artifacts = null,
    label = "product journey build receipt",
  } = {},
) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    JSON.stringify(Object.keys(receipt).sort()) !==
      JSON.stringify([...PRODUCT_JOURNEY_BUILD_RECEIPT_KEYS].sort()) ||
    receipt.version !== 1 ||
    receipt.verified !== true ||
    receipt.source !== "local-ci-candidate" ||
    !isValidProductJourneyCandidate(receipt.candidate) ||
    receipt.candidate.worktreeClean !== true ||
    receipt.candidate.resolvedHeadSha !== receipt.candidate.currentHeadSha ||
    !Array.isArray(receipt.artifacts) ||
    receipt.artifacts.length === 0
  ) {
    throw new Error(`${label} must include exact verified artifact identities`);
  }
  assertProductJourneyArtifactSet(
    receipt.artifacts,
    receipt.artifacts,
    `${label} artifacts`,
  );
  if (
    candidate &&
    !productJourneyCandidatesEqual(receipt.candidate, candidate)
  ) {
    throw new Error(`${label} is bound to a different candidate`);
  }
  if (artifacts) {
    assertProductJourneyArtifactSet(
      receipt.artifacts,
      artifacts,
      `${label} artifacts`,
    );
  }
  return receipt;
}

function assertProductJourneyBuildReceiptArtifacts(
  buildReceipt,
  resolvedArtifacts,
  { required = false, candidate = null } = {},
) {
  if (!required && !buildReceipt) return;
  assertProductJourneyBuildReceipt(buildReceipt, {
    candidate,
    artifacts: resolvedArtifacts,
  });
}

export async function readC2ZcRustAcceptanceEvidence({
  required,
  root = rootDir,
  environment = process.env,
}) {
  const configuredPath =
    environment[C2ZC_RUST_RECEIPT_PATH_ENV] ??
    (required ? C2ZC_RUST_ACCEPTANCE_RECEIPT_PATH : null);
  if (!configuredPath) {
    if (required) {
      throw new Error(
        `${C2ZC_RUST_RECEIPT_PATH_ENV} is required for complete C2-ZC acceptance`,
      );
    }
    return {
      required: false,
      verified: false,
      reason: "not-required",
    };
  }
  const candidate = await resolveC2ZcRustAcceptanceCandidate({
    root,
    requestedBase: environment[C2ZC_RUST_BASE_ENV] ?? "origin/master",
    requestedHead: environment[C2ZC_RUST_HEAD_ENV] ?? "HEAD",
  });
  const verified = await verifyC2ZcRustAcceptanceReceipt({
    root,
    candidate,
    catalogDigest: C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST,
    receiptPath: configuredPath,
    receiptSha256: environment[C2ZC_RUST_RECEIPT_SHA256_ENV] ?? null,
  });
  if (!productJourneyCandidatesEqual(candidate, verified.receipt.candidate)) {
    throw new Error(
      "C2-ZC Rust acceptance receipt is not bound to the live product journey candidate",
    );
  }
  return {
    required,
    verified: true,
    receiptPath: verified.receiptPath,
    receiptSha256: verified.receiptSha256,
    candidate,
    gates: verified.receipt.gates,
    verifyOutcome: verified.receipt.verifyOutcome,
    receipt: verified.receipt,
  };
}

export function refreshProductJourneyOutcome(report) {
  const requiredJourneyIds =
    Array.isArray(report.requiredJourneyIds) &&
    report.requiredJourneyIds.length > 0
      ? report.requiredJourneyIds
      : report.journeyIds;
  const requiredResults = (report.journeys ?? []).filter((journey) =>
    requiredJourneyIds.includes(journey?.id),
  );
  const exactLanePass =
    report.status === "passed" &&
    Array.isArray(requiredJourneyIds) &&
    Array.isArray(report.journeys) &&
    requiredResults.length === requiredJourneyIds.length &&
    requiredResults.every((journey) => journey.status === "passed");
  const exactLaneClean =
    exactLanePass &&
    requiredResults.every((journey) => journey.cleanPass === true);
  const rustAcceptanceComplete =
    report.acceptanceRequired !== true ||
    (report.c2zcRustAcceptance?.required === true &&
      report.c2zcRustAcceptance?.verified === true &&
      isPlainObject(report.c2zcRustAcceptance?.verifyOutcome) &&
      isPlainObject(report.c2zcRustAcceptance?.receipt) &&
      JSON.stringify(report.c2zcRustAcceptance.verifyOutcome) ===
        JSON.stringify(report.c2zcRustAcceptance.receipt.verifyOutcome));
  const buildReceiptComplete =
    report.acceptanceRequired !== true ||
    (report.buildReceipt?.verified === true &&
      isValidProductJourneyCandidate(report.buildReceipt.candidate) &&
      report.buildReceipt.candidate.worktreeClean === true &&
      Array.isArray(report.buildReceipt.artifacts) &&
      report.buildReceipt.artifacts.length > 0 &&
      report.buildReceipt.artifacts.every(isValidProductJourneyArtifact));
  const candidateBindingComplete =
    report.acceptanceRequired !== true ||
    (productJourneyCandidatesEqual(
      report.buildReceipt?.candidate,
      report.c2zcRustAcceptance?.candidate,
    ) &&
      productJourneyCandidatesEqual(
        report.c2zcRustAcceptance?.candidate,
        report.c2zcRustAcceptance?.receipt?.candidate,
      ));
  const fixtureEvidenceComplete =
    report.acceptanceRequired !== true ||
    (report.c2zcRestoreFixture !== null &&
      report.c2zcRestoreFixture !== undefined);
  report.rustAcceptanceComplete = rustAcceptanceComplete;
  report.allPassed =
    exactLanePass &&
    rustAcceptanceComplete &&
    buildReceiptComplete &&
    candidateBindingComplete &&
    fixtureEvidenceComplete;
  report.allClean =
    exactLaneClean &&
    rustAcceptanceComplete &&
    buildReceiptComplete &&
    candidateBindingComplete &&
    fixtureEvidenceComplete;
  // This is the final acceptance bit. It cannot be inherited from a Rust-only
  // preflight when a required product lane failed or is not clean.
  report.acceptanceComplete =
    report.acceptanceRequired === true && report.allClean;
  return report;
}

async function writeAuditManifest(
  outputPath,
  report,
  artifactEvidence,
  { root = rootDir } = {},
) {
  const results = await resolveProductJourneyArtifact(outputPath, { root });
  const manifestPath = path.join(path.dirname(outputPath), "manifest.json");
  const manifest = {
    version: PRODUCT_JOURNEY_AUDIT_MANIFEST_VERSION,
    status: report.status,
    catalogDigest: report.catalogDigest,
    journeyIds: [...report.journeyIds],
    requiredJourneyIds: [...(report.requiredJourneyIds ?? report.journeyIds)],
    allPassed: report.allPassed === true,
    allClean: report.allClean === true,
    acceptanceRequired: report.acceptanceRequired === true,
    rustAcceptanceComplete: report.rustAcceptanceComplete === true,
    buildReceipt: report.buildReceipt ?? null,
    acceptanceComplete: report.acceptanceComplete === true,
    c2zcRustAcceptance: report.c2zcRustAcceptance ?? null,
    c2zcRestoreFixture: report.c2zcRestoreFixture ?? null,
    results: {
      path: path.basename(outputPath),
      realPath: results.realPath,
      sha256: results.sha256,
    },
    artifacts: normalizeArtifactEvidence(artifactEvidence),
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifestPath;
}

async function writeFailureReport(
  outputPath,
  report,
  artifactEvidence,
  { root = rootDir } = {},
) {
  refreshProductJourneyOutcome(report);
  await writeResults(outputPath, report);
  try {
    await writeAuditManifest(outputPath, report, artifactEvidence, { root });
  } catch (error) {
    // Preserve the bounded journey diagnostics and the original failure. The
    // manifest error is visible without replacing the useful failure record.
    report.auditManifestError = serializeError(error);
    await writeResults(outputPath, report);
  }
}

function notRunResults(journeys, reason) {
  return journeys.map((journey) => ({
    id: journey.id,
    status: "not-run",
    durationMs: 0,
    reason,
  }));
}

export async function runProductJourneys({
  createHarness,
  journeys = PRODUCT_JOURNEYS,
  catalog = PRODUCT_JOURNEY_CATALOG,
  artifactJourneys = journeys,
  requiredJourneyIds = null,
  assertArtifacts = null,
  clock = () => performance.now(),
  expectedCatalogDigest = process.env.GRIMODEX_PRODUCT_JOURNEY_CATALOG_DIGEST,
  requireAll = process.env.GRIMODEX_PRODUCT_JOURNEY_REQUIRE_ALL === "true",
  selectionName = process.env.GRIMODEX_PRODUCT_JOURNEY_SET ?? "",
  root = rootDir,
  environment = process.env,
  rustAcceptanceEvidence = null,
  buildReceipt = null,
  resultsPath,
} = {}) {
  const outputPath = resolveResultsPath(resultsPath, { root, environment });
  const catalogDigest =
    catalog === PRODUCT_JOURNEY_CATALOG
      ? PRODUCT_JOURNEY_CATALOG_DIGEST
      : digestProductJourneyCatalog(catalog);
  const selectedRequiredJourneyIds = journeys
    .filter((journey) => {
      const catalogEntry = catalog.find((entry) => entry.id === journey.id);
      return (
        (journey.required ?? catalogEntry?.required ?? true) !== false &&
        (journey.acceptanceRole ?? catalogEntry?.acceptanceRole) !==
          "diagnostic"
      );
    })
    .map((journey) => journey.id);
  const reportRequiredJourneyIds =
    requiredJourneyIds === null
      ? catalog
          .filter(
            (journey) =>
              journey.required !== false &&
              journey.acceptanceRole !== "diagnostic",
          )
          .map((journey) => journey.id)
      : [...requiredJourneyIds];
  if (
    requiredJourneyIds !== null &&
    JSON.stringify(reportRequiredJourneyIds) !==
      JSON.stringify(selectedRequiredJourneyIds)
  ) {
    throw new Error(
      "explicit product journey required IDs must match the selected required journeys in order",
    );
  }
  const report = {
    version: PRODUCT_JOURNEY_RESULTS_VERSION,
    status: "passed",
    catalogDigest,
    catalogJourneyIds: catalog.map((journey) => journey.id),
    journeyIds: journeys.map((journey) => journey.id),
    requiredJourneyIds: reportRequiredJourneyIds,
    acceptanceRequired: requiresC2ZcRustAcceptance({
      journeys,
      selectionName,
    }),
    rustAcceptanceComplete: false,
    buildReceipt: buildReceipt ?? readProductJourneyBuildReceipt(environment),
    acceptanceComplete: false,
    c2zcRustAcceptance: null,
    c2zcRestoreFixture: null,
    selectionBinding: {
      catalogJourneyIds: catalog.map((journey) => journey.id),
      journeyIds: journeys.map((journey) => journey.id),
      requireAll,
      selectionName,
      complete: false,
    },
    allPassed: false,
    allClean: false,
    journeys: [],
  };
  let artifactEvidence = [];

  try {
    report.selectionBinding = assertProductJourneySelectionBinding({
      catalog,
      journeys,
      requireAll,
      selectionName,
    });
    if (
      expectedCatalogDigest !== undefined &&
      expectedCatalogDigest !== catalogDigest
    ) {
      throw new Error(
        `product journey catalog digest mismatch: expected ${expectedCatalogDigest}, observed ${catalogDigest}`,
      );
    }
    report.c2zcRustAcceptance =
      rustAcceptanceEvidence ??
      (await readC2ZcRustAcceptanceEvidence({
        required: report.acceptanceRequired,
        root,
        environment,
      }));
    const fixtureEnvironmentValue = environment[C2ZC_RESTORE_FIXTURE_ENV];
    const fixtureRequiredWithoutOverride =
      report.acceptanceRequired === true && rustAcceptanceEvidence === null;
    if (
      report.acceptanceRequired === true &&
      (fixtureEnvironmentValue !== undefined || fixtureRequiredWithoutOverride)
    ) {
      report.c2zcRestoreFixture = await readC2ZcProductJourneyFixtureEvidence({
        root,
        environment,
        candidate: report.c2zcRustAcceptance?.candidate ?? null,
      });
    }
    report.rustAcceptanceComplete =
      report.acceptanceRequired !== true ||
      (report.c2zcRustAcceptance.required === true &&
        report.c2zcRustAcceptance.verified === true);
    const preflight =
      assertArtifacts ??
      ((selectedJourneys) =>
        assertBuildArtifacts(selectedJourneys, {
          catalog,
          root,
          env: environment,
        }));
    artifactEvidence = await preflight(artifactJourneys);
    const resolvedArtifacts = await resolveAndVerifyProductJourneyArtifacts(
      artifactJourneys,
      {
        catalog,
        root,
        env: environment,
        preflightArtifacts: artifactEvidence,
      },
    );
    if (report.acceptanceRequired === true) {
      assertProductJourneyBuildReceiptArtifacts(
        report.buildReceipt,
        resolvedArtifacts,
        {
          required: true,
          candidate: report.c2zcRustAcceptance?.candidate,
        },
      );
    } else if (report.buildReceipt) {
      assertProductJourneyBuildReceiptArtifacts(
        report.buildReceipt,
        resolvedArtifacts,
        {
          candidate: report.c2zcRustAcceptance?.candidate,
        },
      );
    }
  } catch (error) {
    report.status = "failed";
    report.error = serializeError(error);
    report.journeys.push(
      ...notRunResults(journeys, "Artifact preflight failed."),
    );
    await writeFailureReport(outputPath, report, artifactEvidence, { root });
    throw error;
  }

  const factory =
    createHarness ??
    (({ probeDbusAtFirstConfigure = false, journeyId = null } = {}) =>
      createProductJourneyHarness({
        mainCjs: path.join(root, "dist-electron", "main.cjs"),
        artifactRoot: environment.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR ?? null,
        probeDbusAtFirstConfigure,
        journeyId,
      }));
  const continueAfterJourneyFailure = selectionName === "c2-zc";
  let firstJourneyFailure = null;
  for (const [index, journey] of journeys.entries()) {
    const catalogEntry = catalog.find((entry) => entry.id === journey.id);
    const journeyIsRequired =
      (journey.required ?? catalogEntry?.required ?? true) !== false &&
      (journey.acceptanceRole ?? catalogEntry?.acceptanceRole) !== "diagnostic";
    const startedAt = clock();
    let durationMs = null;
    let harness = null;
    let journeyResultIndex = -1;
    try {
      harness = factory({
        probeDbusAtFirstConfigure:
          index === 0 &&
          process.platform === "linux" &&
          environment.GITHUB_ACTIONS === "true",
        journeyId: journey.id,
      });
      harness.c2zcRustAcceptanceEvidence = report.c2zcRustAcceptance;
      // Preparation is not a case start. Reject qualification failure before
      // the lane watchdog or original configure/write/restart callback runs.
      await harness.prepareBeforeCase?.();
      const runJourney = (laneContext) => journey.run(harness, laneContext);
      const c2zcWatchdogRequired =
        selectionName === "c2-zc" &&
        C2ZC_PRODUCT_JOURNEY_IDS.includes(journey.id);
      if (
        c2zcWatchdogRequired &&
        typeof harness.withLaneWatchdog !== "function"
      ) {
        throw new Error(
          `C2-ZC lane ${journey.id} requires harness.withLaneWatchdog`,
        );
      }
      const journeyResult =
        typeof harness.withLaneWatchdog === "function"
          ? await harness.withLaneWatchdog(runJourney, {
              phase: journey.id,
              timeoutMs: PRODUCT_JOURNEY_LANE_WATCHDOG_TIMEOUT_MS,
            })
          : await runJourney();
      durationMs = elapsedMilliseconds(clock, startedAt);
      const diagnostics = normalizeProductJourneyDiagnostics(
        await harness.finalizeDiagnostics?.(),
      );
      const passedResult = {
        id: journey.id,
        status: "passed",
        durationMs,
        ...diagnostics,
        ...(journeyResult === undefined ? {} : { result: journeyResult }),
      };
      report.journeys.push(passedResult);
      journeyResultIndex = report.journeys.length - 1;
      // A journey result can contain the launch attestation and other
      // evidence that cleanup removes (for example the nonce receipt tree).
      // Persist it before disposing the harness so a successful return cannot
      // be lost merely because its temporary filesystem evidence is consumed.
      await writeResults(outputPath, report);
      await harness.dispose({ success: true, name: journey.id });
      log(`${journey.id}: PASS`);
    } catch (error) {
      durationMs ??= elapsedMilliseconds(clock, startedAt);
      if (journeyIsRequired) report.status = "failed";
      const journeyDiagnostics = normalizeProductJourneyDiagnostics(
        error?.diagnostics ?? harness?.diagnostics?.(),
      );
      const failedResult = {
        id: journey.id,
        status: "failed",
        durationMs,
        error: serializeError(error),
        ...journeyDiagnostics,
        // cleanPass describes the complete journey outcome. A functional
        // assertion failure must never be serialized as a clean pass merely
        // because the renderer itself emitted no errors.
        cleanPass: false,
      };
      if (journeyResultIndex >= 0) {
        report.journeys[journeyResultIndex] = failedResult;
      } else {
        report.journeys.push(failedResult);
      }
      if (harness) {
        try {
          await harness.dispose({ success: false, name: journey.id });
        } catch (cleanupError) {
          failedResult.cleanupError = serializeError(cleanupError);
          console.error(
            `[electron:product] ${journey.id} failure cleanup also failed: ${
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError)
            }`,
          );
        }
        const finalJourneyDiagnostics =
          error?.diagnostics ?? harness.diagnostics?.();
        if (finalJourneyDiagnostics) {
          Object.assign(
            failedResult,
            normalizeProductJourneyDiagnostics(finalJourneyDiagnostics),
            {
              // A functional failure is never a clean journey even when renderer
              // shutdown itself emitted no additional diagnostics.
              cleanPass: false,
            },
          );
        }
      }
      const wrappedError = new Error(
        `${journey.id}: ${error?.stack ?? error}`,
        {
          cause: error,
        },
      );
      if (continueAfterJourneyFailure) {
        if (journeyIsRequired) firstJourneyFailure ??= wrappedError;
        await writeResults(outputPath, report);
        log(
          `${journey.id}: FAIL (${journeyIsRequired ? "continuing required C2-ZC lane" : "diagnostic only"})`,
        );
        continue;
      }
      report.journeys.push(
        ...notRunResults(
          journeys.slice(index + 1),
          `Fail-fast after ${journey.id}.`,
        ),
      );
      await writeFailureReport(outputPath, report, artifactEvidence, { root });
      throw wrappedError;
    }
  }
  try {
    // Re-read every configured artifact after the last lane.  This closes the
    // window in which a build output could be replaced while journeys were
    // running, before any acceptance bit or audit manifest is emitted.
    artifactEvidence = await resolveAndVerifyProductJourneyArtifacts(
      artifactJourneys,
      {
        catalog,
        root,
        env: environment,
        preflightArtifacts: artifactEvidence,
      },
    );
    if (report.acceptanceRequired === true) {
      assertProductJourneyBuildReceiptArtifacts(
        report.buildReceipt,
        artifactEvidence,
        {
          required: true,
          candidate: report.c2zcRustAcceptance?.candidate,
        },
      );
    } else if (report.buildReceipt) {
      assertProductJourneyBuildReceiptArtifacts(
        report.buildReceipt,
        artifactEvidence,
        {
          candidate: report.c2zcRustAcceptance?.candidate,
        },
      );
    }
    if (
      report.acceptanceRequired === true &&
      report.c2zcRestoreFixture !== null
    ) {
      const currentFixtureEvidence =
        await readC2ZcProductJourneyFixtureEvidence({
          root,
          environment,
          candidate: report.c2zcRustAcceptance?.candidate ?? null,
        });
      assertC2ZcFixtureSummary(currentFixtureEvidence, {
        candidate: report.c2zcRustAcceptance?.candidate ?? null,
        label: "C2-ZC product journey fixture summary",
      });
      if (
        !productJourneyFixtureEvidenceEqual(
          report.c2zcRestoreFixture,
          currentFixtureEvidence,
        )
      ) {
        throw new Error(
          "C2-ZC restore fixture changed after product journeys ran",
        );
      }
      report.c2zcRestoreFixture = currentFixtureEvidence;
    }
  } catch (error) {
    report.status = "failed";
    report.error = serializeError(error);
    await writeFailureReport(outputPath, report, artifactEvidence, { root });
    throw error;
  }
  refreshProductJourneyOutcome(report);
  await writeResults(outputPath, report);
  try {
    await writeAuditManifest(outputPath, report, artifactEvidence, { root });
  } catch (error) {
    report.status = "failed";
    report.error = serializeError(error);
    refreshProductJourneyOutcome(report);
    await writeResults(outputPath, report);
    throw error;
  }
  if (firstJourneyFailure) {
    throw firstJourneyFailure;
  }
  return report;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const requireAll =
    process.env.GRIMODEX_PRODUCT_JOURNEY_REQUIRE_ALL === "true";
  const selectionName = process.env.GRIMODEX_PRODUCT_JOURNEY_SET ?? "";
  const journeySet = resolveProductJourneySet(selectionName);
  const selectedJourneys = resolveSelectedProductJourneys(
    journeySet,
    process.env.GRIMODEX_PRODUCT_JOURNEY_IDS,
    { requireAll },
  );
  runProductJourneys({
    catalog: resolveProductJourneyCatalog(selectionName),
    journeys: selectedJourneys,
    requireAll,
    selectionName,
  }).then(
    () => log("PASS — product journeys completed"),
    (error) => {
      console.error(`[electron:product] FAIL: ${error?.stack ?? error}`);
      process.exitCode = 1;
    },
  );
}
