import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { imagetools } from "vite-imagetools";

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
    'import { gsap } from "gsap";',
    'import { ScrollTrigger } from "gsap/ScrollTrigger";',
    "",
    "gsap.registerPlugin(ScrollTrigger);",
    "window.gsap = gsap;",
    "window.ScrollTrigger = ScrollTrigger;",
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
  // Emit relative asset URLs so the bundle works both at the GitHub Pages
  // subpath (`/Grimodex/lp/`) and when served locally from `docs/lp/`.
  // Vite's default `/` root-absolute URLs would 404 in either case because
  // index.html lives at `lp/`, not at the server root.
  base: "./",
  configFile: false,
  publicDir: false,
  plugins: [react(), imagetools()],
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
