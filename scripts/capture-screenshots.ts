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
 *
 * テーマ切り替え（dark/light + カラーテーマ。manifest の `theme`/`colorTheme` より優先度は低い）:
 *   pnpm screenshot -- --theme light
 *   pnpm screenshot -- --color-theme modern-mystic
 *   pnpm screenshot -- --theme light --color-theme warm-craft
 *   SCREENSHOT_THEME=light SCREENSHOT_COLOR_THEME=modern-mystic pnpm screenshot
 * デフォルト（dark + dark-academia）以外を指定したカットには
 * `panel-editor-light.png`・`panel-editor-modern-mystic.png` のように接尾辞が付きます。
 *
 * 言語切り替え（ja/en。UI・シードデータ・校閲デモが連動。既定は ja）:
 *   pnpm screenshot -- --lang en
 *   pnpm screenshot -- -l en
 *   SCREENSHOT_LANGUAGE=en pnpm screenshot
 * 既定（ja）以外の言語のカットには `panel-editor-en.png`・
 * `panel-editor-light-en.png` のように言語接尾辞が末尾に付きます。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
  DEFAULT_SCREENSHOT_COLOR_THEME,
  DEFAULT_SCREENSHOT_DIR,
  DEFAULT_SCREENSHOT_THEME,
  SCREENSHOT_CAPTURES,
  SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT,
  SCREENSHOT_CAPTURE_UI_SCALE_MIN_PCT,
  SCREENSHOT_COLOR_THEME_IDS,
  findScreenshotCapture,
  screenshotOutputFilename,
  type ScreenshotCapture,
  type ScreenshotTheme,
} from "../src/screenshot-scenes/captureManifest";
import {
  DEFAULT_SCREENSHOT_LANGUAGE,
  SCREENSHOT_LANGUAGES,
  SCREENSHOT_LANGUAGE_LOCALSTORAGE_KEY,
  type ScreenshotLanguage,
} from "../src/screenshot-scenes/screenshotMode";
import { SCREENSHOT_SEED_CONTENT } from "../src/screenshot-scenes/screenshotSeedContent";
import { EULA_VERSION } from "../src/features/legal/constants";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 4174;
/** 機材負荷と誤入力を抑える上限（1 = 従来どおり） */
const MAX_SCREENSHOT_RENDER_SCALE = 8;
const MIN_SCREENSHOT_BYTES = 1_500;
const MAX_SCREENSHOT_BYTES_FLOOR = 10_000;
/** アプリ側と同じ許容範囲（staging クランプ上限） */
const SCREENSHOT_UI_SCALE_ENV_KEY = "SCREENSHOT_UI_SCALE";
const SCREENSHOT_THEME_ENV_KEY = "SCREENSHOT_THEME";
const SCREENSHOT_COLOR_THEME_ENV_KEY = "SCREENSHOT_COLOR_THEME";
const SCREENSHOT_LANGUAGE_ENV_KEY = "SCREENSHOT_LANGUAGE";
/** 平坦なダークUIは PNG 圧縮率が高く、画素数が小さいほど変動が大きい */
const SCREENSHOT_MIN_BYTES_SLACK = 0.88;

function parseThemeValue(value: string, source: string): ScreenshotTheme {
  const v = value.trim().toLowerCase();
  if (v === "dark" || v === "light") return v;
  throw new Error(`${source} must be "dark" or "light", got "${value}"`);
}

function envTheme(): ScreenshotTheme | undefined {
  const raw = process.env[SCREENSHOT_THEME_ENV_KEY];
  if (raw === undefined || raw === "") return undefined;
  return parseThemeValue(raw, SCREENSHOT_THEME_ENV_KEY);
}

function parseColorThemeValue(value: string, source: string): string {
  const v = value.trim();
  if (!SCREENSHOT_COLOR_THEME_IDS.includes(v)) {
    throw new Error(
      `${source} must be one of ${SCREENSHOT_COLOR_THEME_IDS.join(", ")}; got "${value}"`,
    );
  }
  return v;
}

function envColorTheme(): string | undefined {
  const raw = process.env[SCREENSHOT_COLOR_THEME_ENV_KEY];
  if (raw === undefined || raw === "") return undefined;
  return parseColorThemeValue(raw, SCREENSHOT_COLOR_THEME_ENV_KEY);
}

function parseLanguageValue(value: string, source: string): ScreenshotLanguage {
  const v = value.trim().toLowerCase();
  if ((SCREENSHOT_LANGUAGES as readonly string[]).includes(v)) {
    return v as ScreenshotLanguage;
  }
  throw new Error(
    `${source} must be one of ${SCREENSHOT_LANGUAGES.join(", ")}; got "${value}"`,
  );
}

function envLanguage(): ScreenshotLanguage | undefined {
  const raw = process.env[SCREENSHOT_LANGUAGE_ENV_KEY];
  if (raw === undefined || raw === "") return undefined;
  return parseLanguageValue(raw, SCREENSHOT_LANGUAGE_ENV_KEY);
}

function parsePositiveRenderScale(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > MAX_SCREENSHOT_RENDER_SCALE) {
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

function minScreenshotBytes(capture: ScreenshotCapture, renderScale: number) {
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
  theme?: ScreenshotTheme;
  colorTheme?: string;
  language?: ScreenshotLanguage;
} {
  const raw = process.argv.slice(2);
  let renderScale = envRenderScale();
  let uiScalePercent = envUiScalePercent();
  let theme = envTheme();
  let colorTheme = envColorTheme();
  let language = envLanguage();
  const requested: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    // POSIX 慣習。`pnpm screenshot -- --theme light` のように pnpm が
    // 素通しした区切り `--` を無視する（以降は positional 扱いでもよいが、
    // ここでは引き続きフラグも許可している）。
    if (arg === "--") continue;
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
    if (arg === "--theme") {
      const next = raw[++i];
      if (next === undefined) {
        throw new Error(`${arg} requires "dark" or "light"`);
      }
      theme = parseThemeValue(next, arg);
      continue;
    }
    const themeEq = /^--theme=(.+)$/.exec(arg);
    if (themeEq) {
      theme = parseThemeValue(themeEq[1], "--theme");
      continue;
    }
    if (arg === "--color-theme") {
      const next = raw[++i];
      if (next === undefined) {
        throw new Error(
          `${arg} requires one of: ${SCREENSHOT_COLOR_THEME_IDS.join(", ")}`,
        );
      }
      colorTheme = parseColorThemeValue(next, arg);
      continue;
    }
    const colorThemeEq = /^--color-theme=(.+)$/.exec(arg);
    if (colorThemeEq) {
      colorTheme = parseColorThemeValue(colorThemeEq[1], "--color-theme");
      continue;
    }
    if (arg === "--lang" || arg === "-l") {
      const next = raw[++i];
      if (next === undefined) {
        throw new Error(
          `${arg} requires one of: ${SCREENSHOT_LANGUAGES.join(", ")}`,
        );
      }
      language = parseLanguageValue(next, arg);
      continue;
    }
    const langEq = /^--lang=(.+)$/.exec(arg);
    if (langEq) {
      language = parseLanguageValue(langEq[1], "--lang");
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(
        `Unknown option "${arg}". Use --scale N (or -s N) for Hi-DPI capture, --ui-scale PCT for UI zoom, --theme dark|light, --color-theme ID, --lang ja|en (or -l).`,
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

  return { captures, renderScale, uiScalePercent, theme, colorTheme, language };
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

async function performCaptureActions(
  page: Page,
  capture: ScreenshotCapture,
  language: ScreenshotLanguage,
) {
  // codex / snippet はリスト項目をテキストで選ぶため、シードと同じ言語別の
  // 名称を使う（select-scene / fit-map は data 属性・CSS で言語非依存）。
  const content = SCREENSHOT_SEED_CONTENT[language];
  for (const action of capture.actions ?? []) {
    switch (action) {
      case "select-scene":
        await clickIfVisible(page, '[data-node-id="scene-1"]');
        break;
      case "select-codex":
        await clickTextIfVisible(page, content.codex.akahimo.name);
        break;
      case "select-snippet":
        await clickTextIfVisible(page, content.snippets.reunion.title);
        break;
      case "fit-map":
        await clickIfVisible(page, ".react-flow__controls-fitview");
        break;
      case "search-command-center": {
        const query = Array.from(content.codex.akane.name.trim())[0];
        if (!query) break;
        const input = page
          .locator(
            '[data-slot-panel="command-center-results"] input[type="text"]',
          )
          .first();
        await input.fill(query);
        await page
          .getByText(content.codex.akane.name, { exact: false })
          .first()
          .waitFor({ state: "visible", timeout: 5_000 });
        break;
      }
    }
  }
}

async function waitForCaptureContent(
  page: Page,
  capture: ScreenshotCapture,
  language: ScreenshotLanguage,
) {
  const panelId = capture.panelId;
  if (!panelId) return;

  const panelSelector =
    panelId === "editor"
      ? "[data-editor-area]"
      : `[data-slot-panel="${panelId}"]`;
  await page.waitForSelector(panelSelector, {
    state: "visible",
    timeout: 10_000,
  });

  if (panelId === "chronicle") {
    await page
      .getByText(SCREENSHOT_SEED_CONTENT[language].chronicle.returnHome.title, {
        exact: false,
      })
      .first()
      .waitFor({ state: "visible", timeout: 5_000 });
  } else if (panelId === "writing-stats") {
    await page
      .locator('[data-testid="writing-stats-heatmap"]')
      .waitFor({ state: "visible", timeout: 5_000 });
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
  defaultTheme?: ScreenshotTheme,
  defaultColorTheme?: string,
  language: ScreenshotLanguage = DEFAULT_SCREENSHOT_LANGUAGE,
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

  const resolvedTheme: ScreenshotTheme =
    capture.theme ?? defaultTheme ?? DEFAULT_SCREENSHOT_THEME;
  const resolvedColorTheme: string =
    capture.colorTheme ?? defaultColorTheme ?? DEFAULT_SCREENSHOT_COLOR_THEME;
  const outputName = screenshotOutputFilename(capture.id, {
    theme: resolvedTheme,
    colorTheme: resolvedColorTheme,
    language,
  });

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
      ({
        captureId,
        panelId,
        presetId,
        theme,
        colorTheme,
        uiScale,
        language,
        languageKey,
        eulaVersion,
      }) => {
        const workspacePath = "/dev/workspace";
        localStorage.setItem("grimodex:screenshot-mode", "true");
        localStorage.setItem("grimodex:screenshot-capture", captureId);
        // browser-mock のシードと screenshotBootstrap のデモ状態が参照する
        // 言語フラグ（global-settings.uiLanguage とは別系統で先に確定させる）。
        localStorage.setItem(languageKey, language);
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
        const userPreferences: Record<string, string> = {
          "display.glassEffectEnabled": "false",
          "display.reduceMotion": "true",
        };
        // 詳細ペイン (SceneMetaPanel) は default / review のプリセット撮影
        // ではレイアウトを締めて見せるため閉じておく。
        if (presetId === "builtin:default" || presetId === "builtin:review") {
          userPreferences["editor.sceneMetaPanelOpen"] = "false";
        }
        localStorage.setItem(
          "grimodex:global-settings",
          JSON.stringify({
            recentWorkspaces: [
              { path: workspacePath, lastOpened: new Date().toISOString() },
            ],
            lastActiveWorkspace: workspacePath,
            theme,
            colorTheme,
            uiLanguage: language,
            uiScale,
            showLauncherOnStartup: false,
            acceptedEulaVersion: eulaVersion,
            trustedWorkspaces: [workspacePath],
            userPreferences,
          }),
        );
      },
      {
        captureId: capture.id,
        panelId: capture.panelId,
        presetId: capture.presetId,
        theme: resolvedTheme,
        colorTheme: resolvedColorTheme,
        uiScale: uiScalePct,
        language,
        languageKey: SCREENSHOT_LANGUAGE_LOCALSTORAGE_KEY,
        eulaVersion: EULA_VERSION,
      },
    );
    await page.emulateMedia({ colorScheme: resolvedTheme });
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
        [data-sonner-toaster] {
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
    await waitForCaptureContent(page, capture, language);
    await page.waitForTimeout(1_200);
    await performCaptureActions(page, capture, language);
    await page.waitForTimeout(300);

    const outputPath = join(ROOT, DEFAULT_SCREENSHOT_DIR, outputName);
    await mkdir(dirname(outputPath), { recursive: true });

    await page.screenshot({ path: outputPath, fullPage: false });

    const file = await stat(outputPath);
    const minimumBytes = effectiveMinScreenshotBytes(capture, renderScale);
    if (file.size < minimumBytes) {
      throw new Error(
        `Screenshot ${outputName} is unexpectedly small (${file.size} bytes, expected at least ${minimumBytes})`,
      );
    }
    const scaleNote = renderScale !== 1 ? ` (scale=${renderScale})` : "";
    const uiNote = uiScalePct !== 100 ? ` (ui-scale=${uiScalePct}%)` : "";
    const themeNote =
      resolvedTheme !== DEFAULT_SCREENSHOT_THEME
        ? ` (theme=${resolvedTheme})`
        : "";
    const colorThemeNote =
      resolvedColorTheme !== DEFAULT_SCREENSHOT_COLOR_THEME
        ? ` (color-theme=${resolvedColorTheme})`
        : "";
    const languageNote =
      language !== DEFAULT_SCREENSHOT_LANGUAGE ? ` (lang=${language})` : "";
    console.log(
      `captured ${outputName}${scaleNote}${uiNote}${themeNote}${colorThemeNote}${languageNote}`,
    );
  } finally {
    await browser.close();
  }
}

async function main() {
  const { captures, renderScale, uiScalePercent, theme, colorTheme, language } =
    parseCli();
  const resolvedLanguage = language ?? DEFAULT_SCREENSHOT_LANGUAGE;
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
    if (theme != null) {
      console.log(`Default screenshot theme ${theme}`);
    }
    if (colorTheme != null) {
      console.log(`Default screenshot color theme ${colorTheme}`);
    }
    if (resolvedLanguage !== DEFAULT_SCREENSHOT_LANGUAGE) {
      console.log(`Screenshot language ${resolvedLanguage}`);
    }
    for (const capture of captures) {
      await captureOne(
        baseUrl,
        capture,
        renderScale,
        uiScalePercent,
        theme,
        colorTheme,
        resolvedLanguage,
      );
    }
  } finally {
    server?.kill();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
