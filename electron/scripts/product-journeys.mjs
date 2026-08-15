#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { rootDir } from "./build.mjs";
import { PRODUCT_JOURNEY_CATALOG } from "./product-journey-catalog.mjs";
import { createProductJourneyHarness } from "./product-journey-harness.mjs";
import { launchProductJourneyMcpClient } from "./product-journey-mcp-client.mjs";
import { createNativeRoundTripJourneys } from "./product-journey-native-roundtrips.mjs";

const mainCjs = path.join(rootDir, "dist-electron", "main.cjs");
const DEFAULT_SCENE_TITLE = "シーン 1";
const SCENES_PANEL_TITLE = "シーン";
const CREATE_BUTTON_TITLE = "新規作成";
const NEW_SCENE_MENU_ITEM = "New scene";
const JOURNEY_TEXT = `PRODUCT-JOURNEY-${Date.now()}`;
const PENDING_SAVE_TEXT = `PENDING-SAVE-JOURNEY-${Date.now()}`;
const PENDING_PROJECT_SAVE_TEXT = `PENDING-PROJECT-SAVE-JOURNEY-${Date.now()}`;
const CLEAN_EXTERNAL_TEXT = `CLEAN-EXTERNAL-JOURNEY-${Date.now()}`;
const DIRTY_LOCAL_TEXT = `DIRTY-LOCAL-JOURNEY-${Date.now()}`;
const DIRTY_EXTERNAL_TEXT = `DIRTY-EXTERNAL-JOURNEY-${Date.now()}`;
const CHAT_AUTHORITY_PROMPT = `CHAT-AUTHORITY-JOURNEY-${Date.now()}`;
const PROJECT_CHAT_AUTHORITY_PROMPT = `PROJECT-CHAT-AUTHORITY-JOURNEY-${Date.now()}`;
const WORKSPACE_CHAT_AUTHORITY_PROMPT = `WORKSPACE-CHAT-AUTHORITY-JOURNEY-${Date.now()}`;
const CHAT_AUTHORITY_EARLY = "AUTHORITY-OLD-EARLY";
const CHAT_AUTHORITY_LATE = "AUTHORITY-OLD-LATE";
const WORKSPACE_CHAT_AUTHORITY_TITLE = WORKSPACE_CHAT_AUTHORITY_PROMPT.slice(
  0,
  30,
);
const MCP_CLEAN_EXTERNAL_TEXT = `MCP-CLEAN-EXTERNAL-JOURNEY-${Date.now()}`;
const MCP_DIRTY_LOCAL_TEXT = `MCP-DIRTY-LOCAL-JOURNEY-${Date.now()}`;
const MCP_DIRTY_EXTERNAL_TEXT = `MCP-DIRTY-EXTERNAL-JOURNEY-${Date.now()}`;
const CODEX_CONTEXT_MARKER = "CODEX-CONTEXT-JOURNEY";
const AUTHORING_PROMPT = `AUTHORING-JOURNEY-${Date.now()}`;
const AUTHORING_OUTPUT = "AUTHORING-AI-OUTPUT";
const PRODUCT_JOURNEY_MODEL = "product-journey-model";
const PENDING_SAVE_AUTOSAVE_DELAY_MS = 60_000;
const PRODUCT_JOURNEY_RESULTS_VERSION = 3;
const REQUIRED_LIFECYCLE_TRANSITION_PHASES = [
  "switch-requested",
  "quiescence-started",
  "old-stream-completed",
  "old-scope-persisted",
  "authority-commit",
  "new-scope-hydrated",
];
const DEFAULT_PRODUCT_JOURNEY_ARTIFACT_DIR = path.join(
  rootDir,
  ".artifacts",
  "product-journeys",
);
const mcpBinary = path.join(
  rootDir,
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "grimodex-mcp.exe" : "grimodex-mcp",
);

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

function assertBuildArtifacts(journeys) {
  const selectedIds = new Set(journeys.map((journey) => journey.id));
  const requiresMcp = PRODUCT_JOURNEY_CATALOG.some(
    (journey) =>
      selectedIds.has(journey.id) && journey.capabilities.includes("mcp"),
  );
  const artifacts = [
    mainCjs,
    path.join(rootDir, "dist", "index.html"),
    process.env.GRIMODEX_NODE_PATH ??
      path.join(
        rootDir,
        "electron",
        "native",
        "grimodex-node",
        "grimodex-node.node",
      ),
  ];
  if (requiresMcp) artifacts.push(mcpBinary);
  for (const artifact of artifacts) {
    if (!existsSync(artifact)) {
      throw new Error(
        `missing Electron product journey artifact: ${artifact}\nRun the builds required by the selected journey capabilities first.`,
      );
    }
  }
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
  try {
    await harness.invokeOk(launched.page, "open_workspace", {
      path: workspace,
    });
    for (const [key, value] of Object.entries(appSettings)) {
      await harness.invokeOk(launched.page, "db_execute", {
        sql: "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
        params: [key, String(value)],
        method: "run",
      });
    }
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
    // Create every secondary DB before global settings enable startup
    // auto-open. Launching another renderer between these native swaps can
    // race its startup hydration against the test-only DB preparation.
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
  } finally {
    await harness.close(launched.app, launched.page, "configure");
  }
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
  { phase, id, title, projectSettings = {} },
) {
  const prepared = await harness.launch(`${phase}/prepare-projects`);
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
    for (const [key, value] of Object.entries(projectSettings)) {
      await harness.invokeOk(prepared.page, "db_execute", {
        sql: `INSERT OR REPLACE INTO project_settings
          (project_id, key, value)
          VALUES (?, ?, ?)`,
        params: [projectA.id, key, String(value)],
        method: "run",
      });
    }
    return {
      projectA: {
        id: String(projectA.id),
        title: String(projectA.title),
      },
      projectB: { id, title },
    };
  } finally {
    await harness.close(
      prepared.app,
      prepared.page,
      `${phase}/prepare-projects`,
    );
  }
}

async function prepareProjectSettings(harness, phase, settings) {
  const prepared = await harness.launch(`${phase}/prepare-settings`);
  try {
    await prepared.page
      .getByTestId("project-menu-trigger")
      .waitFor({ state: "visible", timeout: 30_000 });
    const project = await currentProjectRow(harness, prepared.page);
    for (const [key, value] of Object.entries(settings)) {
      await harness.invokeOk(prepared.page, "db_execute", {
        sql: `INSERT OR REPLACE INTO project_settings
          (project_id, key, value)
          VALUES (?, ?, ?)`,
        params: [project.id, key, String(value)],
        method: "run",
      });
    }
    return {
      id: String(project.id),
      title: String(project.title),
    };
  } finally {
    await harness.close(
      prepared.app,
      prepared.page,
      `${phase}/prepare-settings`,
    );
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

function assertCompletedChatAuthority(rows, { prompt, label }) {
  if (
    !rows.some(
      (row) =>
        row.role === "user" && String(row.content ?? "").includes(prompt),
    )
  ) {
    throw new Error(`${label} did not persist the user prompt`);
  }
  for (const marker of [CHAT_AUTHORITY_EARLY, CHAT_AUTHORITY_LATE]) {
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

function parseMcpTextResult(result, label) {
  const textBlock = result?.content?.find(
    (item) => item?.type === "text" && typeof item.text === "string",
  );
  if (!textBlock) {
    throw new Error(`${label} did not return a text content block`);
  }
  try {
    return JSON.parse(textBlock.text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${textBlock.text}`, {
      cause: error,
    });
  }
}

async function findProseStage(harness, page, stagingId) {
  const rows = await queryRows(
    harness,
    page,
    `SELECT id, project_id AS projectId, scene_id AS sceneId,
      proposed_content AS proposedContent, base_version AS baseVersion,
      status, source_surface AS sourceSurface,
      source_session_id AS sourceSessionId
     FROM prose_staging
     WHERE id = ?`,
    [stagingId],
  );
  return rows[0] ?? null;
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

async function runChatStreamProjectSwitchJourney(harness) {
  const workspace = harness.workspacePath("chat-stream-project-switch");
  await configureWorkspace(harness, workspace, {
    deterministicAi: true,
  });
  const projects = await prepareSecondProject(harness, {
    phase: "chat-stream-project-switch",
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

async function runEditorPendingProjectSwitchJourney(harness) {
  const workspace = harness.workspacePath("editor-pending-project-switch");
  await configureWorkspace(harness, workspace, {
    appSettings: {
      "editor.autoSaveDelay": PENDING_SAVE_AUTOSAVE_DELAY_MS,
    },
  });
  const projects = await prepareSecondProject(harness, {
    phase: "editor-pending-project-switch",
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

async function runMcpExternalWriteConflictJourney(harness) {
  const workspace = harness.workspacePath("mcp-external-write-conflict");
  await configureWorkspace(harness, workspace, {
    appSettings: {
      "editor.autoSaveDelay": PENDING_SAVE_AUTOSAVE_DELAY_MS,
    },
  });
  const preparedProject = await prepareProjectSettings(
    harness,
    "mcp-external-write-conflict",
    {
      "ai.autoAcceptBodyProposals": true,
    },
  );

  const external = await harness.launch("mcp-external-write-conflict");
  let mcpClient = null;
  let dirtyStagingId = null;
  let journeyFailure = null;
  try {
    const clean = await createSceneThroughUi(harness, external.page);
    if (clean.projectId !== preparedProject.id) {
      throw new Error("MCP journey started under the wrong project");
    }
    mcpClient = await launchProductJourneyMcpClient({
      binaryPath: mcpBinary,
      workspacePath: workspace,
      projectId: clean.projectId,
      onStderr: (chunk) =>
        process.stderr.write(
          `  [product:mcp-external-write-conflict:mcp] ${String(chunk)}`,
        ),
    });
    const tools = await mcpClient.listTools();
    if (
      !Array.isArray(tools.tools) ||
      !tools.tools.some((tool) => tool?.name === "propose_scene_body")
    ) {
      throw new Error("MCP server did not advertise propose_scene_body");
    }

    const cleanResult = parseMcpTextResult(
      await mcpClient.callTool("propose_scene_body", {
        scene_id: clean.sceneId,
        text: MCP_CLEAN_EXTERNAL_TEXT,
        mode: "append",
      }),
      "clean propose_scene_body",
    );
    if (
      cleanResult.scene_id !== clean.sceneId ||
      cleanResult.status !== "proposed" ||
      typeof cleanResult.staging_id !== "string"
    ) {
      throw new Error(
        `clean MCP proposal returned an invalid authority result: ${JSON.stringify(cleanResult)}`,
      );
    }
    const cleanEvidence = await harness.waitUntil(async () => {
      const [stage, scene] = await Promise.all([
        findProseStage(harness, external.page, cleanResult.staging_id),
        findSceneById(harness, external.page, clean.sceneId),
      ]);
      return stage?.status === "accepted" &&
        stage.sourceSurface === "mcp" &&
        String(scene?.content ?? "").includes(MCP_CLEAN_EXTERNAL_TEXT)
        ? { stage, scene }
        : null;
    }, "MCP clean auto-apply");
    await clean.editor
      .locator(`text=${MCP_CLEAN_EXTERNAL_TEXT}`)
      .waitFor({ state: "visible", timeout: 30_000 });
    if (
      await clean.editorSurface.getByTestId("external-edit-conflict").count()
    ) {
      throw new Error("clean MCP external write incorrectly opened a conflict");
    }
    const cleanEvents = await queryRows(
      harness,
      external.page,
      `SELECT session_id AS sessionId, domain, op_type AS opType,
        entity_id AS entityId
       FROM change_events
       WHERE entity_id = ? AND domain = 'prose' AND op_type = 'prose.propose'`,
      [cleanResult.staging_id],
    );
    if (
      cleanEvents.length !== 1 ||
      cleanEvents[0].sessionId !== cleanEvidence.stage.sourceSessionId
    ) {
      throw new Error(
        "clean MCP proposal did not retain its external writer session",
      );
    }
    harness.recordTimeline("mcp-clean-external-write-reloaded", {
      workspace,
      projectId: clean.projectId,
      sceneId: clean.sceneId,
      stagingId: cleanResult.staging_id,
      sourceSurface: cleanEvidence.stage.sourceSurface,
      status: cleanEvidence.stage.status,
      conflict: false,
    });

    const dirty = await createSceneThroughUi(harness, external.page);
    await dirty.editor.click();
    await external.page.keyboard.type(MCP_DIRTY_LOCAL_TEXT);
    if (
      await findSceneWithTextForProject(
        harness,
        external.page,
        dirty.projectId,
        MCP_DIRTY_LOCAL_TEXT,
      )
    ) {
      throw new Error("dirty MCP setup autosaved before the proposal");
    }
    const dirtyResult = parseMcpTextResult(
      await mcpClient.callTool("propose_scene_body", {
        scene_id: dirty.sceneId,
        text: MCP_DIRTY_EXTERNAL_TEXT,
        mode: "append",
      }),
      "dirty propose_scene_body",
    );
    dirtyStagingId = String(dirtyResult.staging_id ?? "");
    if (
      dirtyResult.scene_id !== dirty.sceneId ||
      dirtyResult.status !== "proposed" ||
      !dirtyStagingId
    ) {
      throw new Error(
        `dirty MCP proposal returned an invalid authority result: ${JSON.stringify(dirtyResult)}`,
      );
    }

    const conflict = dirty.editorSurface.getByTestId("external-edit-conflict");
    await conflict.waitFor({ state: "visible", timeout: 30_000 });
    const dirtyEvidence = await harness.waitUntil(async () => {
      const [stage, scene] = await Promise.all([
        findProseStage(harness, external.page, dirtyStagingId),
        findSceneById(harness, external.page, dirty.sceneId),
      ]);
      return stage?.status === "proposed" &&
        stage.sourceSurface === "mcp" &&
        String(stage.proposedContent ?? "").includes(MCP_DIRTY_EXTERNAL_TEXT) &&
        String(scene?.content ?? "").includes(MCP_DIRTY_LOCAL_TEXT) &&
        !String(scene?.content ?? "").includes(MCP_DIRTY_EXTERNAL_TEXT)
        ? { stage, scene }
        : null;
    }, "MCP dirty stale conflict");
    if (!(await dirty.editor.textContent())?.includes(MCP_DIRTY_LOCAL_TEXT)) {
      throw new Error("dirty MCP conflict overwrote the local editor draft");
    }
    harness.recordTimeline("mcp-dirty-external-write-conflict", {
      workspace,
      projectId: dirty.projectId,
      sceneId: dirty.sceneId,
      stagingId: dirtyStagingId,
      sourceSurface: dirtyEvidence.stage.sourceSurface,
      status: dirtyEvidence.stage.status,
      localDraftPersisted: true,
      externalProposalApplied: false,
      conflict: true,
    });

    const reject = external.page.getByRole("button", {
      name: /Reject/,
    });
    await reject.waitFor({ state: "visible", timeout: 30_000 });
    await external.page.keyboard.press("Escape");
    await harness.waitUntil(async () => {
      const stage = await findProseStage(
        harness,
        external.page,
        dirtyStagingId,
      );
      return stage?.status === "discarded" ? stage : null;
    }, "MCP stale proposal discard");
    await conflict.getByTestId("external-edit-keep").click();
    await conflict.waitFor({ state: "detached", timeout: 30_000 });
    log(
      "MCP external write: clean auto-apply and dirty stale conflict both passed",
    );
  } catch (error) {
    journeyFailure = error;
    throw error;
  } finally {
    if (!external.page.isClosed()) {
      if (dirtyStagingId) {
        const stage = await findProseStage(
          harness,
          external.page,
          dirtyStagingId,
        ).catch(() => null);
        if (stage?.status === "proposed") {
          await external.page.keyboard.press("Escape").catch(() => undefined);
          const afterEscape = await findProseStage(
            harness,
            external.page,
            dirtyStagingId,
          ).catch(() => null);
          if (afterEscape?.status === "proposed") {
            await harness
              .invokeOk(external.page, "agent_discard_prose_stage", {
                payload: {
                  projectId: preparedProject.id,
                  sessionId: "product-journey-cleanup",
                  stagingId: dirtyStagingId,
                },
              })
              .catch(() => undefined);
          }
        }
      }
      const visibleKeep = external.page.locator(
        '[data-testid="external-edit-conflict"]:visible [data-testid="external-edit-keep"]',
      );
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if ((await visibleKeep.count()) === 0) break;
        await visibleKeep
          .first()
          .click()
          .then(() => external.page.waitForTimeout(250))
          .catch(() => undefined);
      }
    }
    await mcpClient?.close().catch((error) => {
      if (!journeyFailure) throw error;
      console.error(
        `[electron:product] MCP cleanup failed after the primary assertion: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    try {
      await harness.close(
        external.app,
        external.page,
        "mcp-external-write-conflict",
      );
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
    await harness.waitUntil(
      async () =>
        (await scene.editor.textContent())?.includes(AUTHORING_OUTPUT),
      "AI output insertion into editor",
      10_000,
    );

    await scene.editor.click();
    await authoring.page.keyboard.press("Control+z");
    await harness.waitUntil(
      async () =>
        !(await scene.editor.textContent())?.includes(AUTHORING_OUTPUT),
      "editor undo after chat insertion",
      10_000,
    );
    await authoring.page.keyboard.press("Control+Shift+z");
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
    id: "chat-stream-workspace-switch",
    run: runChatStreamWorkspaceSwitchJourney,
  },
  {
    id: "editor-pending-project-switch",
    run: runEditorPendingProjectSwitchJourney,
  },
  {
    id: "mcp-external-write-conflict",
    run: runMcpExternalWriteConflictJourney,
  },
  ...NATIVE_ROUND_TRIP_JOURNEYS,
];

export function resolveSelectedProductJourneys(journeys, serializedIds) {
  if (serializedIds === undefined) return journeys;

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

function resolveResultsPath(resultsPath) {
  if (resultsPath) return path.resolve(rootDir, resultsPath);
  const artifactDir =
    process.env.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR ??
    DEFAULT_PRODUCT_JOURNEY_ARTIFACT_DIR;
  return path.resolve(rootDir, artifactDir, "results.json");
}

async function writeResults(resultsPath, report) {
  await mkdir(path.dirname(resultsPath), { recursive: true });
  await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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
  assertArtifacts = assertBuildArtifacts,
  clock = () => performance.now(),
  resultsPath,
} = {}) {
  const outputPath = resolveResultsPath(resultsPath);
  const report = {
    version: PRODUCT_JOURNEY_RESULTS_VERSION,
    status: "passed",
    journeys: [],
  };

  try {
    await assertArtifacts(journeys);
  } catch (error) {
    report.status = "failed";
    report.error = serializeError(error);
    report.journeys.push(
      ...notRunResults(journeys, "Artifact preflight failed."),
    );
    await writeResults(outputPath, report);
    throw error;
  }

  const factory =
    createHarness ??
    (() =>
      createProductJourneyHarness({
        mainCjs,
      }));
  for (const [index, journey] of journeys.entries()) {
    const startedAt = clock();
    let durationMs = null;
    let harness = null;
    try {
      harness = factory();
      await journey.run(harness);
      durationMs = elapsedMilliseconds(clock, startedAt);
      const diagnostics = normalizeProductJourneyDiagnostics(
        await harness.finalizeDiagnostics?.(),
      );
      await harness.dispose({ success: true, name: journey.id });
      report.journeys.push({
        id: journey.id,
        status: "passed",
        durationMs,
        ...diagnostics,
      });
      log(`${journey.id}: PASS`);
    } catch (error) {
      durationMs ??= elapsedMilliseconds(clock, startedAt);
      report.status = "failed";
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
      report.journeys.push(failedResult);
      report.journeys.push(
        ...notRunResults(
          journeys.slice(index + 1),
          `Fail-fast after ${journey.id}.`,
        ),
      );
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
      await writeResults(outputPath, report);
      throw new Error(`${journey.id}: ${error?.stack ?? error}`, {
        cause: error,
      });
    }
  }
  await writeResults(outputPath, report);
  return report;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const selectedJourneys = resolveSelectedProductJourneys(
    PRODUCT_JOURNEYS,
    process.env.GRIMODEX_PRODUCT_JOURNEY_IDS,
  );
  runProductJourneys({ journeys: selectedJourneys }).then(
    () => log("PASS — product journeys completed"),
    (error) => {
      console.error(`[electron:product] FAIL: ${error?.stack ?? error}`);
      process.exitCode = 1;
    },
  );
}
