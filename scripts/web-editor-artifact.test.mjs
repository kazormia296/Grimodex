import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { validateWebEditorArtifact } from "./validate-web-editor-artifact.mjs";

const EDITOR_STANDARD_GLASS_CSS =
  '[data-editor-fluid-glass="true"]>[data-editor-fluid-glass-filter]{backdrop-filter:blur(var(--editor-fluid-glass-blur)) saturate(var(--editor-fluid-glass-saturate)) contrast(1.03)}';
const WORKSPACE_STANDARD_GLASS_CSS =
  '[data-workspace-glass-root][data-workspace-fluid-glass="true"] [data-ambient-glass-surface]{backdrop-filter:blur(var(--workspace-fluid-glass-blur,14px)) saturate(var(--workspace-fluid-glass-saturate,1.16)) contrast(1.03)}';
const VALID_STANDARD_GLASS_CSS =
  EDITOR_STANDARD_GLASS_CSS + WORKSPACE_STANDARD_GLASS_CSS;

async function createArtifact(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-web-artifact-"));
  const assets = path.join(root, "assets");
  await mkdir(assets);
  await Promise.all(
    Object.entries({
      "index-abc.css": VALID_STANDARD_GLASS_CSS,
      ...files,
    }).map(([name, contents]) =>
      writeFile(path.join(assets, name), contents, "utf8"),
    ),
  );
  await writeFile(path.join(root, "index.html"), "<main>Editor trial</main>");
  return root;
}

describe("Web Editor artifact boundary", () => {
  it("accepts an editor-only static artifact", async () => {
    const root = await createArtifact({
      "WebEditorSettingsDialog-abc.js":
        "Ollama OpenAI Anthropic OpenRouter OpenAI-compatible Sakana AI Novelist",
      "app-abc.js": "https://openrouter.ai/api/v1/chat/completions",
      "WebEditorImportDialog-abc.js": "local browser file import",
      "WebEditorUnavailableDialogs-def.js": "export{}",
    });
    await assert.doesNotReject(validateWebEditorArtifact(root));
  });

  it("rejects desktop transfer, hosted AI proxies, and Scan network artifacts", async () => {
    for (const [name, contents, expectedError] of [
      ["TransferDialog-abc.js", "legacy import", /desktop-only chunk/i],
      ["ExportDialog-abc.js", "legacy export", /desktop-only chunk/i],
      ["app-abc.js", "/api/v1/upload-intents", /network route/i],
      ["app-abc.js", "/api/v1/scans", /network route/i],
      ["app-abc.js", "/api/v1/editor-seeds", /network route/i],
      ["app-abc.js", "VITE_SCAN_API_BASE_URL", /network route/i],
      [
        "app-abc.js",
        "grimodex-scan-staging.example.workers.dev",
        /network route/i,
      ],
      ["app-abc.js", "/api/openrouter", /network route/i],
      [
        "WebEditorImportDialog-leak.js",
        "fetch('/api/import-manuscript')",
        /import network transport/i,
      ],
      [
        "WebEditorImportDialog-beacon.js",
        "navigator.sendBeacon('/leak', 'draft')",
        /import network transport/i,
      ],
      [
        "WebEditorImportDialog-form-data.js",
        "const body = new FormData()",
        /import network transport/i,
      ],
    ]) {
      const root = await createArtifact({
        "WebEditorSettingsDialog-ok.js": "Ollama OpenAI Anthropic",
        "WebEditorImportDialog-ok.js": "local browser file import",
        [name]: contents,
      });
      await assert.rejects(validateWebEditorArtifact(root), expectedError);
    }
  });

  it("rejects a Web artifact that exposes the retired Scan import flow", async () => {
    const root = await createArtifact({
      "WebEditorSettingsDialog-ok.js": "Ollama OpenAI Anthropic",
      "WebEditorImportDialog-ok.js":
        '"data-testid":"import-source-scan";"grimodex-scan/import-plan/1"',
    });
    await assert.rejects(validateWebEditorArtifact(root), /Scan import/i);
  });

  it("rejects a Web artifact without the browser-local import dialog", async () => {
    const root = await createArtifact({
      "WebEditorSettingsDialog-ok.js": "Ollama OpenAI Anthropic",
    });
    await assert.rejects(validateWebEditorArtifact(root), /import dialog/i);
  });

  it("rejects WebKit-only Glass blur declarations", async () => {
    for (const [label, css] of [
      [
        "Editor fluid Glass",
        EDITOR_STANDARD_GLASS_CSS.replace(
          "backdrop-filter:",
          "-webkit-backdrop-filter:",
        ) + WORKSPACE_STANDARD_GLASS_CSS,
      ],
      [
        "Workspace ambient Glass",
        EDITOR_STANDARD_GLASS_CSS +
          WORKSPACE_STANDARD_GLASS_CSS.replace(
            "backdrop-filter:",
            "-webkit-backdrop-filter:",
          ),
      ],
    ]) {
      const root = await createArtifact({
        "WebEditorSettingsDialog-ok.js": "Ollama OpenAI Anthropic",
        "WebEditorImportDialog-ok.js": "local browser file import",
        "index-abc.css": css,
      });
      await assert.rejects(
        validateWebEditorArtifact(root),
        new RegExp(`${label}.*unprefixed backdrop-filter`, "i"),
      );
    }
  });
});
