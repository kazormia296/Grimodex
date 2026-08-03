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
  setSetting,
  setProjectSetting,
  getSettingsByPrefix,
  deleteSetting,
} from "./api";

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
});
