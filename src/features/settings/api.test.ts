import { describe, it, expect, beforeEach } from "vitest";
import {
  getSetting,
  setSetting,
  getSettingsByPrefix,
  deleteSetting,
} from "./api";

// Uses the browser-mock DB (in-memory SQLite via sql.js)

beforeEach(async () => {
  // Clean up settings between tests
  const { db } = await import("@/db/client");
  const { settings } = await import("@/db/schema");
  await db.delete(settings);
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
});
