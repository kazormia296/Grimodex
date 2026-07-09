/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import os from "os";
import { playwright } from "@vitest/browser-playwright";

const alias = { "@": path.resolve(__dirname, "./src") };

// webkit は WKWebView / WebKitGTK と同系の WebCore エンジン。macOS 実機なしで
// エンジン層のレイアウト回帰を検出するための近似ゲートとして chromium と併走させる。
//
// Playwright の Linux 向け WebKit は Ubuntu ビルドのため、Arch 等の非 apt ホスト
// では libicu74 / libxml2.so.2 / libflite1 が不足して起動できない。
// scripts/setup-webkit-host-libs.sh で展開した互換ライブラリを WebKit 起動時のみ
// LD_LIBRARY_PATH に載せる。未展開なら webkit instance を警告付きでスキップする
// (CI は Ubuntu なので常に webkit が走り、ゲートとしては維持される)。
const webkitHostLibs = path.join(
  process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
  "grimodex",
  "webkit-host-libs",
);
const needsHostLibs =
  process.platform === "linux" && !fs.existsSync("/etc/debian_version");
const hasHostLibs = fs.existsSync(
  path.join(webkitHostLibs, "libicudata.so.74"),
);

function webkitInstance() {
  if (!needsHostLibs) return [{ browser: "webkit" as const }];
  if (!hasHostLibs) {
    console.warn(
      `[vitest.browser] webkit をスキップ: ${webkitHostLibs} が未展開。` +
        "bash scripts/setup-webkit-host-libs.sh を一度実行すると有効になる。",
    );
    return [];
  }
  // Ubuntu 向けバイナリの依存検証は非 apt ホストでは必ず失敗するので抑止する
  process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS ??= "1";
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  env.LD_LIBRARY_PATH = [webkitHostLibs, process.env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(":");
  return [
    {
      browser: "webkit" as const,
      provider: playwright({ launchOptions: { env } }),
    },
  ];
}

export default defineConfig({
  // Tailwind 4 は utilities を Vite plugin 経由で生成する。これが無いと
  // browser test で `grid` `h-full` 等のクラスが no-op になり、layout が
  // 全く効かない (shell が display:block に潰れる)。
  plugins: [react(), tailwindcss()],
  resolve: { alias },
  optimizeDeps: {
    include: ["@tanstack/react-virtual"],
  },
  test: {
    name: "browser",
    globals: true,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }, ...webkitInstance()],
    },
    setupFiles: ["./src/test-setup-browser.ts"],
    include: ["src/**/*.browser.test.{ts,tsx}"],
  },
});
