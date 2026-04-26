/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const alias = { "@": path.resolve(__dirname, "./src") };

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    name: "node",
    globals: true,
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["src/**/*.browser.test.{ts,tsx}"],
  },
});
