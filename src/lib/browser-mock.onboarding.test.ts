// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

const GLOBAL_SETTINGS_KEY = "grimodex:global-settings";
const SCREENSHOT_MODE_KEY = "grimodex:screenshot-mode";
const TUTORIAL_PROJECT_ID = "grimodex-tutorial-project";

describe("BrowserMock onboarding", () => {
  let mock: PersistentBrowserMock | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    mock?.close();
    mock = null;
    localStorage.clear();
  });

  it("returns native-equivalent empty settings on a normal first launch", async () => {
    mock = await createBrowserMock({ allowProtectedWriterTestFixtures: true });

    await expect(mock.invoke("get_global_settings")).resolves.toMatchObject({
      recentWorkspaces: [],
      lastActiveWorkspace: null,
      theme: "system",
      uiLanguage: "ja",
      uiScale: 100,
      showLauncherOnStartup: false,
      hasSeenWelcome: false,
    });
  });

  it("preserves saved first-run preferences while no workspace exists", async () => {
    localStorage.setItem(
      GLOBAL_SETTINGS_KEY,
      JSON.stringify({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "dark",
        uiLanguage: "en",
        uiScale: 110,
        showLauncherOnStartup: false,
        hasSeenWelcome: true,
      }),
    );
    mock = await createBrowserMock({ allowProtectedWriterTestFixtures: true });

    await expect(mock.invoke("get_global_settings")).resolves.toMatchObject({
      recentWorkspaces: [],
      lastActiveWorkspace: null,
      theme: "dark",
      uiLanguage: "en",
      uiScale: 110,
      hasSeenWelcome: true,
    });
  });

  it("retains automatic workspace bootstrap for screenshot staging", async () => {
    localStorage.setItem(SCREENSHOT_MODE_KEY, "true");
    mock = await createBrowserMock({ allowProtectedWriterTestFixtures: true });

    await expect(mock.invoke("get_global_settings")).resolves.toMatchObject({
      recentWorkspaces: [
        expect.objectContaining({
          path: "/dev/workspace",
        }),
      ],
      lastActiveWorkspace: "/dev/workspace",
    });
  });

  it("seeds an isolated tutorial project without replacing browser manuscripts", async () => {
    mock = await createBrowserMock({ allowProtectedWriterTestFixtures: true });
    await mock.invoke("db_execute", {
      sql: "UPDATE projects SET title = ? WHERE id = 'default-project'",
      params: ["My browser manuscript"],
      method: "run",
    });

    const seeded = await mock.invoke<{ path: string; projectId: string }>(
      "seed_sample_workspace",
      {
        language: "ja",
        aiPolicy: '{"preset":"off"}',
      },
    );

    expect(seeded).toEqual({
      path: "/dev/workspace",
      projectId: TUTORIAL_PROJECT_ID,
    });

    const projects = await mock.invoke<{ rows: Record<string, unknown>[] }>(
      "db_execute",
      {
        sql: "SELECT id, title, language, ai_policy, is_sample FROM projects ORDER BY id",
        params: [],
        method: "all",
      },
    );
    expect(projects.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "default-project",
          title: "My browser manuscript",
          is_sample: 0,
        }),
        expect.objectContaining({
          id: TUTORIAL_PROJECT_ID,
          title: "蒼穹の試練",
          language: "ja",
          ai_policy: '{"preset":"off"}',
          is_sample: 1,
        }),
      ]),
    );

    const tutorialCounts = await mock.invoke<{
      rows: Array<{
        scenes: number;
        codexEntries: number;
        chatMessages: number;
      }>;
    }>("db_execute", {
      sql: `SELECT
        (SELECT COUNT(*) FROM tree_nodes WHERE project_id = ?) AS scenes,
        (SELECT COUNT(*) FROM codex_entries WHERE project_id = ?) AS codexEntries,
        (SELECT COUNT(*) FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id WHERE s.project_id = ?) AS chatMessages`,
      params: [TUTORIAL_PROJECT_ID, TUTORIAL_PROJECT_ID, TUTORIAL_PROJECT_ID],
      method: "all",
    });
    expect(tutorialCounts.rows[0]).toMatchObject({
      scenes: 6,
      codexEntries: 5,
      chatMessages: 4,
    });

    // Opening Codex management can create per-type field definitions. Their
    // composite FK intentionally RESTRICTs codex_types, so a restart must
    // remove them before replacing the tutorial Project.
    await mock.invoke("db_execute", {
      sql: `INSERT INTO codex_detail_definitions
        (id, project_id, type_slug, name)
       VALUES (?, ?, 'character', ?)`,
      params: ["tutorial-field-definition", TUTORIAL_PROJECT_ID, "Age"],
      method: "run",
    });

    const tutorialRoot = await mock.invoke<{
      rows: Array<{ id: string }>;
    }>("db_execute", {
      sql: "SELECT id FROM tree_nodes WHERE project_id = ? AND parent_id IS NULL ORDER BY sort_order LIMIT 1",
      params: [TUTORIAL_PROJECT_ID],
      method: "all",
    });
    await mock.invoke("db_execute", {
      sql: "UPDATE tree_nodes SET project_id = 'default-project' WHERE id = ?",
      params: [tutorialRoot.rows[0]?.id],
      method: "run",
    });

    await mock.invoke("seed_sample_workspace", {
      language: "ja",
      aiPolicy: '{"preset":"off"}',
    });
    const rerun = await mock.invoke<{ rows: Array<{ count: number }> }>(
      "db_execute",
      {
        sql: "SELECT COUNT(*) AS count FROM projects WHERE id = ?",
        params: [TUTORIAL_PROJECT_ID],
        method: "all",
      },
    );
    expect(rerun.rows[0]?.count).toBe(1);
  });
});
