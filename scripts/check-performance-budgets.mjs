import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIST_ROOT = path.resolve("dist");
const DIST_DIR = path.resolve("dist/assets");
/**
 * The startup graph budget is a bounded ratchet, not a byte-by-byte race.
 *
 * Baseline is the accepted A1 candidate's static SceneScopeEditor Electron
 * build, measured with the locked toolchain. Small shared-chunk churn is
 * covered by the allowance; intentional growth must update the baseline in a
 * reviewed change and can never cross the absolute product ceiling.
 */
export const INITIAL_JS_GRAPH_BUDGET = {
  baseline: { rawBytes: 3_803_500, gzipBytes: 1_195_200 },
  allowance: { rawBytes: 98_304, gzipBytes: 36_864 },
  // raw は 4_250_000 から 700 byte だけ上げた。チャット入力の書きかけを session／project の
  // 削除と一緒に消す処理（chatInputDraftPurge.ts）が初期 graph の store に入るため
  // （実測 raw 4,249,993 → 4,250,669 で +676、gzip 1,342,871 → 1,343,227 で +356）。
  // raw は 4_250_700 から 300 byte だけ上げた。RS-JOIN（DR-RSJ-2）で、同じ Related Scenes
  // operation の IR の continue と Graph の待受けを並行に通す pair の規則が初期 graph の
  // ipcQueue.ts と tauri.ts に入るため（実測 raw 4,250,669 → 4,250,910 で +241、
  // gzip は上限の内側）。
  // raw は baseline と上限の両方を 10,300 byte 上げた。画面端のオーバーレイ（P1）の
  // 保存データ・store action・つまみが初期 graph の layout に入るため（実測 raw
  // 4,248,578 → 4,261,293 で +12,715、gzip は上限の内側）。層（OverlayLayer）を lazy に
  // すると共有 module が細かい chunk に割れて全部 preload され、raw 4,286,482 に増えたので
  // 採らなかった。
  // raw は 4_261_300 から 200 byte だけ上げた。Scenes の名前変更の入力欄がフォーカスを
  // 失う不具合の修正（右クリックメニューを閉じたときのフォーカスの戻し先と、開いている
  // エディタを見せるだけのときのフォーカス移動）が初期 graph の tree と layout に入るため
  // （実測 raw 4,261,293 → 4,261,421 で +128、gzip は上限の内側）。
  // raw は 4_261_500 から 200 byte だけ上げた。日本語の画面に英語のまま残っていた 14 件の
  // 訳を ja.json（初期 graph）に入れたため。日本語は UTF-8 で 1 文字 3 byte になる（実測
  // raw 4,261,421 → 4,261,613 で +192、gzip は上限の内側）。
  // raw は baseline と上限の両方を 16,900 byte、gzip は baseline を 4,700 byte・上限を
  // 4,500 byte 上げた。レイアウトの動き（リージョンの引き出し、slot・band の開閉、
  // パネル切替、stripe のアイコンの FLIP、外形のモーフの記録、パネルの先読み）が
  // 初期 graph の layout に入るため（同じ toolchain で master と比べた実測 raw
  // 4,261,696 → 4,278,090 で +16,394、gzip 1,348,183 → 1,353,791 で +5,608）。
  // 先に lazy にできる分は外した: motion の命令的な animate() をやめて宣言的な
  // motion.div と WAAPI にし（-7.5 KB）、外形のモーフの本体とドラッグのゴーストを
  // 動的 import にした。残りは毎 commit の矩形の記録と比較で、初期 graph に要る。
  // raw は baseline を 3,767 byte・上限を 3,800 byte、gzip は baseline を 741 byte・
  // 上限を 700 byte 上げた。エディタの動き（タブの下線・ドロップ線・並べ替えの FLIP、
  // 本文の skeleton の遅れとフェード、分割の開閉の clip、折りたたみの高さ）が初期
  // graph の editor／tree／layout に入るため（CI の実測で master #849 の
  // raw 4,278,161 → 4,281,883 で +3,722、gzip 1,353,852 → 1,355,042 で +1,190）。
  // 設定ダイアログ（カテゴリの背景・本文の寄せ）は lazy chunk なので含まない。
  // どれも描く時点で要る小さな hook と部品で、後から読む形にできる大きな本体は無い。
  // ここまでが、上限を少しずつ上げてきた記録（旧 baseline raw 4,250,900／gzip 1,338,800、
  // 旧上限 raw 4,282,400／gzip 1,355,200）。
  //
  // 起動時に要らないものを初期 graph から外し、baseline と上限を下げた（同じ toolchain の
  // 実測で raw 4,281,883 → 3,803,402 で -478,481、gzip 1,354,989 → 1,195,161 で -159,828）。
  // 外したもの: 英語の辞書（英語の画面でだけ読む）、利用規約の同意ダイアログと Markdown の
  // 描画（同意が要るときだけ読む）、gsap（パネルの強調と節目の演出で初めて読む）、撮影用の
  // 校閲デモの文面。これらが初期 graph に戻らないことは FORBIDDEN_INITIAL_JS で検査する。
  // 上限は旧上限より raw 379,400／gzip 123,200 低い。allowance は raw 32,768 → 98,304、
  // gzip 16,384 → 36,864 に広げた。機能を足すたびに数百 byte ずつ上限を上げる運用を
  // やめるためで、広げても実効の上限（baseline＋allowance）は旧上限よりずっと低い。
  absoluteMax: { rawBytes: 3_903_000, gzipBytes: 1_232_000 },
};
const INITIAL_CSS_MAX_BYTES = 240_000;
const INITIAL_CSS_MAX_GZIP_BYTES = 42_000;
const INITIAL_FONT_MAX_BYTES = 4_250_000;
const TOTAL_FONT_MAX_BYTES = 18_500_000;
const DEFAULT_FONT_CSS_PATTERNS = [
  /^notoSerifJp-[^/]+\.css$/,
  /^mPlus1-[^/]+\.css$/,
];

function assetNameFromUrl(value) {
  const pathname = value.split(/[?#]/, 1)[0];
  const prefix = "/assets/";
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length);
}

/**
 * Return the files the browser requests from the generated HTML before any
 * application-level dynamic import. Vite emits synchronous shared chunks as
 * modulepreload links, so checking only index-*.js substantially undercounts
 * the startup graph.
 */
export function collectHtmlEntrypointAssets(html) {
  const js = new Set();
  const css = new Set();
  for (const match of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const tagName = match[1].toLowerCase();
    const attributes = new Map();
    for (const attribute of match[2].matchAll(
      /([\w:-]+)\s*=\s*(["'])(.*?)\2/g,
    )) {
      attributes.set(attribute[1].toLowerCase(), attribute[3]);
    }
    if (
      tagName === "script" &&
      attributes.get("type") === "module" &&
      attributes.has("src")
    ) {
      const name = assetNameFromUrl(attributes.get("src"));
      if (name?.endsWith(".js")) js.add(name);
    }
    if (tagName !== "link" || !attributes.has("href")) continue;
    const name = assetNameFromUrl(attributes.get("href"));
    if (!name) continue;
    const rel = attributes.get("rel")?.toLowerCase();
    if (rel === "modulepreload" && name.endsWith(".js")) js.add(name);
    if (rel === "stylesheet" && name.endsWith(".css")) css.add(name);
  }
  return { js: Array.from(js), css: Array.from(css) };
}

export function collectFontAssetNames(cssTexts, availableFontFiles) {
  const available = new Set(availableFontFiles);
  return new Set(
    cssTexts
      .flatMap((cssText) =>
        Array.from(
          cssText.matchAll(/url\((?:["']?)([^)"']+\.woff2)/g),
          (match) => path.basename(match[1]),
        ),
      )
      .filter((name) => available.has(name)),
  );
}

function findExactlyOne(pattern, files) {
  const matches = files.filter((file) => pattern.test(file));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one asset matching ${pattern}, found ${matches.length}`,
    );
  }
  return matches[0];
}

function measureAsset(name) {
  const content = readFileSync(path.join(DIST_DIR, name));
  return {
    rawBytes: content.byteLength,
    gzipBytes: gzipSync(content, { level: 9 }).byteLength,
  };
}

export function resolveRatchetedBudget({ baseline, allowance, absoluteMax }) {
  if (
    baseline.rawBytes > absoluteMax.rawBytes ||
    baseline.gzipBytes > absoluteMax.gzipBytes
  ) {
    throw new Error("Performance budget baseline exceeds its absolute ceiling");
  }
  return {
    rawBytes: Math.min(
      baseline.rawBytes + allowance.rawBytes,
      absoluteMax.rawBytes,
    ),
    gzipBytes: Math.min(
      baseline.gzipBytes + allowance.gzipBytes,
      absoluteMax.gzipBytes,
    ),
  };
}

function checkAsset(name, maxBytes, maxGzipBytes) {
  const measured = measureAsset(name);
  if (measured.rawBytes > maxBytes || measured.gzipBytes > maxGzipBytes) {
    throw new Error(
      `${name} exceeds budget: raw=${measured.rawBytes} (max ${maxBytes}), gzip=${measured.gzipBytes} (max ${maxGzipBytes})`,
    );
  }
  console.log(
    `[perf-budget] ${name}: raw=${measured.rawBytes}, gzip=${measured.gzipBytes}`,
  );
  return measured;
}

function checkAssetSet(label, names, maxBytes, maxGzipBytes) {
  const measured = names.reduce(
    (total, name) => {
      const asset = measureAsset(name);
      total.rawBytes += asset.rawBytes;
      total.gzipBytes += asset.gzipBytes;
      return total;
    },
    { rawBytes: 0, gzipBytes: 0 },
  );
  if (measured.rawBytes > maxBytes || measured.gzipBytes > maxGzipBytes) {
    throw new Error(
      `${label} exceeds budget: raw=${measured.rawBytes} (max ${maxBytes}), gzip=${measured.gzipBytes} (max ${maxGzipBytes}), assets=${names.length}`,
    );
  }
  console.log(
    `[perf-budget] ${label}: raw=${measured.rawBytes}, gzip=${measured.gzipBytes}, assets=${names.length}`,
  );
  return measured;
}

/**
 * 起動時には要らないので後から読むことにした chunk。初期 graph（HTML が直接読む
 * script と modulepreload）に戻っていたら、合計が上限の内側でも失敗にする。
 */
export const FORBIDDEN_INITIAL_JS = [
  [/^en-[^/]+\.js$/, "英語の辞書（src/locales/en.json）"],
  [/^gsap-[^/]+\.js$/, "gsap（src/lib/gsap.ts を含む）"],
  [/^EulaConsentDialog-[^/]+\.js$/, "利用規約の同意ダイアログ"],
  [/^MarkdownDoc-[^/]+\.js$/, "Markdown の描画（react-markdown）"],
  [/^screenshotSeedContent-[^/]+\.js$/, "撮影用の校閲デモの文面"],
];

export function findForbiddenInitialJs(names) {
  return names.flatMap((name) =>
    FORBIDDEN_INITIAL_JS.filter(([pattern]) => pattern.test(name)).map(
      ([, description]) => `${name}: ${description}`,
    ),
  );
}

/**
 * 名前の検査だけでは、module が別の名前の chunk に併合されて戻った場合を見逃す。
 * そこで、その module にしか無い文字列が初期 graph の chunk の中に無いことも確かめる。
 * 目印が古くなって検査が空振りしないよう、dist のどこかには在ることも確かめる。
 */
export const FORBIDDEN_INITIAL_JS_MARKERS = [
  ["GSAP target", "gsap"],
  ["legal.eula.agreeCheckbox", "利用規約の同意ダイアログ"],
  ["akane:foreign-memory:scene-1", "撮影用の校閲デモの文面"],
];

export function checkForbiddenInitialMarkers(initialSources, allSources) {
  const problems = [];
  for (const [marker, description] of FORBIDDEN_INITIAL_JS_MARKERS) {
    const inInitial = initialSources
      .filter(({ source }) => source.includes(marker))
      .map(({ name }) => name);
    if (inInitial.length > 0) {
      problems.push(
        `${description} が初期 graph に入っている（目印 "${marker}"）: ${inInitial.join(", ")}`,
      );
    } else if (!allSources.some(({ source }) => source.includes(marker))) {
      problems.push(
        `${description} の目印 "${marker}" が dist のどの chunk にも無い（目印を更新する）`,
      );
    }
  }
  return problems;
}

const lazyBudgets = [
  [/^SettingsDialog-[^/]+\.js$/, 240_000, 60_000],
  [/^MapPanel-[^/]+\.js$/, 340_000, 100_000],
  [/^GalaxyCanvas-[^/]+\.js$/, 1_500_000, 420_000],
  [/^ChatPanel-[^/]+\.js$/, 240_000, 70_000],
  [/^ChroniclePanel-[^/]+\.js$/, 540_000, 175_000],
  [/^GridPanel-[^/]+\.js$/, 180_000, 55_000],
  [/^TimelinePanel-[^/]+\.js$/, 140_000, 45_000],
];

export function main() {
  const files = readdirSync(DIST_DIR);
  const html = readFileSync(path.join(DIST_ROOT, "index.html"), "utf8");
  const htmlAssets = collectHtmlEntrypointAssets(html);
  const initialJsBudget = resolveRatchetedBudget(INITIAL_JS_GRAPH_BUDGET);
  checkAssetSet(
    "initial JS graph",
    htmlAssets.js,
    initialJsBudget.rawBytes,
    initialJsBudget.gzipBytes,
  );
  const forbidden = findForbiddenInitialJs(htmlAssets.js);
  const readJs = (name) => ({
    name,
    source: readFileSync(path.join(DIST_DIR, name), "utf8"),
  });
  forbidden.push(
    ...checkForbiddenInitialMarkers(
      htmlAssets.js.map(readJs),
      files.filter((file) => file.endsWith(".js")).map(readJs),
    ),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `initial JS graph contains chunks that must stay lazy:\n${forbidden.join("\n")}`,
    );
  }
  console.log(
    `[perf-budget] initial JS graph ratchet: baseline(raw=${INITIAL_JS_GRAPH_BUDGET.baseline.rawBytes}, gzip=${INITIAL_JS_GRAPH_BUDGET.baseline.gzipBytes}), allowance(raw=${INITIAL_JS_GRAPH_BUDGET.allowance.rawBytes}, gzip=${INITIAL_JS_GRAPH_BUDGET.allowance.gzipBytes}), absolute(raw=${INITIAL_JS_GRAPH_BUDGET.absoluteMax.rawBytes}, gzip=${INITIAL_JS_GRAPH_BUDGET.absoluteMax.gzipBytes})`,
  );
  const defaultFontCss = DEFAULT_FONT_CSS_PATTERNS.map((pattern) =>
    findExactlyOne(pattern, files),
  );
  const startupCss = Array.from(
    new Set([...htmlAssets.css, ...defaultFontCss]),
  );
  checkAssetSet(
    "startup CSS graph",
    startupCss,
    INITIAL_CSS_MAX_BYTES,
    INITIAL_CSS_MAX_GZIP_BYTES,
  );

  for (const [pattern, rawBudget, gzipBudget] of lazyBudgets) {
    const asset = findExactlyOne(pattern, files);
    checkAsset(asset, rawBudget, gzipBudget);
    console.log(`[perf-budget] lazy boundary within budget: ${asset}`);
  }

  const fontFiles = files.filter((file) => file.endsWith(".woff2"));
  const totalFontBytes = fontFiles.reduce(
    (total, file) => total + statSync(path.join(DIST_DIR, file)).size,
    0,
  );
  if (totalFontBytes > TOTAL_FONT_MAX_BYTES) {
    throw new Error(
      `font assets exceed distribution budget: total=${totalFontBytes} (max ${TOTAL_FONT_MAX_BYTES})`,
    );
  }

  const startupFontNames = collectFontAssetNames(
    startupCss.map((name) => readFileSync(path.join(DIST_DIR, name), "utf8")),
    fontFiles,
  );
  const startupFontBytes = Array.from(startupFontNames).reduce(
    (total, file) => total + statSync(path.join(DIST_DIR, file)).size,
    0,
  );
  if (startupFontBytes > INITIAL_FONT_MAX_BYTES) {
    throw new Error(
      `startup font assets exceed budget: total=${startupFontBytes} (max ${INITIAL_FONT_MAX_BYTES})`,
    );
  }
  console.log(
    `[perf-budget] fonts: startup=${startupFontBytes} (${startupFontNames.size} files), distribution=${totalFontBytes} (${fontFiles.length} files)`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
