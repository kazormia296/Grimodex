import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import nodeProcess from "node:process";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerProcess } from "./process.js";
import { JsonRpcConnection } from "./jsonRpcConnection.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-codex-process-"));
  temporaryRoots.push(root);
  return root;
}

function spawnedChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function trustedFileOptions() {
  return {
    resolveExecutable: async () => "/opt/codex",
    realPath: async (candidate: string) => candidate,
    isFile: async () => true,
    hashFile: async () => "sha256",
  };
}

describe("CodexAppServerProcess", () => {
  it("uses the main-owned configured path and still authorizes its canonical executable", async () => {
    const resolveExecutable = vi.fn(async () => "/auto/codex");
    const authorizeExecutable = vi.fn(async () => false);
    const spawn = vi.fn();
    const process = new CodexAppServerProcess({
      getConfiguredExecutable: async () => "/configured/codex",
      resolveExecutable,
      realPath: async () => "/canonical/codex-runtime",
      isFile: async () => true,
      hashFile: async () => "configured-sha256",
      authorizeExecutable,
      spawn: spawn as never,
    });

    await expect(process.start()).rejects.toThrow(
      "Codex CLI executable was not authorized",
    );
    expect(resolveExecutable).not.toHaveBeenCalled();
    expect(authorizeExecutable).toHaveBeenCalledWith({
      executable: "/canonical/codex-runtime",
      sha256: "configured-sha256",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("resolves a persisted bare codex name through the main PATH detector", async () => {
    const resolveExecutable = vi.fn(async () => "/detected/codex");
    const authorizeExecutable = vi.fn(async () => false);
    const process = new CodexAppServerProcess({
      getConfiguredExecutable: async () => " codex ",
      resolveExecutable,
      realPath: async (candidate) => candidate,
      isFile: async () => true,
      hashFile: async () => "sha256",
      authorizeExecutable,
      spawn: vi.fn() as never,
    });

    await expect(process.start()).rejects.toThrow(
      "Codex CLI executable was not authorized",
    );
    expect(resolveExecutable).toHaveBeenCalledOnce();
    expect(authorizeExecutable).toHaveBeenCalledWith({
      executable: "/detected/codex",
      sha256: "sha256",
    });
  });

  it("fails closed when no executable authorization callback is installed", async () => {
    const spawn = vi.fn();
    const process = new CodexAppServerProcess({
      ...trustedFileOptions(),
      spawn: spawn as never,
    });

    await expect(process.start()).rejects.toThrow(
      "Codex CLI executable was not authorized",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails closed when the main process does not supply an isolated Codex home", async () => {
    const spawn = vi.fn();
    const process = new CodexAppServerProcess({
      ...trustedFileOptions(),
      authorizeExecutable: async () => true,
      spawn: spawn as never,
    });

    await expect(process.start()).rejects.toThrow(
      "Grimodex Codex home was not configured",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn after disposal wins executable resolution", async () => {
    let resolveExecutable!: (value: string) => void;
    const spawn = vi.fn();
    const process = new CodexAppServerProcess({
      ...trustedFileOptions(),
      resolveExecutable: () =>
        new Promise((resolve) => {
          resolveExecutable = resolve;
        }),
      authorizeExecutable: async () => true,
      spawn: spawn as never,
    });

    const starting = process.start();
    await vi.waitFor(() => expect(resolveExecutable).toBeTypeOf("function"));
    await process.dispose();
    resolveExecutable("/opt/codex");

    await expect(starting).rejects.toThrow(
      "Codex app-server process is disposed",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns from the Grimodex-owned home and overrides inherited CODEX_HOME", async () => {
    const root = await temporaryRoot();
    const sourceCodexHome = path.join(root, "user-codex");
    const isolatedCodexHome = path.join(root, "grimodex-codex");
    await mkdir(sourceCodexHome, { recursive: true });
    await writeFile(
      path.join(sourceCodexHome, "auth.json"),
      '{"OPENAI_API_KEY":"from-auth"}',
    );
    await writeFile(
      path.join(sourceCodexHome, "config.toml"),
      '[mcp_servers.hostile]\ncommand = "/tmp/hostile"\n',
    );
    const child = spawnedChild();
    const spawn = vi.fn((..._args: unknown[]) => child);
    const process = new CodexAppServerProcess({
      ...trustedFileOptions(),
      codexHomeDir: isolatedCodexHome,
      sourceCodexHomeDir: sourceCodexHome,
      authorizeExecutable: async () => true,
      spawn: spawn as never,
    });

    await process.start();

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "app-server",
      "--strict-config",
      "--listen",
      "stdio://",
    ]);
    const spawnOptions = spawn.mock.calls[0]?.[2] as
      | {
          cwd?: string;
          env?: NodeJS.ProcessEnv;
        }
      | undefined;
    expect(spawnOptions?.cwd).toBe(isolatedCodexHome);
    expect(spawnOptions?.env?.CODEX_HOME).toBe(isolatedCodexHome);
    expect(spawnOptions?.env?.CODEX_HOME).not.toBe(sourceCodexHome);
    const disposing = process.dispose();
    child.emit("close", null, "SIGTERM");
    await disposing;
  });

  it("rejects an executable replaced after the authorization dialog", async () => {
    const root = await temporaryRoot();
    const sourceCodexHome = path.join(root, "user-codex");
    const isolatedCodexHome = path.join(root, "grimodex-codex");
    await mkdir(sourceCodexHome, { recursive: true });
    const hashFile = vi
      .fn<(_: string) => Promise<string | null>>()
      .mockResolvedValueOnce("authorized-sha256")
      .mockResolvedValueOnce("replacement-sha256");
    const spawn = vi.fn();
    const process = new CodexAppServerProcess({
      ...trustedFileOptions(),
      hashFile,
      codexHomeDir: isolatedCodexHome,
      sourceCodexHomeDir: sourceCodexHome,
      authorizeExecutable: async () => true,
      spawn: spawn as never,
    });

    await expect(process.start()).rejects.toThrow(
      "Codex CLI executable changed after authorization",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("waits for child close after SIGKILL instead of resolving immediately", async () => {
    const child = spawnedChild();
    const process = new CodexAppServerProcess({
      ...trustedFileOptions(),
      codexHomeDir: "/tmp/grimodex-codex",
      authorizeExecutable: async () => true,
      forceKillAfterMs: 20,
      spawn: vi.fn(() => child) as never,
    });
    await process.start();

    let settled = false;
    const disposing = process.dispose().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);

    child.emit("close", null, "SIGKILL");
    await disposing;
    expect(settled).toBe(true);
  });

  it("does not treat a closed direct child as a stopped process tree", async () => {
    const child = spawnedChild();
    let descendantAlive = true;
    const isProcessTreeAlive = vi.fn(() => descendantAlive);
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal === "SIGKILL") descendantAlive = false;
      return true;
    });
    const server = new CodexAppServerProcess({
      ...trustedFileOptions(),
      codexHomeDir: "/tmp/grimodex-codex",
      authorizeExecutable: async () => true,
      forceKillAfterMs: 20,
      isProcessTreeAlive,
      spawn: vi.fn(() => child) as never,
    });
    await server.start();

    const disposing = server.dispose();
    child.emit("close", null, "SIGTERM");
    await vi.waitFor(() =>
      expect(child.kill).toHaveBeenCalledWith("SIGKILL"),
    );
    await vi.waitFor(() => expect(isProcessTreeAlive).toHaveBeenCalled());
    await disposing;
  });

  it("does not treat an error event as close and rejects when close is unconfirmed", async () => {
    const child = spawnedChild();
    const process = new CodexAppServerProcess({
      ...trustedFileOptions(),
      codexHomeDir: "/tmp/grimodex-codex",
      authorizeExecutable: async () => true,
      forceKillAfterMs: 20,
      spawn: vi.fn(() => child) as never,
    });
    await process.start();
    child.emit("error", new Error("child failed"));

    await expect(process.dispose()).rejects.toThrow(
      /Codex app-server child did not close/,
    );
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects immediately when child termination itself fails", async () => {
    const child = spawnedChild();
    child.kill = vi.fn(() => {
      throw new Error("kill failed");
    });
    const process = new CodexAppServerProcess({
      ...trustedFileOptions(),
      codexHomeDir: "/tmp/grimodex-codex",
      authorizeExecutable: async () => true,
      forceKillAfterMs: 20,
      spawn: vi.fn(() => child) as never,
    });
    await process.start();

    await expect(process.dispose()).rejects.toThrow("kill failed");
  });

  it("observes a wire-close rejection while preserving the manager rejection", async () => {
    const child = spawnedChild();
    child.kill = vi.fn(() => {
      throw new Error("kill failed");
    });
    const server = new CodexAppServerProcess({
      ...trustedFileOptions(),
      codexHomeDir: "/tmp/grimodex-codex",
      authorizeExecutable: async () => true,
      forceKillAfterMs: 20,
      spawn: vi.fn(() => child) as never,
    });
    await server.start();
    const connection = new JsonRpcConnection(server);
    const unhandled = vi.fn();
    nodeProcess.on("unhandledRejection", unhandled);

    try {
      const managerTeardown = server.dispose();
      connection.dispose();
      await expect(managerTeardown).rejects.toThrow("kill failed");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      nodeProcess.off("unhandledRejection", unhandled);
    }
  });
});
