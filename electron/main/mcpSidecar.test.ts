import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

import {
  buildMcpConfigShellHandlers,
  prepareMcpSidecarForStartup,
  resolveMcpSidecarPath,
  scheduleMcpSidecarWarmup,
} from "./mcpSidecar.js";
import { IPC_BACKEND_UNAVAILABLE_MARKER } from "../shared/ipcContract.js";
import type { NapiBackendLike } from "../shared/ipcContract.js";

const originalOverride = process.env.GRIMODEX_MCP_PATH;
const tempRoots: string[] = [];

afterEach(() => {
  if (originalOverride === undefined) {
    delete process.env.GRIMODEX_MCP_PATH;
  } else {
    process.env.GRIMODEX_MCP_PATH = originalOverride;
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveMcpSidecarPath", () => {
  it("uses an absolute executable GRIMODEX_MCP_PATH before built-in candidates", async () => {
    const overridePath = "/opt/grimodex/bin/custom-mcp";
    const probeCandidate = vi.fn(async (candidate: string) =>
      candidate === overridePath ? { mtimeMs: 100 } : null,
    );

    await expect(
      resolveMcpSidecarPath({
        overridePath,
        isPackaged: true,
        resourcesPath: "/opt/Grimodex/resources",
        mainDir: "/opt/Grimodex/resources/app.asar/dist-electron",
        platform: "linux",
        probeCandidate,
      }),
    ).resolves.toBe(overridePath);
    expect(probeCandidate).toHaveBeenCalledExactlyOnceWith(
      overridePath,
      "linux",
    );
  });

  it("rejects a relative override without falling back to a valid dev binary", async () => {
    const probeCandidate = vi.fn(async () => ({ mtimeMs: 100 }));

    await expect(
      resolveMcpSidecarPath({
        overridePath: "target/debug/grimodex-mcp",
        isPackaged: false,
        resourcesPath: "/repo/Grimodex/resources",
        mainDir: "/repo/Grimodex/dist-electron",
        platform: "linux",
        probeCandidate,
      }),
    ).rejects.toThrow(/GRIMODEX_MCP_PATH.*absolute/i);
    expect(probeCandidate).not.toHaveBeenCalled();
  });

  it.each(["missing", "directory", "non-executable file"])(
    "rejects a %s override instead of silently using another binary",
    async () => {
      const overridePath = "/opt/grimodex/bin/not-a-regular-file";
      const probeCandidate = vi.fn(async () => null);

      await expect(
        resolveMcpSidecarPath({
          overridePath,
          isPackaged: false,
          resourcesPath: "/repo/Grimodex/resources",
          mainDir: "/repo/Grimodex/dist-electron",
          platform: "linux",
          probeCandidate,
        }),
      ).rejects.toThrow(/GRIMODEX_MCP_PATH.*executable regular file/i);
      expect(probeCandidate).toHaveBeenCalledExactlyOnceWith(
        overridePath,
        "linux",
      );
    },
  );

  it("uses debug when it is the newest valid development binary", async () => {
    const debug = "/repo/Grimodex/src-tauri/target/debug/grimodex-mcp";
    const release = "/repo/Grimodex/src-tauri/target/release/grimodex-mcp";
    const probeCandidate = vi.fn(async (candidate: string) =>
      candidate === debug
        ? { mtimeMs: 200 }
        : candidate === release
          ? { mtimeMs: 100 }
          : null,
    );

    await expect(
      resolveMcpSidecarPath({
        isPackaged: false,
        resourcesPath: "/repo/Grimodex/resources",
        mainDir: "/repo/Grimodex/dist-electron",
        platform: "linux",
        probeCandidate,
      }),
    ).resolves.toBe(debug);
    expect(probeCandidate.mock.calls.map(([candidate]) => candidate)).toEqual([
      debug,
      release,
    ]);
  });

  it("falls back to the release target in development", async () => {
    const debug = "/repo/Grimodex/src-tauri/target/debug/grimodex-mcp";
    const release = "/repo/Grimodex/src-tauri/target/release/grimodex-mcp";
    const probeCandidate = vi.fn(async (candidate: string) =>
      candidate === release ? { mtimeMs: 100 } : null,
    );

    await expect(
      resolveMcpSidecarPath({
        isPackaged: false,
        resourcesPath: "/repo/Grimodex/resources",
        mainDir: "/repo/Grimodex/dist-electron",
        platform: "linux",
        probeCandidate,
      }),
    ).resolves.toBe(release);
    expect(probeCandidate.mock.calls.map(([candidate]) => candidate)).toEqual([
      debug,
      release,
    ]);
  });

  it("materializes a packaged Linux sidecar into stable userData storage", async () => {
    const packaged = "/opt/Grimodex/resources/bin/grimodex-mcp";
    const stable =
      "/home/writer/.local/share/com.miyakey.grimodex/bin/grimodex-mcp";
    const probeCandidate = vi.fn(async (candidate: string) =>
      candidate === packaged ? { mtimeMs: 100 } : null,
    );
    const materializeSidecar = vi.fn(async () => stable);

    await expect(
      resolveMcpSidecarPath({
        isPackaged: true,
        resourcesPath: "/opt/Grimodex/resources",
        mainDir: "/opt/Grimodex/resources/app.asar/dist-electron",
        platform: "linux",
        userDataDir: "/home/writer/.local/share/com.miyakey.grimodex",
        probeCandidate,
        materializeSidecar,
      }),
    ).resolves.toBe(stable);
    expect(probeCandidate).toHaveBeenCalledExactlyOnceWith(packaged, "linux");
    expect(materializeSidecar).toHaveBeenCalledExactlyOnceWith(
      packaged,
      "/home/writer/.local/share/com.miyakey.grimodex",
    );
  });

  it("keeps packaged non-Linux sidecars at their resource path", async () => {
    const packaged =
      "/Applications/Grimodex.app/Contents/Resources/bin/grimodex-mcp";
    const probeCandidate = vi.fn(async (candidate: string) =>
      candidate === packaged ? { mtimeMs: 100 } : null,
    );
    const materializeSidecar = vi.fn(async () => "/should/not/be/used");

    await expect(
      resolveMcpSidecarPath({
        isPackaged: true,
        resourcesPath: "/Applications/Grimodex.app/Contents/Resources",
        mainDir:
          "/Applications/Grimodex.app/Contents/Resources/app.asar/dist-electron",
        platform: "darwin",
        userDataDir:
          "/Users/writer/Library/Application Support/com.miyakey.grimodex",
        probeCandidate,
        materializeSidecar,
      }),
    ).resolves.toBe(packaged);
    expect(materializeSidecar).not.toHaveBeenCalled();
  });

  it("uses the .exe suffix for Windows candidates", async () => {
    const packaged = path.win32.join(
      "C:\\Program Files\\Grimodex\\resources",
      "bin",
      "grimodex-mcp.exe",
    );
    const probeCandidate = vi.fn(async (candidate: string) =>
      candidate === packaged ? { mtimeMs: 100 } : null,
    );

    await expect(
      resolveMcpSidecarPath({
        isPackaged: true,
        resourcesPath: "C:\\Program Files\\Grimodex\\resources",
        mainDir:
          "C:\\Program Files\\Grimodex\\resources\\app.asar\\dist-electron",
        platform: "win32",
        probeCandidate,
      }),
    ).resolves.toBe(packaged);
  });

  it("rejects when the selected packaged or dev candidate does not exist", async () => {
    const probeCandidate = vi.fn(async () => null);

    await expect(
      resolveMcpSidecarPath({
        isPackaged: true,
        resourcesPath: "/opt/Grimodex/resources",
        mainDir: "/opt/Grimodex/resources/app.asar/dist-electron",
        platform: "linux",
        probeCandidate,
      }),
    ).rejects.toThrow(/MCP sidecar.*not found/i);

    await expect(
      resolveMcpSidecarPath({
        isPackaged: false,
        resourcesPath: "/repo/Grimodex/resources",
        mainDir: "/repo/Grimodex/dist-electron",
        platform: "linux",
        probeCandidate,
      }),
    ).rejects.toThrow(/MCP sidecar.*not found/i);
  });

  it("reads GRIMODEX_MCP_PATH at call time and accepts an executable fixture", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "grimodex-mcp-sidecar-"));
    tempRoots.push(root);
    const executable = path.join(root, "grimodex-mcp");
    writeFileSync(executable, "fixture");
    chmodSync(executable, 0o755);
    process.env.GRIMODEX_MCP_PATH = executable;

    await expect(resolveMcpSidecarPath()).resolves.toBe(executable);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a real Unix regular file without execute permission",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "grimodex-mcp-sidecar-"));
      tempRoots.push(root);
      const nonExecutable = path.join(root, "grimodex-mcp");
      writeFileSync(nonExecutable, "fixture");
      chmodSync(nonExecutable, 0o644);
      process.env.GRIMODEX_MCP_PATH = nonExecutable;

      await expect(resolveMcpSidecarPath()).rejects.toThrow(
        /GRIMODEX_MCP_PATH.*executable regular file/i,
      );
    },
  );

  it("chooses a newer release fixture instead of a stale debug binary", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "grimodex-mcp-sidecar-"));
    tempRoots.push(root);
    const mainDir = path.join(root, "dist-electron");
    const executableName =
      process.platform === "win32" ? "grimodex-mcp.exe" : "grimodex-mcp";
    const debug = path.join(
      root,
      "src-tauri",
      "target",
      "debug",
      executableName,
    );
    const release = path.join(
      root,
      "src-tauri",
      "target",
      "release",
      executableName,
    );
    mkdirSync(mainDir, { recursive: true });
    mkdirSync(path.dirname(debug), { recursive: true });
    mkdirSync(path.dirname(release), { recursive: true });
    writeFileSync(debug, "stale debug");
    writeFileSync(release, "fresh release");
    chmodSync(debug, 0o755);
    chmodSync(release, 0o755);
    const now = Date.now() / 1_000;
    utimesSync(debug, now - 60, now - 60);
    utimesSync(release, now, now);

    await expect(
      resolveMcpSidecarPath({
        isPackaged: false,
        resourcesPath: path.join(root, "resources"),
        mainDir,
        platform: process.platform,
      }),
    ).resolves.toBe(release);
  });
});

describe("prepareMcpSidecarForStartup", () => {
  it("defers packaged sidecar resolution until MCP is requested and reuses it", async () => {
    const resolveSidecar = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("/home/writer/.local/share/grimodex/bin/grimodex-mcp");

    const prepared = prepareMcpSidecarForStartup(true, resolveSidecar);

    expect(resolveSidecar).not.toHaveBeenCalled();
    await expect(prepared()).resolves.toBe(
      "/home/writer/.local/share/grimodex/bin/grimodex-mcp",
    );
    await expect(prepared()).resolves.toBe(
      "/home/writer/.local/share/grimodex/bin/grimodex-mcp",
    );
    expect(resolveSidecar).toHaveBeenCalledOnce();
  });

  it("keeps development resolution lazy", async () => {
    const resolveSidecar = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("/repo/src-tauri/target/debug/grimodex-mcp");

    const prepared = prepareMcpSidecarForStartup(false, resolveSidecar);

    expect(resolveSidecar).not.toHaveBeenCalled();
    await expect(prepared()).resolves.toContain("target/debug/grimodex-mcp");
    expect(resolveSidecar).toHaveBeenCalledOnce();
  });

  it("allows a later MCP request to retry after background preparation fails", async () => {
    const resolveSidecar = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("sidecar unavailable"))
      .mockResolvedValueOnce("/tmp/grimodex-mcp");
    const prepared = prepareMcpSidecarForStartup(true, resolveSidecar);

    await expect(prepared()).rejects.toThrow("sidecar unavailable");
    await expect(prepared()).resolves.toBe("/tmp/grimodex-mcp");
    expect(resolveSidecar).toHaveBeenCalledTimes(2);
  });
});

describe("scheduleMcpSidecarWarmup", () => {
  it("uses did-finish-load as a fallback and starts only once", async () => {
    let onReadyToShow: (() => void) | undefined;
    let onDidFinishLoad: (() => void) | undefined;
    const resolveSidecar = vi.fn(async () => "/tmp/grimodex-mcp");
    const onError = vi.fn();

    scheduleMcpSidecarWarmup(
      {
        once: (event, listener) => {
          expect(event).toBe("ready-to-show");
          onReadyToShow = listener;
        },
        webContents: {
          once: (event, listener) => {
            expect(event).toBe("did-finish-load");
            onDidFinishLoad = listener;
          },
        },
      },
      resolveSidecar,
      onError,
    );

    onDidFinishLoad?.();
    await vi.waitFor(() => expect(resolveSidecar).toHaveBeenCalledOnce());
    onReadyToShow?.();
    await Promise.resolve();

    expect(resolveSidecar).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("buildMcpConfigShellHandlers", () => {
  it("combines the native workspace with a standalone sidecar contract", async () => {
    const backend = {
      getActiveWorkspacePath: vi.fn(async () => "/workspace/novel"),
    } as unknown as NapiBackendLike;
    const resolveSidecar = vi.fn(async () => "/opt/grimodex-mcp");
    const licenseFile = "/electron-user-data/license.json";

    await expect(
      buildMcpConfigShellHandlers(
        backend,
        licenseFile,
        resolveSidecar,
      ).get_mcp_config({}),
    ).resolves.toEqual({
      command: "/opt/grimodex-mcp",
      workspace: "/workspace/novel",
      argsPrefix: ["--license-file", licenseFile],
    });
    expect(resolveSidecar).toHaveBeenCalledTimes(1);
    expect(backend.getActiveWorkspacePath).toHaveBeenCalledTimes(1);
  });

  it("fails explicitly when the native backend is unavailable or stale", async () => {
    const resolveSidecar = vi.fn(async () => "/opt/grimodex-mcp");
    await expect(
      buildMcpConfigShellHandlers(
        null,
        "/electron-user-data/license.json",
        resolveSidecar,
      ).get_mcp_config({}),
    ).rejects.toThrow(`${IPC_BACKEND_UNAVAILABLE_MARKER} get_mcp_config`);
    await expect(
      buildMcpConfigShellHandlers(
        {} as NapiBackendLike,
        "/electron-user-data/license.json",
        resolveSidecar,
      ).get_mcp_config({}),
    ).rejects.toThrow(/native method getActiveWorkspacePath/);
    expect(resolveSidecar).not.toHaveBeenCalled();
  });

  it("rejects a non-absolute workspace returned by native", async () => {
    const backend = {
      getActiveWorkspacePath: vi.fn(async () => "relative/workspace"),
    } as unknown as NapiBackendLike;
    await expect(
      buildMcpConfigShellHandlers(
        backend,
        "/electron-user-data/license.json",
        async () => "/opt/grimodex-mcp",
      ).get_mcp_config({}),
    ).rejects.toThrow(/workspace path.*absolute/i);
  });

  it("rejects a relative main-process license path before resolving the sidecar", async () => {
    const backend = {
      getActiveWorkspacePath: vi.fn(async () => "/workspace/novel"),
    } as unknown as NapiBackendLike;
    const resolveSidecar = vi.fn(async () => "/opt/grimodex-mcp");

    await expect(
      buildMcpConfigShellHandlers(
        backend,
        "relative/license.json",
        resolveSidecar,
      ).get_mcp_config({}),
    ).rejects.toThrow(/license file path.*absolute/i);
    expect(resolveSidecar).not.toHaveBeenCalled();
    expect(backend.getActiveWorkspacePath).not.toHaveBeenCalled();
  });
});
