/**
 * Generate LP/README screenshots from the dedicated screenshot stage.
 *
 * Usage:
 *   pnpm screenshot
 *   pnpm screenshot:one -- panel-editor-1080x890
 *
 * Hi-DPI 撮影（`--scale N` で devicePixelRatio を N 倍。未指定の UI スケールは **N×100%** に揃える）:
 *   pnpm screenshot -- --scale 2
 *   SCREENSHOT_RENDER_SCALE=2 pnpm screenshot
 *
 * UI スケール（%・整数）を明示する（manifest の `uiScale` より優先度は低い）:
 *   pnpm screenshot -- --ui-scale 200
 *   SCREENSHOT_UI_SCALE=200 pnpm screenshot
 * captureManifest の各エントリで `uiScale` を指定すると、そのカットだけ上書きされます。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
  DEFAULT_SCREENSHOT_DIR,
  SCREENSHOT_CAPTURES,
  SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT,
  SCREENSHOT_CAPTURE_UI_SCALE_MIN_PCT,
  findScreenshotCapture,
  type ScreenshotCapture,
} from "../src/screenshot-scenes/captureManifest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 4174;
/** 機材負荷と誤入力を抑える上限（1 = 従来どおり） */
const MAX_SCREENSHOT_RENDER_SCALE = 8;
const MIN_SCREENSHOT_BYTES = 1_500;
const MAX_SCREENSHOT_BYTES_FLOOR = 10_000;
/** アプリ側と同じ許容範囲（staging クランプ上限） */
const SCREENSHOT_UI_SCALE_ENV_KEY = "SCREENSHOT_UI_SCALE";
/** 平坦なダークUIは PNG 圧縮率が高く、画素数が小さいほど変動が大きい */
const SCREENSHOT_MIN_BYTES_SLACK = 0.88;

function parsePositiveRenderScale(value: string): number {
  const n = Number(value);
  if (
    !Number.isFinite(n) ||
    n < 1 ||
    n > MAX_SCREENSHOT_RENDER_SCALE
  ) {
    throw new Error(
      `Screenshot render scale must be between 1 and ${MAX_SCREENSHOT_RENDER_SCALE}, got "${value}"`,
    );
  }
  return n;
}

function envRenderScale(): number {
  const raw = process.env.SCREENSHOT_RENDER_SCALE;
  if (raw === undefined || raw === "") return 1;
  return parsePositiveRenderScale(raw);
}

function parseUiScalePercent(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(
      `UI scale (${SCREENSHOT_UI_SCALE_ENV_KEY} / --ui-scale) must be an integer percent, got "${value}"`,
    );
  }
  if (
    n < SCREENSHOT_CAPTURE_UI_SCALE_MIN_PCT ||
    n > SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT
  ) {
    throw new Error(
      `UI scale must be ${SCREENSHOT_CAPTURE_UI_SCALE_MIN_PCT}–${SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT}, got ${n}`,
    );
  }
  return n;
}

function envUiScalePercent(): number | undefined {
  const raw = process.env[SCREENSHOT_UI_SCALE_ENV_KEY];
  if (raw === undefined || raw === "") return undefined;
  return parseUiScalePercent(raw.trim());
}

function minScreenshotBytes(
  capture: ScreenshotCapture,
  renderScale: number,
) {
  const pixelFactor = renderScale * renderScale;
  return Math.max(
    MIN_SCREENSHOT_BYTES,
    Math.min(
      MAX_SCREENSHOT_BYTES_FLOOR,
      Math.floor(
        (capture.width * capture.height * capture.scale * pixelFactor) / 20,
      ),
    ),
  );
}

/** 厳密下限ではなく slack をかけたしきい値（白飛び検知は維持しつつフレークを抑える） */
function effectiveMinScreenshotBytes(
  capture: ScreenshotCapture,
  renderScale: number,
) {
  const raw = minScreenshotBytes(capture, renderScale);
  return Math.max(
    MIN_SCREENSHOT_BYTES,
    Math.floor(raw * SCREENSHOT_MIN_BYTES_SLACK),
  );
}

function parseCli(): {
  captures: readonly ScreenshotCapture[];
  renderScale: number;
  uiScalePercent?: number;
} {
  const raw = process.argv.slice(2);
  let renderScale = envRenderScale();
  let uiScalePercent = envUiScalePercent();
  const requested: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg === "--scale" || arg === "-s") {
      const next = raw[++i];
      if (next === undefined) {
        throw new Error(`${arg} requires a number (e.g. ${arg} 2)`);
      }
      renderScale = parsePositiveRenderScale(next);
      continue;
    }
    const scaleEq = /^--scale=(.+)$/.exec(arg);
    if (scaleEq) {
      renderScale = parsePositiveRenderScale(scaleEq[1]);
      continue;
    }
    if (arg === "--ui-scale") {
      const next = raw[++i];
      if (next === undefined) {
        throw new Error(`${arg} requires integer percent (e.g. ${arg} 200)`);
      }
      uiScalePercent = parseUiScalePercent(next);
      continue;
    }
    const uiEq = /^--ui-scale=(.+)$/.exec(arg);
    if (uiEq) {
      uiScalePercent = parseUiScalePercent(uiEq[1]);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(
        `Unknown option "${arg}". Use --scale N (or -s N) for Hi-DPI capture, --ui-scale PCT for UI zoom.`,
      );
    }
    requested.push(arg);
  }

  const captures =
    requested.length === 0
      ? SCREENSHOT_CAPTURES
      : requested.map((id) => {
          const capture = findScreenshotCapture(id);
          if (!capture) {
            throw new Error(
              `Unknown screenshot capture "${id}". Available: ${SCREENSHOT_CAPTURES.map((item) => item.id).join(", ")}`,
            );
          }
          return capture;
        });

  return { captures, renderScale, uiScalePercent };
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

function resolveScreenshotUiScalePercent(
  capture: ScreenshotCapture,
  renderScale: number,
  cliOrEnvUiScale?: number,
): number {
  if (capture.uiScale != null) return capture.uiScale;
  if (cliOrEnvUiScale != null) return cliOrEnvUiScale;
  if (renderScale !== 1) {
    const requested = Math.round(100 * renderScale);
    if (requested > SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT) {
      console.warn(
        `UI scale capped at ${SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT}% (from --scale ${renderScale}, would be ${requested}%)`,
      );
    }
    return Math.min(
      SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT,
      Math.max(SCREENSHOT_CAPTURE_UI_SCALE_MIN_PCT, requested),
    );
  }
  return 100;
}

async function captureOne(
  baseUrl: string,
  capture: ScreenshotCapture,
  renderScale: number,
  defaultUiScalePercent?: number,
) {
  if (capture.uiScale != null) {
    if (
      !Number.isInteger(capture.uiScale) ||
      capture.uiScale < SCREENSHOT_CAPTURE_UI_SCALE_MIN_PCT ||
      capture.uiScale > SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT
    ) {
      throw new Error(
        `Invalid uiScale ${capture.uiScale} for capture "${capture.id}" (must be integer ${SCREENSHOT_CAPTURE_UI_SCALE_MIN_PCT}–${SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT})`,
      );
    }
  }

  const browser = await chromium.launch();
  try {
    const effectiveDpr = capture.scale * renderScale;
    const page = await browser.newPage({
      viewport: { width: capture.width, height: capture.height },
      deviceScaleFactor: effectiveDpr,
    });
    const uiScalePct = resolveScreenshotUiScalePercent(
      capture,
      renderScale,
      defaultUiScalePercent,
    );

    await page.addInitScript(
      ({ captureId, panelId, presetId, theme, uiScale }) => {
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
            uiScale,
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
        uiScale: uiScalePct,
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
    await page
      .waitForSelector("body[data-screenshot-ready='true']", {
        state: "attached",
        timeout: 20_000,
      })
      .catch(() => {
        /* fallback: stale builds without marker */
      });
    await page.waitForTimeout(1_200);
    await performCaptureActions(page, capture);
    await page.waitForTimeout(300);

    const outputPath = join(ROOT, DEFAULT_SCREENSHOT_DIR, capture.output);
    await mkdir(dirname(outputPath), { recursive: true });

    await page.screenshot({ path: outputPath, fullPage: false });

    const file = await stat(outputPath);
    const minimumBytes = effectiveMinScreenshotBytes(capture, renderScale);
    if (file.size < minimumBytes) {
      throw new Error(
        `Screenshot ${capture.output} is unexpectedly small (${file.size} bytes, expected at least ${minimumBytes})`,
      );
    }
    const scaleNote = renderScale !== 1 ? ` (scale=${renderScale})` : "";
    const uiNote = uiScalePct !== 100 ? ` (ui-scale=${uiScalePct}%)` : "";
    console.log(`captured ${capture.output}${scaleNote}${uiNote}`);
  } finally {
    await browser.close();
  }
}

async function main() {
  const { captures, renderScale, uiScalePercent } = parseCli();
  const port = Number(process.env.SCREENSHOT_PORT ?? DEFAULT_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcessWithoutNullStreams | undefined;

  try {
    server = await ensureServer(baseUrl, port);
    if (renderScale !== 1) {
      console.log(
        `Screenshot render scale ${renderScale}x (devicePixelRatio ×${renderScale}; UI scale matches unless --ui-scale / capture.uiScale overrides)`,
      );
    }
    if (uiScalePercent != null && uiScalePercent !== 100) {
      console.log(`Default screenshot UI scale ${uiScalePercent}%`);
    }
    for (const capture of captures) {
      await captureOne(baseUrl, capture, renderScale, uiScalePercent);
    }
  } finally {
    server?.kill();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
