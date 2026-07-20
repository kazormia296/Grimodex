import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { validateWebEditorArtifact } from "./validate-web-editor-artifact.mjs";

async function createArtifact(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-web-artifact-"));
  const assets = path.join(root, "assets");
  await mkdir(assets);
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      writeFile(path.join(assets, name), contents, "utf8"),
    ),
  );
  await writeFile(path.join(root, "index.html"), "<main>Editor trial</main>");
  return root;
}

describe("Web Editor artifact boundary", () => {
  it("accepts an editor-only static artifact", async () => {
    const root = await createArtifact({
      "WebEditorSettingsDialog-abc.js": "Ollama OpenAI Anthropic",
      "WebEditorImportDialog-abc.js": "local browser file import",
      "WebEditorUnavailableDialogs-def.js": "export{}",
    });
    await assert.doesNotReject(validateWebEditorArtifact(root));
  });

  it("rejects desktop transfer, hosted AI, and OpenRouter network artifacts", async () => {
    for (const [name, contents, expectedError] of [
      ["TransferDialog-abc.js", "legacy import", /desktop-only chunk/i],
      ["ExportDialog-abc.js", "legacy export", /desktop-only chunk/i],
      [
        "app-abc.js",
        "https://openrouter.ai/api/v1/chat/completions",
        /network route/i,
      ],
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
});
