#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { rootDir } from "./build.mjs";
import { createProductJourneyHarness } from "./product-journey-harness.mjs";

const mainCjs = path.join(rootDir, "dist-electron", "main.cjs");
const DEFAULT_SCENE_TITLE = "シーン 1";
const SCENES_PANEL_TITLE = "シーン";
const CREATE_BUTTON_TITLE = "新規作成";
const NEW_SCENE_MENU_ITEM = "New scene";
const JOURNEY_TEXT = `PRODUCT-JOURNEY-${Date.now()}`;
const PENDING_SAVE_TEXT = `PENDING-SAVE-JOURNEY-${Date.now()}`;
const CLEAN_EXTERNAL_TEXT = `CLEAN-EXTERNAL-JOURNEY-${Date.now()}`;
const DIRTY_LOCAL_TEXT = `DIRTY-LOCAL-JOURNEY-${Date.now()}`;
const DIRTY_EXTERNAL_TEXT = `DIRTY-EXTERNAL-JOURNEY-${Date.now()}`;
const CHAT_AUTHORITY_PROMPT = `CHAT-AUTHORITY-JOURNEY-${Date.now()}`;
const CHAT_AUTHORITY_EARLY = "AUTHORITY-OLD-EARLY";
const CHAT_AUTHORITY_LATE = "AUTHORITY-OLD-LATE";
const CODEX_CONTEXT_MARKER = "CODEX-CONTEXT-JOURNEY";
const AUTHORING_PROMPT = `AUTHORING-JOURNEY-${Date.now()}`;
const AUTHORING_OUTPUT = "AUTHORING-AI-OUTPUT";
const PRODUCT_JOURNEY_MODEL = "product-journey-model";
const PENDING_SAVE_AUTOSAVE_DELAY_MS = 60_000;
const PRODUCT_JOURNEY_RESULTS_VERSION = 1;
const DEFAULT_PRODUCT_JOURNEY_ARTIFACT_DIR = path.join(
  rootDir,
  ".artifacts",
  "product-journeys",
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

function assertBuildArtifacts() {
  for (const artifact of [
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
  ]) {
    if (!existsSync(artifact)) {
      throw new Error(
        `missing Electron product journey artifact: ${artifact}\nRun pnpm napi:build and pnpm electron:build first.`,
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

async function configureWorkspace(
  harness,
  workspace,
  { appSettings = {}, deterministicAi = false } = {},
) {
  await mkdir(workspace, { recursive: true });
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
    const settings = await harness.invokeOk(
      launched.page,
      "get_global_settings",
    );
    await harness.invokeOk(launched.page, "save_global_settings", {
      settings: {
        ...settings,
        lastActiveWorkspace: workspace,
        trustedWorkspaces: [workspace],
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

async function findSceneById(harness, page, sceneId) {
  const result = await harness.invokeOk(page, "db_execute", {
    sql: "SELECT id, project_id AS projectId, title, content FROM tree_nodes WHERE id = ? AND node_type = 'scene'",
    params: [sceneId],
    method: "all",
  });
  return result?.rows?.[0] ?? null;
}

async function listChatAuthorityRows(harness, page, projectId) {
  const result = await harness.invokeOk(page, "db_execute", {
    sql: `SELECT
      s.id AS sessionId,
      s.node_id AS nodeId,
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
    const now = new Date().toISOString();
    await harness.invokeOk(prepared.page, "db_execute_batch", {
      statements: [
        {
          sql: `INSERT OR IGNORE INTO codex_types
            (id, project_id, slug, label, color, is_builtin, sort_order, created_at)
            VALUES (?, ?, 'character', 'Character', '#888888', 1, 0, ?)`,
          params: [`product-character-${projectId}`, projectId, now],
          method: "run",
        },
        {
          sql: `INSERT INTO codex_entries
            (id, project_id, type, name, summary, content, context_mode, created_at, updated_at)
            VALUES (?, ?, 'character', ?, ?, ?, 'mentioned', ?, ?)`,
          params: [
            entryId,
            projectId,
            "Product Journey Codex",
            CODEX_CONTEXT_MARKER,
            sceneDocument(CODEX_CONTEXT_MARKER),
            now,
            now,
          ],
          method: "run",
        },
      ],
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
  await harness.invokeOk(page, "db_execute_batch", {
    statements: [
      {
        sql: "UPDATE tree_nodes SET content = ?, char_count = ?, version = version + 1, updated_at = ? WHERE id = ? AND project_id = ?",
        params: [
          content,
          text.length,
          new Date(now).toISOString(),
          sceneId,
          projectId,
        ],
        method: "run",
      },
      {
        sql: `INSERT INTO change_events
          (event_uid, project_id, scene_id, domain, op_type, entity_type, entity_id, payload, session_id, sequence, timestamp, prev_hash, hash)
          VALUES (?, ?, ?, 'editor', 'scene.content_update', 'tree_batch', ?, ?, 'external-product-journey',
            (SELECT COALESCE(MAX(sequence), 0) + 1 FROM change_events WHERE project_id = ?),
            ?, ?, ?)`,
        params: [
          eventUid,
          projectId,
          sceneId,
          sceneId,
          JSON.stringify({ sceneId }),
          projectId,
          now,
          `prev-${eventUid}`,
          `hash-${eventUid}`,
        ],
        method: "run",
      },
    ],
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

  const editorSurface = page
    .locator(
      '[data-editor-loaded-document-id][data-editor-document-loading="false"]:visible',
    )
    .last();
  await editorSurface.waitFor({ state: "visible", timeout: 30_000 });
  const sceneId = await editorSurface.getAttribute(
    "data-editor-loaded-document-id",
  );
  if (!sceneId) throw new Error("new scene did not expose a document id");
  const created = await harness.waitUntil(
    () => findSceneById(harness, page, sceneId),
    "new scene persistence",
    10_000,
  );
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
  });
  await mkdir(workspaceB, { recursive: true });

  const prepare = await harness.launch("workspace-switch/prepare");
  try {
    await harness.invokeOk(prepare.page, "open_workspace", {
      path: workspaceB,
    });
    const settings = await harness.invokeOk(
      prepare.page,
      "get_global_settings",
    );
    await harness.invokeOk(prepare.page, "save_global_settings", {
      settings: {
        ...settings,
        lastActiveWorkspace: workspaceB,
        trustedWorkspaces: [workspaceA, workspaceB],
        showLauncherOnStartup: false,
        hasSeenWelcome: true,
        acceptedEulaVersion: readEulaVersion(),
        lastSeenReleaseNotesVersion: appVersion(),
      },
    });
    await harness.invokeOk(prepare.page, "open_workspace", {
      path: workspaceA,
    });
    const restoredSettings = await harness.invokeOk(
      prepare.page,
      "get_global_settings",
    );
    await harness.invokeOk(prepare.page, "save_global_settings", {
      settings: {
        ...restoredSettings,
        lastActiveWorkspace: workspaceA,
        trustedWorkspaces: [workspaceA, workspaceB],
        showLauncherOnStartup: false,
        hasSeenWelcome: true,
        acceptedEulaVersion: readEulaVersion(),
        lastSeenReleaseNotesVersion: appVersion(),
      },
    });
  } finally {
    await harness.close(prepare.app, prepare.page, "workspace-switch/prepare");
  }

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
];

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
    await assertArtifacts();
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
      await harness.dispose({ success: true, name: journey.id });
      report.journeys.push({
        id: journey.id,
        status: "passed",
        durationMs,
      });
      log(`${journey.id}: PASS`);
    } catch (error) {
      durationMs ??= elapsedMilliseconds(clock, startedAt);
      report.status = "failed";
      const failedResult = {
        id: journey.id,
        status: "failed",
        durationMs,
        error: serializeError(error),
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
  runProductJourneys().then(
    () => log("PASS — product journeys completed"),
    (error) => {
      console.error(`[electron:product] FAIL: ${error?.stack ?? error}`);
      process.exitCode = 1;
    },
  );
}
