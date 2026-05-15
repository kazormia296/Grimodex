/**
 * Generate LP/README screenshots from the dedicated screenshot stage.
 *
 * Usage:
 *   pnpm screenshot
 *   pnpm screenshot:one -- panel-editor-1080x890
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
  DEFAULT_SCREENSHOT_DIR,
  SCREENSHOT_CAPTURES,
  findScreenshotCapture,
  type ScreenshotCapture,
} from "../src/screenshot-scenes/captureManifest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 4174;
const MIN_SCREENSHOT_BYTES = 1_500;
const MAX_SCREENSHOT_BYTES_FLOOR = 10_000;

function minScreenshotBytes(capture: ScreenshotCapture) {
  return Math.max(
    MIN_SCREENSHOT_BYTES,
    Math.min(
      MAX_SCREENSHOT_BYTES_FLOOR,
      Math.floor((capture.width * capture.height * capture.scale) / 20),
    ),
  );
}

function parseCaptures(): readonly ScreenshotCapture[] {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  if (requested.length === 0) return SCREENSHOT_CAPTURES;

  return requested.map((id) => {
    const capture = findScreenshotCapture(id);
    if (!capture) {
      throw new Error(
        `Unknown screenshot capture "${id}". Available: ${SCREENSHOT_CAPTURES.map((item) => item.id).join(", ")}`,
      );
    }
    return capture;
  });
}

async function isServerReady(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(baseUrl, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(
  baseUrl: string,
  server: ChildProcessWithoutNullStreams,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Vite server exited before it became ready`);
    }
    if (await isServerReady(baseUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Vite server at ${baseUrl}`);
}

async function ensureServer(baseUrl: string, port: number) {
  if (await isServerReady(baseUrl)) return undefined;

  const viteBin = join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const server = spawn(
    process.execPath,
    [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: ROOT,
      env: { ...process.env, BROWSER: "none" },
      stdio: "pipe",
    },
  );

  server.stdout.on("data", (chunk) => process.stdout.write(chunk));
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    waitForServer(baseUrl, server).then(resolve, reject);
  });
  return server;
}

async function clickIfVisible(page: Page, selector: string) {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) return false;
  if (!(await locator.isVisible().catch(() => false))) return false;
  await locator.click({ timeout: 2_000 });
  return true;
}

async function clickTextIfVisible(page: Page, text: string) {
  const locator = page.getByText(text, { exact: false }).first();
  if ((await locator.count()) === 0) return false;
  if (!(await locator.isVisible().catch(() => false))) return false;
  await locator.click({ timeout: 2_000 });
  return true;
}

async function performCaptureActions(page: Page, capture: ScreenshotCapture) {
  for (const action of capture.actions ?? []) {
    switch (action) {
      case "select-scene":
        await clickIfVisible(page, '[data-node-id="scene-1"]');
        break;
      case "select-codex":
        await clickTextIfVisible(page, "朱紐");
        break;
      case "select-snippet":
        await clickTextIfVisible(page, "朱紐、再会");
        break;
      case "fit-map":
        await clickIfVisible(page, ".react-flow__controls-fitview");
        break;
    }
  }
}

async function captureOne(baseUrl: string, capture: ScreenshotCapture) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: capture.width, height: capture.height },
      deviceScaleFactor: capture.scale,
    });
    await page.addInitScript(
      ({ captureId, panelId, presetId, theme }) => {
        const workspacePath = "/dev/workspace";
        localStorage.setItem("grimodex:screenshot-mode", "true");
        localStorage.setItem("grimodex:screenshot-capture", captureId);
        if (panelId) {
          localStorage.setItem("grimodex:screenshot-panel", panelId);
          localStorage.removeItem("grimodex:screenshot-preset");
        } else {
          localStorage.removeItem("grimodex:screenshot-panel");
          localStorage.setItem(
            "grimodex:screenshot-preset",
            presetId ?? "builtin:default",
          );
        }
        localStorage.setItem(
          "grimodex:global-settings",
          JSON.stringify({
            recentWorkspaces: [
              { path: workspacePath, lastOpened: new Date().toISOString() },
            ],
            lastActiveWorkspace: workspacePath,
            theme,
            uiLanguage: "ja",
            uiScale: 1,
            showLauncherOnStartup: false,
            acceptedEulaVersion: "1.0",
            trustedWorkspaces: [workspacePath],
            userPreferences: {
              "display.glassEffectEnabled": "false",
              "display.reduceMotion": "true",
            },
          }),
        );
      },
      {
        captureId: capture.id,
        panelId: capture.panelId,
        presetId: capture.presetId,
        theme: capture.theme,
      },
    );
    await page.emulateMedia({ colorScheme: capture.theme });
    await page.goto(baseUrl, {
      waitUntil: "networkidle",
    });
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          caret-color: transparent !important;
          transition: none !important;
        }
        .no-screenshot {
          display: none !important;
        }
      `,
    });
    await page.waitForSelector(".app-shell", {
      state: "attached",
      timeout: 15_000,
    });
    await page.waitForTimeout(1_000);
    await performCaptureActions(page, capture);
    await page.waitForTimeout(300);

    const outputPath = join(ROOT, DEFAULT_SCREENSHOT_DIR, capture.output);
    await mkdir(dirname(outputPath), { recursive: true });

    await page.screenshot({ path: outputPath, fullPage: false });

    const file = await stat(outputPath);
    const minimumBytes = minScreenshotBytes(capture);
    if (file.size < minimumBytes) {
      throw new Error(
        `Screenshot ${capture.output} is unexpectedly small (${file.size} bytes, expected at least ${minimumBytes})`,
      );
    }
    console.log(`captured ${capture.output}`);
  } finally {
    await browser.close();
  }
}

async function main() {
  const captures = parseCaptures();
  const port = Number(process.env.SCREENSHOT_PORT ?? DEFAULT_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcessWithoutNullStreams | undefined;

  try {
    server = await ensureServer(baseUrl, port);
    for (const capture of captures) {
      await captureOne(baseUrl, capture);
    }
  } finally {
    server?.kill();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
