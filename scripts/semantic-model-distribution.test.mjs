import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { load } from "js-yaml";

const root = path.resolve(import.meta.dirname, "..");

describe("semantic model distribution boundary", () => {
  it("moves current runtime model assets with source-authenticated download and target-only publish", async () => {
    const workflow = load(
      await readFile(
        path.join(root, ".github/workflows/migrate-semantic-models.yml"),
        "utf8",
      ),
    );
    const job = workflow.jobs.migrate;
    const definition = JSON.stringify(workflow);
    const commands = job.steps.map((step) => step.run ?? "").join("\n");
    assert.equal(job.environment, "release");
    assert.equal(
      workflow.env.PUBLICATION_REPOSITORY,
      "kazormia296/GrimodexReleases",
    );
    assert.match(definition, /secrets\.GITHUB_TOKEN/);
    assert.match(definition, /secrets\.GRIMODEX_RELEASES_TOKEN/);
    assert.match(definition, /semantic-models-v1/);
    assert.match(
      definition,
      /946ae837c9cd3f78baf93af541e77facec62d31049921d7c00fbcb57b4610bcf/,
    );
    assert.match(
      definition,
      /4f1831710bec8904589cf50c58ad4d9ed3e66386f4973173c13f1e9d3ae8e44b/,
    );
    assert.match(commands, /--repo "\$PUBLICATION_REPOSITORY"/);
    assert.doesNotMatch(definition, /gh release upload[^\n]*GITHUB_REPOSITORY/);
  });
});
