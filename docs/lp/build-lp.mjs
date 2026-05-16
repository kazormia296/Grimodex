import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { imagetools } from "vite-imagetools";

const lpDir = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(lpDir, ".lp-build");
const entryPath = resolve(buildDir, "lp-entry.jsx");
const assetsDir = resolve(lpDir, "assets");

// Clear previous build artifacts before each build. We keep `emptyOutDir:
// false` because the assets/ directory also holds hand-placed files (e.g.
// grimodex-logo.svg) that the build does not regenerate. Removing only the
// `lp-` prefixed entries here lets us pair `[hash:8]` filenames below with
// a clean slate, preventing old hashes from piling up across rebuilds.
for (const entry of await readdir(assetsDir)) {
  if (entry.startsWith("lp-")) {
    await rm(resolve(assetsDir, entry), { force: true, recursive: true });
  }
}

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
        // vite-imagetools expands a single source PNG into multiple
        // sizes/formats that all share the same Rollup `[name]`. With
        // `lp-[name][extname]` Rollup resolved those clashes with
        // arbitrary `2/3` suffixes whose order changed per build,
        // producing huge git diffs even when JSX was untouched. Adding
        // the content hash makes filenames content-addressable, so the
        // same source always emits the same name on every machine.
        assetFileNames: "lp-[name]-[hash:8][extname]",
      },
    },
  },
});
