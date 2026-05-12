import { describe, it, expect, vi, beforeEach } from "vitest";

// Uses the browser-mock DB (in-memory SQLite via sql.js)

beforeEach(async () => {
  const { db } = await import("@/db/client");
  const { appSettings, projectSettings } = await import("@/db/schema");
  await db.delete(appSettings);
  await db.delete(projectSettings);
});

describe("migrateAppSettingsToScopedStores", () => {
  const mockUpdateGlobalSettings = vi.fn().mockResolvedValue(undefined);
  const mockGetState = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({
      globalSettings: { userPreferences: {} },
      updateGlobalSettings: mockUpdateGlobalSettings,
    });
    vi.doMock("@/features/workspace/store", () => ({
      useWorkspaceStore: { getState: mockGetState },
    }));
  });

  it("skips migration if already at version 1", async () => {
    const { setSetting } = await import("./api");
    await setSetting("meta.settingsSchemaVersion", "1");

    const { migrateAppSettingsToScopedStores } = await import("./migration");
    await migrateAppSettingsToScopedStores();

    expect(mockUpdateGlobalSettings).not.toHaveBeenCalled();
  });

  it("migrates global keys to userPreferences", async () => {
    const { setSetting } = await import("./api");
    await setSetting("editor.fontFamily", "sans-serif");
    await setSetting("editor.fontSize", "16");

    const { migrateAppSettingsToScopedStores } = await import("./migration");
    await migrateAppSettingsToScopedStores();

    expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        userPreferences: expect.objectContaining({
          "editor.fontFamily": "sans-serif",
          "editor.fontSize": "16",
        }),
      }),
    );
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

    // updateGlobalSettings called only once
    expect(mockUpdateGlobalSettings).toHaveBeenCalledTimes(1);
  });
});

describe("seedProjectSettingsFromDefaults", () => {
  const mockGetState = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.doMock("@/features/workspace/store", () => ({
      useWorkspaceStore: { getState: mockGetState },
    }));
  });

  it("is a no-op when projectDefaults is empty", async () => {
    mockGetState.mockReturnValue({
      globalSettings: { projectDefaults: {} },
    });
    const { getProjectSetting } = await import("./api");
    const { seedProjectSettingsFromDefaults } = await import("./migration");
    await seedProjectSettingsFromDefaults();

    expect(
      await getProjectSetting("default-project", "export.format"),
    ).toBeNull();
  });

  it("seeds project_settings from projectDefaults when keys are absent", async () => {
    mockGetState.mockReturnValue({
      globalSettings: {
        projectDefaults: { "export.format": "epub", "beat.enabled": "true" },
      },
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

    mockGetState.mockReturnValue({
      globalSettings: {
        projectDefaults: { "export.format": "epub" },
      },
    });
    const { seedProjectSettingsFromDefaults } = await import("./migration");
    await seedProjectSettingsFromDefaults();

    // Pre-existing value must not be overwritten
    expect(await getProjectSetting("default-project", "export.format")).toBe(
      "plaintext",
    );
  });
});
