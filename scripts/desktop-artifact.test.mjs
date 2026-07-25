import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { validateDesktopArtifact } from "./validate-desktop-artifact.mjs";

async function createArtifact(files) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-desktop-artifact-"),
  );
  const assets = path.join(root, "assets");
  await mkdir(assets);
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      writeFile(path.join(assets, name), contents, "utf8"),
    ),
  );
  await writeFile(path.join(root, "index.html"), "<main>Grimodex</main>");
  return root;
}

describe("Desktop renderer artifact boundary", () => {
  it("accepts an artifact without the Web Editor WebLLM runtime", async () => {
    const root = await createArtifact({
      "app-abc.js": "const runtimeTarget = 'electron';",
    });

    await assert.doesNotReject(validateDesktopArtifact(root));
  });

  it("rejects WebLLM workers and runtime chunks", async () => {
    for (const [name, contents] of [
      ["webllm.worker-abc.js", "worker"],
      ["lib-abc.js", "CreateWebWorkerMLCEngine(worker, model)"],
    ]) {
      const root = await createArtifact({ [name]: contents });
      await assert.rejects(validateDesktopArtifact(root), /WebLLM/i);
    }
  });
});
