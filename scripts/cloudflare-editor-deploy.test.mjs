import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

describe("Cloudflare Web Editor-only deploy CLI", () => {
  it("builds staging without any Scan Worker or hosted AI environment", async () => {
    const { createEditorDeployPlan } =
      await import("./cloudflare-editor-deploy.mjs");

    assert.deepEqual(
      createEditorDeployPlan({ action: "web-build", environment: "staging" }),
      [{ command: "pnpm", args: ["build"] }],
    );
  });

  it("deploys production as an independent static Pages app", async () => {
    const { createEditorDeployPlan } =
      await import("./cloudflare-editor-deploy.mjs");

    assert.deepEqual(
      createEditorDeployPlan({ action: "web-deploy", environment: "production" }),
      [
        { command: "pnpm", args: ["build"] },
        {
          command: "pnpm",
          args: [
            "exec",
            "wrangler",
            "pages",
            "deploy",
            "dist",
            "--project-name",
            "grimodex-try",
            "--branch",
            "master",
          ],
        },
      ],
    );
  });

  it("ships only the Editor SPA/PWA shell and no provider proxy", async () => {
    const [redirects, manifest, serviceWorker, vercelConfig] = await Promise.all([
      readFile(`${publicDir}/_redirects`, "utf8"),
      readFile(`${publicDir}/editor-manifest.webmanifest`, "utf8"),
      readFile(`${publicDir}/editor-sw.js`, "utf8"),
      readFile(`${repositoryRoot}/vercel.json`, "utf8"),
    ]);

    assert.match(redirects, /^\/\*\s+\/index\.html\s+200/m);
    assert.equal(JSON.parse(manifest).start_url, "/editor");
    assert.match(serviceWorker, /request\.mode\s*===\s*["']navigate["']/);
    assert.doesNotMatch(serviceWorker, /scan|editor-seeds/i);

    const vercel = JSON.parse(vercelConfig);
    assert.equal(vercel.rewrites.length, 1);
    assert.equal(vercel.rewrites[0].destination, "/index.html");
    assert.doesNotMatch(vercelConfig, /openrouter|anthropic\.com|openai\.com|localhost:11434/i);
  });
});
