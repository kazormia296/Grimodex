/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// `@/locales/{ja,en}.json` は Vite の JSON plugin を通さず fs で読む（試験 1 ファイルごとに
// 約 300 KB の変換済みコードを worker へ送って評価する時間を省く。内容は同じ JSON）。
// 順序が意味を持つので、より具体的な locale の alias を `@` より先に置く。
const alias = [
  {
    find: /^@\/locales\/ja\.json$/u,
    replacement: path.resolve(__dirname, "./src/test-utils/locales-ja.ts"),
  },
  {
    find: /^@\/locales\/en\.json$/u,
    replacement: path.resolve(__dirname, "./src/test-utils/locales-en.ts"),
  },
  { find: "@", replacement: path.resolve(__dirname, "./src") },
];

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
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          // Experimental. The only measured benefit is about -10% CPU time on
          // drizzle-heavy suites; wall time was not distinguishable. Keep this
          // list equal to the drizzle-orm specifiers actually imported: a
          // subpath missing here (e.g. drizzle-orm/sql) is externalized, so the
          // same drizzle can be loaded twice (bundled and Node). Add it here
          // when you start importing a new drizzle-orm subpath.
          include: [
            "drizzle-orm",
            "drizzle-orm/sqlite-proxy",
            "drizzle-orm/sqlite-core",
            "drizzle-orm/errors",
            "drizzle-orm/casing",
          ],
        },
      },
    },
    // The 5 s / 10 s defaults are host-speed assumptions, not contracts; hosted
    // CI runs heavy sql.js/store suites past them. Local runs keep the defaults.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 30_000 : 10_000,
  },
});
