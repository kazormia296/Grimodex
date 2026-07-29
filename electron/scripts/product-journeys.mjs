#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { rootDir } from "./build.mjs";
import { createProductJourneyHarness } from "./product-journey-harness.mjs";

const mainCjs = path.join(rootDir, "dist-electron", "main.cjs");
const DEFAULT_SCENE_TITLE = "シーン 1";
const SCENES_PANEL_TITLE = "シーン";
const CREATE_BUTTON_TITLE = "新規作成";
const NEW_SCENE_MENU_ITEM = "New scene";
const JOURNEY_TEXT = `PRODUCT-JOURNEY-${Date.now()}`;

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

async function configureWorkspace(harness, workspace) {
  await mkdir(workspace, { recursive: true });
  const launched = await harness.launch("configure");
  try {
    await harness.invokeOk(launched.page, "open_workspace", {
      path: workspace,
    });
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
    sql: "SELECT id, title, content FROM tree_nodes WHERE id = ? AND node_type = 'scene'",
    params: [sceneId],
    method: "all",
  });
  return result?.rows?.[0] ?? null;
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

async function runEditorPersistenceJourney(harness) {
  const workspace = harness.workspacePath("editor-persistence");
  await configureWorkspace(harness, workspace);

  const writing = await harness.launch("editor-persistence/write");
  let sceneId;
  try {
    const header = scenesPanelHeader(writing.page);
    await header.waitFor({ state: "visible", timeout: 60_000 });
    await header.locator(`button[title="${CREATE_BUTTON_TITLE}"]`).click();
    await writing.page
      .getByRole("menuitem", { name: NEW_SCENE_MENU_ITEM, exact: true })
      .click();

    const renameInput = writing.page.locator(
      '[data-droptarget-id="scenes-panel"] input:focus',
    );
    if (
      await renameInput
        .waitFor({ state: "visible", timeout: 1_000 })
        .then(() => true)
        .catch(() => false)
    ) {
      await writing.page.keyboard.press("Enter");
    }

    const editorSurface = writing.page
      .locator(
        '[data-editor-loaded-document-id][data-editor-document-loading="false"]:visible',
      )
      .last();
    await editorSurface.waitFor({ state: "visible", timeout: 30_000 });
    sceneId = await editorSurface.getAttribute(
      "data-editor-loaded-document-id",
    );
    if (!sceneId) throw new Error("new scene did not expose a document id");
    const created = await harness.waitUntil(
      () => findSceneById(harness, writing.page, sceneId),
      "new scene persistence",
      10_000,
    );
    if (created.title !== DEFAULT_SCENE_TITLE) {
      throw new Error(`unexpected new scene title: ${String(created.title)}`);
    }

    const editor = editorSurface
      .locator('.ProseMirror[contenteditable="true"]')
      .first();
    await editor.waitFor({ state: "visible", timeout: 30_000 });
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

async function readJourneyMarker(harness, page) {
  const result = await harness.invokeOk(page, "db_execute", {
    sql: "SELECT value FROM app_settings WHERE key = ?",
    params: ["product.journey.workspace-a"],
    method: "all",
  });
  return result?.rows?.[0]?.value ?? null;
}

async function runWorkspaceSwitchAuthorityJourney(harness) {
  const workspaceA = harness.workspacePath("workspace-a");
  const workspaceB = harness.workspacePath("workspace-b");
  await configureWorkspace(harness, workspaceA);
  await mkdir(workspaceB, { recursive: true });

  const prepare = await harness.launch("workspace-switch/prepare");
  try {
    await harness.invokeOk(prepare.page, "db_execute", {
      sql: "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
      params: ["product.journey.workspace-a", "workspace-a-marker"],
      method: "run",
    });
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
  } finally {
    await harness.close(prepare.app, prepare.page, "workspace-switch/prepare");
  }

  const switched = await harness.launch("workspace-switch/ui");
  try {
    if (await readJourneyMarker(harness, switched.page)) {
      throw new Error("workspace B inherited workspace A app_settings");
    }
    await switched.page.getByTestId("workspace-menu-trigger").click();
    const dropdown = switched.page.getByTestId("workspace-menu-dropdown");
    await dropdown
      .getByRole("button", { name: "workspace-a", exact: true })
      .click();
    await harness.waitUntil(
      () => readJourneyMarker(harness, switched.page),
      "workspace A marker after UI switch",
      30_000,
    );
    log(
      "Workspace switch authority: UI switch preserved workspace-scoped data",
    );
  } finally {
    await harness.close(switched.app, switched.page, "workspace-switch/ui");
  }
}

export const PRODUCT_JOURNEYS = [
  { id: "editor-persistence", run: runEditorPersistenceJourney },
  {
    id: "workspace-switch-authority",
    run: runWorkspaceSwitchAuthorityJourney,
  },
];

export async function runProductJourneys({ createHarness } = {}) {
  assertBuildArtifacts();
  const factory =
    createHarness ??
    (() =>
      createProductJourneyHarness({
        mainCjs,
      }));
  for (const journey of PRODUCT_JOURNEYS) {
    const harness = factory();
    try {
      await journey.run(harness);
      await harness.dispose({ success: true, name: journey.id });
      log(`${journey.id}: PASS`);
    } catch (error) {
      await harness.dispose({ success: false, name: journey.id });
      throw new Error(`${journey.id}: ${error?.stack ?? error}`);
    }
  }
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
