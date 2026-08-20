import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { writeReleaseProvenance } from "./write-release-provenance.mjs";

describe("release provenance", () => {
  it("records immutable source identity and sorted asset digests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-provenance-"));
    const assetsDir = path.join(root, "assets");
    const output = path.join(assetsDir, "provenance.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(assetsDir));
    await writeFile(path.join(assetsDir, "zeta.bin"), "zeta");
    await writeFile(path.join(assetsDir, "LICENSE"), "license");

    const result = await writeReleaseProvenance(
      new Map([
        ["assets-dir", assetsDir],
        ["output", output],
        ["source-repository", "kazormia296/Grimodex"],
        ["source-tag", "v2.0.11"],
        ["source-commit", "a".repeat(40)],
        ["source-run-id", "123"],
        ["source-run-attempt", "2"],
        ["publication-repository", "kazormia296/Grimodex-Releases"],
        ["publication-tag", "v2.0.11"],
      ]),
    );

    assert.deepEqual(
      result.assets.map(({ name }) => name),
      ["LICENSE", "zeta.bin"],
    );
    assert.equal(result.source.runAttempt, 2);
    assert.equal(
      result.publication.repository,
      "kazormia296/Grimodex-Releases",
    );
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
  });

  it("rejects an empty asset directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-provenance-"));
    const assetsDir = path.join(root, "assets");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(assetsDir));
    await assert.rejects(
      writeReleaseProvenance(
        new Map([
          ["assets-dir", assetsDir],
          ["output", path.join(assetsDir, "provenance.json")],
          ["source-repository", "source"],
          ["source-tag", "v2.0.11"],
          ["source-commit", "a".repeat(40)],
          ["source-run-id", "123"],
          ["source-run-attempt", "1"],
          ["publication-repository", "target"],
          ["publication-tag", "v2.0.11"],
        ]),
      ),
      /at least one asset/,
    );
  });
});
