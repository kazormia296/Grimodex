import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { load } from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("Semantic reranker release resources", () => {
  it("bootstraps both pinned product models before packaging", async () => {
    const workflow = load(
      await readFile(path.join(root, ".github/workflows/release.yml"), "utf8"),
    );
    const steps = workflow.jobs.build.steps;
    const bootstrapIndex = steps.findIndex(
      (step) => step.name === "Bootstrap pinned Semantic Recall rerankers",
    );
    const packageIndex = steps.findIndex(
      (step) =>
        step.name === "Build non-macOS host packages without publishing",
    );

    assert.ok(
      steps.some(
        (step) =>
          typeof step.uses === "string" &&
          step.uses.startsWith("astral-sh/setup-uv@") &&
          step.with?.version === "0.11.29",
      ),
    );
    assert.ok(bootstrapIndex > -1);
    assert.ok(bootstrapIndex < packageIndex);
    assert.equal(
      steps[bootstrapIndex]["working-directory"],
      "experiments/lfm25-encoder-phase0",
    );
    assert.match(
      steps[bootstrapIndex].run,
      /uv run --frozen --no-dev python tools\/bootstrap_rerankers\.py/,
    );
    assert.match(steps[bootstrapIndex].run, /--model ja_xsmall/);
    assert.match(steps[bootstrapIndex].run, /--model en_minilm_l4/);
  });
});
