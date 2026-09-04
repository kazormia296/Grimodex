import { describe, it, expect, beforeEach, vi } from "vitest";
const { mockRecordChangeEvent } = vi.hoisted(() => ({
  mockRecordChangeEvent: vi.fn(),
}));

vi.mock("@/features/timelapse/recorder", () => ({
  recordChangeEvent: mockRecordChangeEvent,
}));

import {
  deleteProjectSetting,
  getSetting,
  getProjectSetting,
  NATIVE_OWNED_PROJECT_SETTING_ERROR,
  setSetting,
  setProjectSetting,
  getSettingsByPrefix,
  deleteSetting,
} from "./api";
import { SCAN_IMPORT_STATE_KEY } from "@/features/import/scan/scanImportState";

// Uses the browser-mock DB (in-memory SQLite via sql.js)

beforeEach(async () => {
  // Clean up settings between tests
  const { db } = await import("@/db/client");
  const { appSettings, projectSettings } = await import("@/db/schema");
  await db.delete(appSettings);
  await db.delete(projectSettings);
  mockRecordChangeEvent.mockClear();
});

describe("settings api", () => {
  it("returns null for missing key", async () => {
    expect(await getSetting("no.such.key")).toBeNull();
  });

  it("sets and gets a value", async () => {
    await setSetting("editor.fontSize", "20");
    expect(await getSetting("editor.fontSize")).toBe("20");
  });

  it("upserts on duplicate key", async () => {
    await setSetting("editor.fontSize", "18");
    await setSetting("editor.fontSize", "22");
    expect(await getSetting("editor.fontSize")).toBe("22");
  });

  it("deletes a key", async () => {
    await setSetting("display.theme", "dark");
    await deleteSetting("display.theme");
    expect(await getSetting("display.theme")).toBeNull();
  });

  it("getSettingsByPrefix returns matching keys", async () => {
    await setSetting("editor.fontSize", "16");
    await setSetting("editor.lineHeight", "1.8");
    await setSetting("display.theme", "dark");
    const result = await getSettingsByPrefix("editor.");
    expect(result["editor.fontSize"]).toBe("16");
    expect(result["editor.lineHeight"]).toBe("1.8");
    expect(result["display.theme"]).toBeUndefined();
  });

  it("stores editor tab UI state per project without timelapse noise", async () => {
    await setProjectSetting(
      "default-project",
      "editor.tabState",
      '{"tabs":[]}',
    );

    expect(await getProjectSetting("default-project", "editor.tabState")).toBe(
      '{"tabs":[]}',
    );
    expect(await getProjectSetting("project-b", "editor.tabState")).toBeNull();
    expect(mockRecordChangeEvent).not.toHaveBeenCalled();

    await deleteProjectSetting("default-project", "editor.tabState");
    expect(mockRecordChangeEvent).not.toHaveBeenCalled();
  });

  it("rejects direct mutation of the Native-owned Scan state key before DB or event writes", async () => {
    await expect(
      setProjectSetting("default-project", SCAN_IMPORT_STATE_KEY, "staging"),
    ).rejects.toThrow(NATIVE_OWNED_PROJECT_SETTING_ERROR);
    expect(
      await getProjectSetting("default-project", SCAN_IMPORT_STATE_KEY),
    ).toBeNull();
    expect(mockRecordChangeEvent).not.toHaveBeenCalled();

    await expect(
      deleteProjectSetting("default-project", SCAN_IMPORT_STATE_KEY),
    ).rejects.toThrow(NATIVE_OWNED_PROJECT_SETTING_ERROR);
    expect(mockRecordChangeEvent).not.toHaveBeenCalled();
  });
});
