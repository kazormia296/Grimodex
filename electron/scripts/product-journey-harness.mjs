import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { _electron } from "playwright";

import { closeElectronAppWithDiagnostics } from "./close-electron-app.mjs";

const require = createRequire(import.meta.url);

/** Typed renderer bridge invocation shared by product and performance journeys. */
export async function invokeOk(page, command, args = {}) {
  const envelope = await page.evaluate(
    ([name, input]) => globalThis.grimodex.invoke(name, input),
    [command, args],
  );
  if (!envelope.ok) {
    throw new Error(`${command} rejected: ${envelope.error}`);
  }
  return envelope.value;
}

/** Poll a boundary assertion while keeping the last transport error. */
export async function waitUntil(
  fn,
  label,
  timeoutMs = 30_000,
  intervalMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timeout waiting for ${label}${
          lastError ? `: ${lastError.message ?? lastError}` : ""
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function createProductJourneyHarness({
  mainCjs,
  electronBin = require("electron"),
  launchTimeoutMs = 60_000,
  artifactRoot = process.env.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR ?? null,
  electronLauncher = _electron,
  closeApp = closeElectronAppWithDiagnostics,
} = {}) {
  if (!mainCjs) throw new Error("product journey harness requires mainCjs");

  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "grimodex-product-"));
  const userDataDir = path.join(tmpRoot, "user-data");
  const retainedRendererPath = path.join(tmpRoot, "last-renderer.png");
  const lastResources = {
    app: null,
    page: null,
    phase: null,
  };

  function workspacePath(name) {
    if (!name || name.includes("/") || name.includes("\\")) {
      throw new Error(`invalid product journey workspace name: ${name}`);
    }
    return path.join(tmpRoot, name);
  }

  async function launch(phase) {
    await rm(retainedRendererPath, { force: true });
    const env = { ...process.env };
    delete env.ELECTRON_RENDERER_URL;
    env.GRIMODEX_USER_DATA_DIR = userDataDir;
    const app = await electronLauncher.launch({
      executablePath: electronBin,
      args: [mainCjs],
      env,
      timeout: launchTimeoutMs,
    });
    lastResources.app = app;
    lastResources.page = null;
    lastResources.phase = phase;
    const page = await app.firstWindow({ timeout: launchTimeoutMs });
    lastResources.page = page;

    app.process().stdout?.on("data", (data) => {
      process.stdout.write(`  [product:${phase}:main] ${String(data)}`);
    });
    app.process().stderr?.on("data", (data) => {
      process.stderr.write(`  [product:${phase}:main] ${String(data)}`);
    });
    page.on("console", (message) => {
      if (!["warning", "error"].includes(message.type())) return;
      process.stderr.write(
        `  [product:${phase}:renderer:${message.type()}] ${message.text()}\n`,
      );
    });
    page.on("pageerror", (error) => {
      process.stderr.write(
        `  [product:${phase}:renderer:pageerror] ${error.message}\n`,
      );
    });
    await page.waitForFunction(
      () => globalThis.grimodex?.shell === "electron",
      undefined,
      { timeout: launchTimeoutMs },
    );
    return { app, page };
  }

  async function retainRendererScreenshot(page) {
    if (!artifactRoot || !page || page.isClosed()) return;
    await page
      .screenshot({
        path: retainedRendererPath,
        fullPage: true,
      })
      .catch(() => undefined);
  }

  async function close(app, page, phase) {
    await retainRendererScreenshot(page);
    await closeApp(app, page, phase);
    if (lastResources.app === app) {
      lastResources.app = null;
      lastResources.page = null;
      lastResources.phase = null;
    }
  }

  async function captureFailureArtifact(name) {
    if (!artifactRoot) return;
    const destination = path.join(artifactRoot, name);
    await mkdir(destination, { recursive: true });
    await retainRendererScreenshot(lastResources.page);
    await copyFile(
      retainedRendererPath,
      path.join(destination, "renderer.png"),
    ).catch(() => undefined);
    await cp(tmpRoot, path.join(destination, "runtime"), {
      recursive: true,
      force: true,
    });
  }

  async function dispose({ success, name }) {
    if (!success) {
      await captureFailureArtifact(name).catch((error) => {
        console.error(
          `[electron:product] failed to retain artifacts: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      if (lastResources.app) {
        await closeApp(
          lastResources.app,
          lastResources.page,
          `failure:${name}`,
        ).catch(() => undefined);
        lastResources.app = null;
        lastResources.page = null;
        lastResources.phase = null;
      }
      console.error(`[electron:product] retained temporary root: ${tmpRoot}`);
      return;
    }
    await rm(tmpRoot, { recursive: true, force: true });
  }

  return {
    tmpRoot,
    userDataDir,
    workspacePath,
    launch,
    close,
    invokeOk,
    waitUntil,
    dispose,
  };
}
