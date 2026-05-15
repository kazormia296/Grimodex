import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const lpDir = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(lpDir, ".lp-build");
const entryPath = resolve(buildDir, "lp-entry.jsx");

const variantsSource = await readFile(resolve(lpDir, "lp-variants.jsx"), "utf8");
const cleanSource = await readFile(resolve(lpDir, "lp-clean.jsx"), "utf8");
const variantHSource = await readFile(resolve(lpDir, "lp-variant-h.jsx"), "utf8");

const sharedVariants = variantsSource.slice(
  0,
  variantsSource.indexOf("/* ============================================================\n   Variant A"),
);
const sharedClean = cleanSource.slice(
  0,
  cleanSource.indexOf("/* ============================================================\n   D"),
);

await rm(buildDir, { force: true, recursive: true });
await mkdir(buildDir, { recursive: true });
await writeFile(
  entryPath,
  [
    'import React from "react";',
    'import { createRoot } from "react-dom/client";',
    "",
    sharedVariants,
    sharedClean,
    variantHSource,
    "",
    "function App() {",
    '  return <div className="lp-shell"><LPVariantH /></div>;',
    "}",
    "",
    'createRoot(document.getElementById("root")).render(<App />);',
    "",
  ].join("\n"),
);

await build({
  root: lpDir,
  configFile: false,
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: resolve(lpDir, "assets"),
    emptyOutDir: false,
    minify: true,
    rollupOptions: {
      input: entryPath,
      output: {
        entryFileNames: "lp-app.js",
        chunkFileNames: "lp-[hash].js",
        assetFileNames: "lp-[name][extname]",
      },
    },
  },
});
