/**
 * CP-4 S1c-1: the Electron entry of the harness (TASK §15.1 D6 (a'),
 * DR-CP4-S1C1-1). `launcher.mjs` bundles this file with esbuild (CJS output,
 * electron and `*.node` external) into `.artifacts/cp4/<run>/observer/
 * observer.cjs` and launches Electron with it. It wires the real Electron
 * objects and the product NC-1 modules into `observer-core.mjs`, then
 * requires the product `dist-electron/main.cjs` named by
 * `GRIMODEX_CP4_PRODUCT_MAIN`. Harness code only: the product Main is not
 * changed.
 */
import console from "node:console";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { app, session } from "electron";
import { createRendererContainment } from "../../../electron/main/rendererContainmentStartup.ts";
import { startBlackholeListener } from "../../../electron/main/rendererContainmentListener.ts";
import { expectedBlackholeProxyString } from "../../../electron/main/rendererContainment.ts";
import { formatObserverFailure, installCp4Observer } from "./observer-core.mjs";

const productMain = process.env.GRIMODEX_CP4_PRODUCT_MAIN;
try {
  if (
    !productMain ||
    !path.isAbsolute(productMain) ||
    // S1j-2: the setup-only Main of the qualified-ir session sits beside the
    // product Main (setup-main-build.mjs; session.mjs launches it only with
    // its sealed admission).
    !(
      path.basename(productMain) === "main.cjs" ||
      // Review P3 (b): the setup-only Main only with the deterministic
      // Journey provider's env (the qualified-ir session).
      (path.basename(productMain) === "main-setup-ir.cjs" &&
        process.env.GRIMODEX_PRODUCT_JOURNEY_FAKE_AI === "deterministic-v1")
    ) ||
    path.basename(path.dirname(productMain)) !== "dist-electron"
  )
    throw new Error(
      "CP4-OBS-INTERNAL: GRIMODEX_CP4_PRODUCT_MAIN must be <root>/dist-electron/main.cjs (or main-setup-ir.cjs)",
    );
  globalThis.__cp4Observer = installCp4Observer({
    app,
    getDefaultSession: () => session.defaultSession,
    nc1: {
      createRendererContainment,
      startBlackholeListener,
      expectedBlackholeProxyString,
    },
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    // The product main path is the harness argument (checked above).
    requireProductMain: () => createRequire(productMain)(productMain),
  });
} catch (error) {
  const code =
    /^(CP4-OBS-[A-Z-]+)/u.exec(String(error?.message))?.[1] ??
    "CP4-OBS-INTERNAL";
  console.error(formatObserverFailure(code));
  app.exit(1);
}
