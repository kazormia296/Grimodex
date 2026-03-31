import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
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
