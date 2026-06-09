import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const analyze = process.env.ANALYZE === "1";

/**
 * 同梱フォント (@fontsource) の CSS から legacy `.woff` フォールバックを除去する。
 * fontsource の @font-face は `url(...woff2) format('woff2'), url(...woff) format('woff')`
 * の両方を参照するため Vite が .woff も asset として emit する。Tauri の webview
 * (WKWebView / WebView2 / WebKitGTK) は全て woff2 対応なので .woff はデッドウェイト。
 * `enforce: 'pre'` で Vite が url() を解決する前に .woff 参照を消し、emit させない。
 */
function stripWoffFromFontsource() {
  return {
    name: "strip-woff-fontsource",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.includes("@fontsource") || !/\.css(\?|$)/.test(id)) return null;
      const stripped = code.replace(
        /,\s*url\([^)]*\.woff\)\s*format\((['"])woff\1\)/g,
        "",
      );
      return stripped === code ? null : { code: stripped, map: null };
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    stripWoffFromFontsource(),
    react(),
    tailwindcss(),
    ...(analyze
      ? [
          visualizer({
            filename: "dist/stats.html",
            template: "treemap",
            gzipSize: true,
            brotliSize: true,
            open: false,
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      "/api/anthropic": {
        target: "https://api.anthropic.com/v1",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api\/anthropic/, ""),
        secure: true,
      },
      "/api/openai": {
        target: "https://api.openai.com/v1",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api\/openai/, ""),
        secure: true,
      },
      "/api/openrouter": {
        target: "https://openrouter.ai/api/v1",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api\/openrouter/, ""),
        secure: true,
      },
      "/api/ollama": {
        target: "http://localhost:11434",
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api\/ollama/, ""),
      },
    },
  },
}));
