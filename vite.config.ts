import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";
import path from "path";

// @ts-expect-error process is a nodejs global
const analyze = process.env.ANALYZE === "1";

/**
 * 同梱フォント (@fontsource) の CSS から legacy `.woff` フォールバックを除去する。
 * fontsource の @font-face は `url(...woff2) format('woff2'), url(...woff) format('woff')`
 * の両方を参照するため Vite が .woff も asset として emit する。Electron の
 * Chromium は woff2 対応なので .woff はデッドウェイト。
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
export default defineConfig(async ({ mode }) => {
  const webEditorOnly = mode === "web-editor";
  const webEditorUnavailableDialogs = path.resolve(
    __dirname,
    "./src/features/hosted-editor/WebEditorUnavailableDialogs.tsx",
  );

  return {
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
      alias: [
        ...(webEditorOnly
          ? [
              {
                find: "@/features/settings/SettingsDialog",
                replacement: path.resolve(
                  __dirname,
                  "./src/features/hosted-editor/WebEditorSettingsDialog.tsx",
                ),
              },
              {
                find: "@/features/transfer/TransferDialog",
                replacement: webEditorUnavailableDialogs,
              },
              {
                find: "@/features/export/ExportDialog",
                replacement: webEditorUnavailableDialogs,
              },
              {
                find: "@/features/import/WebEditorWorkspaceImportDialog",
                replacement: webEditorUnavailableDialogs,
              },
            ]
          : []),
        { find: "@", replacement: path.resolve(__dirname, "./src") },
      ],
    },

    // Keep build errors visible and use the same renderer port as electron:dev.
    clearScreen: false,
    server: {
      port: 1430,
      strictPort: true,
      watch: {
        // Native Rust changes are rebuilt by the N-API workflow, not Vite HMR.
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
        "/api/ollama": {
          target: "http://localhost:11434",
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/api\/ollama/, ""),
        },
      },
    },
  };
});
