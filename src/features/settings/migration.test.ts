import { describe, it, expect, vi, beforeEach } from "vitest";

// Uses the browser-mock DB (in-memory SQLite via sql.js)

const globalSettingsHarness = vi.hoisted(() => {
  type GlobalSettingsLike = Record<string, unknown>;
  let settings: GlobalSettingsLike = {};
  const read = vi.fn(async () => settings);
  const patch = vi.fn(
    async (updater: (current: GlobalSettingsLike) => GlobalSettingsLike) => {
      settings = updater(settings);
      return settings;
    },
  );
  const setSettings = (next: GlobalSettingsLike) => {
    settings = next;
  };
  return {
    read,
    patch,
    setSettings,
    getSettings: () => settings,
  };
});

function mockGlobalSettingsRepository(): void {
  vi.doMock("@/lib/globalSettings/repository", () => ({
    globalSettingsRepository: globalSettingsHarness,
  }));
}

beforeEach(async () => {
  const { db } = await import("@/db/client");
  const { appSettings, projectSettings } = await import("@/db/schema");
  await db.delete(appSettings);
  await db.delete(projectSettings);
});

describe("migrateAppSettingsToScopedStores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalSettingsHarness.setSettings({ userPreferences: {} });
    mockGlobalSettingsRepository();
  });

  it("skips migration if already at version 1", async () => {
    const { setSetting } = await import("./api");
    await setSetting("meta.settingsSchemaVersion", "1");

    const { migrateAppSettingsToScopedStores } = await import("./migration");
    await migrateAppSettingsToScopedStores();

    expect(globalSettingsHarness.patch).not.toHaveBeenCalled();
  });

  it("migrates global keys to userPreferences", async () => {
    const { setSetting } = await import("./api");
    await setSetting("editor.fontFamily", "sans-serif");
    await setSetting("editor.fontSize", "16");

    const { migrateAppSettingsToScopedStores } = await import("./migration");
    await migrateAppSettingsToScopedStores();

    expect(globalSettingsHarness.patch).toHaveBeenCalledOnce();
    expect(globalSettingsHarness.getSettings()).toMatchObject({
      userPreferences: {
        "editor.fontFamily": "sans-serif",
        "editor.fontSize": "16",
      },
    });
  });

  it("migrates project keys to project_settings", async () => {
    const { setSetting, getProjectSetting } = await import("./api");
    await setSetting("export.format", "docx");
    await setSetting("editor.targetCharCount", "40000");

    const { migrateAppSettingsToScopedStores } = await import("./migration");
    await migrateAppSettingsToScopedStores();

    expect(await getProjectSetting("default-project", "export.format")).toBe(
      "docx",
    );
    expect(
      await getProjectSetting("default-project", "editor.targetCharCount"),
    ).toBe("40000");
    // Global keys should not leak into project_settings
    expect(
      await getProjectSetting("default-project", "editor.fontFamily"),
    ).toBeNull();
  });

  it("does not overwrite existing project settings (idempotent)", async () => {
    const { setSetting, setProjectSetting, getProjectSetting } =
      await import("./api");
    await setSetting("export.format", "docx");
    await setProjectSetting("default-project", "export.format", "plaintext");

    const { migrateAppSettingsToScopedStores } = await import("./migration");
    await migrateAppSettingsToScopedStores();

    // Should keep the pre-existing project value, not overwrite with app_settings value
    expect(await getProjectSetting("default-project", "export.format")).toBe(
      "plaintext",
    );
  });

  it("sets schema version to 1 after migration", async () => {
    const { getSetting } = await import("./api");

    const { migrateAppSettingsToScopedStores } = await import("./migration");
    await migrateAppSettingsToScopedStores();

    expect(await getSetting("meta.settingsSchemaVersion")).toBe("1");
  });

  it("is idempotent — running twice skips second run", async () => {
    const { setSetting } = await import("./api");
    await setSetting("editor.fontFamily", "serif");

    const { migrateAppSettingsToScopedStores } = await import("./migration");
    await migrateAppSettingsToScopedStores();
    await migrateAppSettingsToScopedStores();

    // GlobalSettingsRepository.patch called only once
    expect(globalSettingsHarness.patch).toHaveBeenCalledOnce();
  });
});

describe("removeRetiredDisplaySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalSettingsHarness.setSettings({ userPreferences: {} });
    mockGlobalSettingsRepository();
  });

  it("removes retired layout and app-wide glass keys while preserving active preferences", async () => {
    globalSettingsHarness.setSettings({
      userPreferences: {
        "display.mochiLayout": "false",
        "display.cardLayout": "true",
        "display.glassEffectEnabled": "true",
        "display.glassTransparency": "30",
        "display.glassSurfacePanels": "true",
        "editor.fontSize": "16",
      },
    });

    const { removeRetiredDisplaySettings } = await import("./migration");
    await removeRetiredDisplaySettings();

    expect(globalSettingsHarness.patch).toHaveBeenCalledOnce();
    expect(globalSettingsHarness.getSettings()).toEqual({
      userPreferences: {
        "editor.fontSize": "16",
      },
    });
  });

  it("does not patch preferences when no retired key is present", async () => {
    globalSettingsHarness.setSettings({
      userPreferences: { "editor.fontSize": "16" },
    });

    const { removeRetiredDisplaySettings } = await import("./migration");
    await removeRetiredDisplaySettings();

    expect(globalSettingsHarness.patch).not.toHaveBeenCalled();
  });
});

describe("seedProjectSettingsFromDefaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalSettingsHarness.setSettings({ projectDefaults: {} });
    mockGlobalSettingsRepository();
  });

  it("is a no-op when projectDefaults is empty", async () => {
    globalSettingsHarness.setSettings({ projectDefaults: {} });
    const { getProjectSetting } = await import("./api");
    const { seedProjectSettingsFromDefaults } = await import("./migration");
    await seedProjectSettingsFromDefaults();

    expect(
      await getProjectSetting("default-project", "export.format"),
    ).toBeNull();
  });

  it("seeds project_settings from projectDefaults when keys are absent", async () => {
    globalSettingsHarness.setSettings({
      projectDefaults: { "export.format": "epub", "beat.enabled": "true" },
    });
    const { getProjectSetting } = await import("./api");
    const { seedProjectSettingsFromDefaults } = await import("./migration");
    await seedProjectSettingsFromDefaults();

    expect(await getProjectSetting("default-project", "export.format")).toBe(
      "epub",
    );
    expect(await getProjectSetting("default-project", "beat.enabled")).toBe(
      "true",
    );
  });

  it("skips keys already present in project_settings (idempotent)", async () => {
    const { setProjectSetting, getProjectSetting } = await import("./api");
    await setProjectSetting("default-project", "export.format", "plaintext");

    globalSettingsHarness.setSettings({
      projectDefaults: { "export.format": "epub" },
    });
    const { seedProjectSettingsFromDefaults } = await import("./migration");
    await seedProjectSettingsFromDefaults();

    // Pre-existing value must not be overwritten
    expect(await getProjectSetting("default-project", "export.format")).toBe(
      "plaintext",
    );
  });
});

describe("migrateModelRoleKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalSettingsHarness.setSettings({ userPreferences: {} });
    mockGlobalSettingsRepository();
  });

  it("旧 ai.inlineModel / ai.sessionTitleModel を role.inline / role.cheap へ移送し旧キーを除去する", async () => {
    globalSettingsHarness.setSettings({
      userPreferences: {
        "ai.inlineModel": "gpt-4o",
        "ai.sessionTitleModel": "gpt-4o-mini",
        "editor.fontSize": "16",
      },
    });

    const { migrateModelRoleKeys } = await import("./migration");
    await migrateModelRoleKeys();

    expect(globalSettingsHarness.patch).toHaveBeenCalledOnce();
    expect(globalSettingsHarness.getSettings()).toEqual({
      userPreferences: {
        "editor.fontSize": "16",
        "aiModel.role.inline": "gpt-4o",
        "aiModel.role.cheap": "gpt-4o-mini",
      },
    });
  });

  it("旧キーが無ければ no-op", async () => {
    globalSettingsHarness.setSettings({
      userPreferences: { "aiModel.role.inline": "gpt-4o" },
    });

    const { migrateModelRoleKeys } = await import("./migration");
    await migrateModelRoleKeys();

    expect(globalSettingsHarness.patch).not.toHaveBeenCalled();
  });

  it("ロール値が既にあれば上書きしない（旧キーはクリーンアップする）", async () => {
    globalSettingsHarness.setSettings({
      userPreferences: {
        "ai.inlineModel": "gpt-4o",
        "aiModel.role.inline": "claude-opus-4-8",
      },
    });

    const { migrateModelRoleKeys } = await import("./migration");
    await migrateModelRoleKeys();

    expect(globalSettingsHarness.getSettings()).toEqual({
      userPreferences: {
        "aiModel.role.inline": "claude-opus-4-8",
      },
    });
  });

  it("空文字の旧値は移送せずクリーンアップのみ（ロールは未設定のまま）", async () => {
    globalSettingsHarness.setSettings({
      userPreferences: {
        "ai.sessionTitleModel": "",
        "editor.fontSize": "16",
      },
    });

    const { migrateModelRoleKeys } = await import("./migration");
    await migrateModelRoleKeys();

    expect(globalSettingsHarness.getSettings()).toEqual({
      userPreferences: {
        "editor.fontSize": "16",
      },
    });
  });
});
