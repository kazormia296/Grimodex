import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";

import { composeGitHubReleaseNotes } from "./compose-github-release-notes.mjs";

describe("GitHub Draft Release notes", () => {
  it("preserves the authored Japanese and English notes in one body", () => {
    const japanese = [
      "# 端末更新通達 // GRIMODEX REVISION v2.1.0",
      "",
      "## システム改修",
      "",
      "- 起動処理を改善しました。",
    ].join("\n");
    const english = [
      "# GRIMODEX // TERMINAL REVISION v2.1.0",
      "",
      "## SYSTEM MODIFICATIONS",
      "",
      "- Improved startup behavior.",
    ].join("\n");

    const body = composeGitHubReleaseNotes({
      tag: "v2.1.0",
      japanese,
      english,
    });

    assert.equal(body, `${japanese}\n\n---\n\n${english}\n`);
  });

  it("rejects empty, placeholder, and version-mismatched notes", () => {
    assert.throws(
      () =>
        composeGitHubReleaseNotes({
          tag: "v2.1.0",
          japanese: "",
          english: "# GRIMODEX // TERMINAL REVISION v2.1.0",
        }),
      /Japanese release notes are empty/,
    );
    assert.throws(
      () =>
        composeGitHubReleaseNotes({
          tag: "v2.1.0",
          japanese: "# 端末更新通達 // GRIMODEX REVISION v2.1.0\n\n- （追記）",
          english: "# GRIMODEX // TERMINAL REVISION v2.1.0",
        }),
      /placeholder/,
    );
    assert.throws(
      () =>
        composeGitHubReleaseNotes({
          tag: "v2.1.0",
          japanese: "# 端末更新通達 // GRIMODEX REVISION v2.0.9",
          english: "# GRIMODEX // TERMINAL REVISION v2.1.0",
        }),
      /Japanese release notes heading must contain v2\.1\.0/,
    );
  });

  it("rejects inline placeholders in either language while allowing Markdown links", () => {
    assert.doesNotThrow(() =>
      composeGitHubReleaseNotes({
        tag: "v2.1.0",
        japanese:
          "# 端末更新通達 // GRIMODEX REVISION v2.1.0\n\n[変更履歴][ja-log]を公開しました。\n\n[ja-log]: https://example.com/ja",
        english:
          "# GRIMODEX // TERMINAL REVISION v2.1.0\n\nRead the [changelog](https://example.com/en).",
      }),
    );
    assert.throws(
      () =>
        composeGitHubReleaseNotes({
          tag: "v2.1.0",
          japanese:
            "# 端末更新通達 // GRIMODEX REVISION v2.1.0\n\n本改訂では、[最も重要な変更]を提供します。",
          english: "# GRIMODEX // TERMINAL REVISION v2.1.0",
        }),
      /Japanese release notes contain a placeholder/,
    );
    assert.throws(
      () =>
        composeGitHubReleaseNotes({
          tag: "v2.1.0",
          japanese: "# 端末更新通達 // GRIMODEX REVISION v2.1.0",
          english:
            "# GRIMODEX // TERMINAL REVISION v2.1.0\n\nThis release adds [most important change].",
        }),
      /English release notes contain a placeholder/,
    );
    for (const maliciousDefinition of [
      "[ja-log]: https://example.com/ja [最も重要な変更]",
      "[ja-log]: https://example.com/ja/[最も重要な変更]",
    ]) {
      assert.throws(
        () =>
          composeGitHubReleaseNotes({
            tag: "v2.1.0",
            japanese: `# 端末更新通達 // GRIMODEX REVISION v2.1.0\n\n${maliciousDefinition}`,
            english: "# GRIMODEX // TERMINAL REVISION v2.1.0",
          }),
        /Japanese release notes contain a placeholder/,
      );
    }
  });

  it("requires an exact release tag token in each heading", () => {
    for (const wrongHeadingTag of ["v2.1.00", "v2.1.0-beta.1"]) {
      assert.throws(
        () =>
          composeGitHubReleaseNotes({
            tag: "v2.1.0",
            japanese: `# 端末更新通達 // GRIMODEX REVISION ${wrongHeadingTag}`,
            english: "# GRIMODEX // TERMINAL REVISION v2.1.0",
          }),
        /Japanese release notes heading must contain v2\.1\.0/,
      );
    }
    assert.doesNotThrow(() =>
      composeGitHubReleaseNotes({
        tag: "v2.1.0-beta.1",
        japanese: "# 端末更新通達 // GRIMODEX REVISION v2.1.0-beta.1",
        english: "# GRIMODEX // TERMINAL REVISION v2.1.0-beta.1",
      }),
    );
  });

  it("handles adversarial bracket inputs without backtracking", async () => {
    const moduleUrl = new URL(
      "./compose-github-release-notes.mjs",
      import.meta.url,
    ).href;
    const japanese = [
      "# 端末更新通達 // GRIMODEX REVISION v2.1.0",
      "",
      `[未完了リンク](${"\\".repeat(256)}`,
    ].join("\n");
    const unmatchedBrackets = [
      "# 端末更新通達 // GRIMODEX REVISION v2.1.0",
      "",
      "[".repeat(50_000),
    ].join("\n");
    const probe = `
      const { parentPort } = require("node:worker_threads");
      import(${JSON.stringify(moduleUrl)}).then(({ composeGitHubReleaseNotes }) => {
        try {
          composeGitHubReleaseNotes({
            tag: "v2.1.0",
            japanese: ${JSON.stringify(japanese)},
            english: "# GRIMODEX // TERMINAL REVISION v2.1.0"
          });
          throw new Error("Expected malformed notes to be rejected.");
        } catch (error) {
          if (!String(error?.message).includes("placeholder")) throw error;
        }
        composeGitHubReleaseNotes({
          tag: "v2.1.0",
          japanese: ${JSON.stringify(unmatchedBrackets)},
          english: "# GRIMODEX // TERMINAL REVISION v2.1.0"
        });
        parentPort.postMessage("completed");
      });
    `;
    const worker = new Worker(probe, { eval: true });
    let timeout;
    try {
      const result = await new Promise((resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("release-note probe timed out")),
          3_000,
        );
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) {
            reject(new Error(`release-note probe exited with code ${code}`));
          }
        });
      });
      assert.equal(result, "completed");
    } finally {
      clearTimeout(timeout);
      await worker.terminate();
    }
  });
});
