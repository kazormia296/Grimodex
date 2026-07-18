import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

describe("Cloudflare hosted Editor deploy CLI", () => {
  it("builds the root app and deploys root dist to the Editor Pages project", async () => {
    const { createEditorDeployPlan } =
      await import("./cloudflare-editor-deploy.mjs");

    assert.deepEqual(
      createEditorDeployPlan({
        action: "web-deploy",
        environment: "staging",
      }),
      [
        {
          command: "pnpm",
          args: ["build"],
          env: {
            VITE_SCAN_API_BASE_URL:
              "https://grimodex-scan-staging.kazormia296.workers.dev",
          },
        },
        {
          command: "pnpm",
          args: [
            "exec",
            "wrangler",
            "pages",
            "deploy",
            "dist",
            "--project-name",
            "grimodex-try-staging",
            "--branch",
            "master",
          ],
        },
      ],
    );
  });

  it("hard-blocks production Editor build and deploy for every supplied origin", async () => {
    const { createEditorDeployPlan } =
      await import("./cloudflare-editor-deploy.mjs");

    for (const action of ["web-build", "web-deploy"]) {
      for (const apiBaseUrl of [
        undefined,
        "https://grimodex-scan-staging.kazormia296.workers.dev",
        "https://scan-api.grimodex.app",
        "https://third-party.example",
      ]) {
        assert.throws(
          () =>
            createEditorDeployPlan({
              action,
              environment: "production",
              allowProduction: true,
              apiBaseUrl,
            }),
          /blocked until a canonical reviewed production Worker origin/i,
        );
      }
    }
  });

  it("requires the staging Editor to use its exact canonical Worker origin", async () => {
    const { createEditorDeployPlan } =
      await import("./cloudflare-editor-deploy.mjs");

    for (const apiBaseUrl of [
      "https://third-party.example",
      "https://grimodex-scan-staging.kazormia296.workers.dev/path",
      "https://grimodex-scan-staging.kazormia296.workers.dev.evil.example",
    ]) {
      assert.throws(
        () =>
          createEditorDeployPlan({
            action: "web-build",
            environment: "staging",
            apiBaseUrl,
          }),
        /must exactly match the canonical staging Worker origin/i,
      );
    }

    assert.deepEqual(
      createEditorDeployPlan({
        action: "web-build",
        environment: "staging",
        apiBaseUrl: "https://grimodex-scan-staging.kazormia296.workers.dev",
      }),
      [
        {
          command: "pnpm",
          args: ["build"],
          env: {
            VITE_SCAN_API_BASE_URL:
              "https://grimodex-scan-staging.kazormia296.workers.dev",
          },
        },
      ],
    );
  });

  it("ships an independent Editor SPA/PWA shell without caching private routes", async () => {
    const [redirects, manifest, serviceWorker] = await Promise.all([
      readFile(`${publicDir}/_redirects`, "utf8"),
      readFile(`${publicDir}/editor-manifest.webmanifest`, "utf8"),
      readFile(`${publicDir}/editor-sw.js`, "utf8"),
    ]);

    assert.match(redirects, /^\/\*\s+\/index\.html\s+200/m);
    assert.equal(JSON.parse(manifest).start_url, "/editor");
    assert.match(serviceWorker, /request\.mode\s*===\s*["']navigate["']/);
    assert.match(serviceWorker, /authorization/i);
    assert.match(serviceWorker, /\/api\//);
    assert.doesNotMatch(serviceWorker, /cache\.put\([^\n]*editor-seeds/i);
  });
});
