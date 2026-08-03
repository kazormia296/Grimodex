import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DEVELOPMENT_APP_NAME,
  LINUX_DESKTOP_NAME,
  PRODUCTION_APP_NAME,
  configureAppUserData,
  resolveUserDataConfiguration,
} from "./userData.js";

describe("resolveUserDataConfiguration", () => {
  it("uses an absolute override before development or packaged defaults", () => {
    expect(
      resolveUserDataConfiguration({
        isPackaged: false,
        platform: "linux",
        env: { GRIMODEX_USER_DATA_DIR: "/tmp/grimodex-smoke" },
        homeDir: "/home/writer",
        appDataDir: "/home/writer/.config",
      }),
    ).toEqual({
      appName: DEVELOPMENT_APP_NAME,
      userDataDir: "/tmp/grimodex-smoke",
    });
  });

  it("rejects a relative override instead of falling back", () => {
    expect(() =>
      resolveUserDataConfiguration({
        isPackaged: true,
        platform: "linux",
        env: { GRIMODEX_USER_DATA_DIR: "relative/user-data" },
        homeDir: "/home/writer",
        appDataDir: "/home/writer/.config",
      }),
    ).toThrow(/GRIMODEX_USER_DATA_DIR.*absolute/i);
  });

  it("keeps development data isolated under GrimodexElectronDev", () => {
    expect(
      resolveUserDataConfiguration({
        isPackaged: false,
        platform: "linux",
        env: {},
        homeDir: "/home/writer",
        appDataDir: "/home/writer/.config",
      }),
    ).toEqual({
      appName: DEVELOPMENT_APP_NAME,
      userDataDir: "/home/writer/.config/GrimodexElectronDev",
    });
  });

  it("uses XDG_DATA_HOME for the packaged Linux legacy Tauri directory", () => {
    expect(
      resolveUserDataConfiguration({
        isPackaged: true,
        platform: "linux",
        env: { XDG_DATA_HOME: "/mnt/data" },
        homeDir: "/home/writer",
        appDataDir: "/home/writer/.config",
      }),
    ).toEqual({
      appName: PRODUCTION_APP_NAME,
      userDataDir: "/mnt/data/com.miyakey.grimodex",
    });
  });

  it("falls back to ~/.local/share for packaged Linux", () => {
    expect(
      resolveUserDataConfiguration({
        isPackaged: true,
        platform: "linux",
        env: {},
        homeDir: "/home/writer",
        appDataDir: "/home/writer/.config",
      }).userDataDir,
    ).toBe("/home/writer/.local/share/com.miyakey.grimodex");
  });

  it("ignores a relative XDG_DATA_HOME like dirs::data_dir", () => {
    expect(
      resolveUserDataConfiguration({
        isPackaged: true,
        platform: "linux",
        env: { XDG_DATA_HOME: "relative/data" },
        homeDir: "/home/writer",
        appDataDir: "/home/writer/.config",
      }).userDataDir,
    ).toBe("/home/writer/.local/share/com.miyakey.grimodex");
  });

  it("uses the packaged macOS legacy Tauri directory", () => {
    expect(
      resolveUserDataConfiguration({
        isPackaged: true,
        platform: "darwin",
        env: {},
        homeDir: "/Users/writer",
        appDataDir: "/Users/writer/Library/Application Support",
      }).userDataDir,
    ).toBe("/Users/writer/Library/Application Support/com.miyakey.grimodex");
  });

  it("uses APPDATA for the packaged Windows legacy Tauri directory", () => {
    expect(
      resolveUserDataConfiguration({
        isPackaged: true,
        platform: "win32",
        env: { APPDATA: "C:\\Users\\writer\\AppData\\Roaming" },
        homeDir: "C:\\Users\\writer",
        appDataDir: "C:\\Users\\writer\\AppData\\Roaming",
      }).userDataDir,
    ).toBe(
      path.win32.join(
        "C:\\Users\\writer\\AppData\\Roaming",
        "com.miyakey.grimodex",
      ),
    );
  });
});

describe("configureAppUserData", () => {
  it("sets the app name and absolute path and creates it synchronously", () => {
    const calls: string[] = [];
    let configuredPath = "";
    const app = {
      isPackaged: true,
      setDesktopName: vi.fn((name: string) => calls.push(`desktop:${name}`)),
      setName: vi.fn((name: string) => calls.push(`name:${name}`)),
      setPath: vi.fn((name: string, value: string) => {
        configuredPath = value;
        calls.push(`path:${name}:${value}`);
      }),
      getPath: vi.fn((name: string) => {
        if (name === "appData") return "/home/writer/.config";
        if (name === "userData") return configuredPath;
        throw new Error(`unexpected path: ${name}`);
      }),
    };
    const ensureDirectory = vi.fn((directory: string) => {
      calls.push(`mkdir:${directory}`);
    });

    expect(
      configureAppUserData(app, {
        platform: "linux",
        env: { XDG_DATA_HOME: "/mnt/data" },
        homeDir: "/home/writer",
        ensureDirectory,
      }),
    ).toBe("/mnt/data/com.miyakey.grimodex");
    expect(calls).toEqual([
      `desktop:${LINUX_DESKTOP_NAME}`,
      `name:${PRODUCTION_APP_NAME}`,
      "path:userData:/mnt/data/com.miyakey.grimodex",
      "mkdir:/mnt/data/com.miyakey.grimodex",
    ]);
  });
});
