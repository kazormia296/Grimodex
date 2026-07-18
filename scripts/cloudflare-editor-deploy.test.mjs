import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

  it("keeps the production Editor project distinct from the Scan project", async () => {
    const { createEditorDeployPlan } =
      await import("./cloudflare-editor-deploy.mjs");

    const plan = createEditorDeployPlan({
      action: "web-deploy",
      environment: "production",
      allowProduction: true,
    });
    const deploy = plan.at(-1);

    assert.deepEqual(deploy?.args?.slice(-4), [
      "--project-name",
      "grimodex-try",
      "--branch",
      "master",
    ]);
    assert.equal(deploy?.args?.includes("apps/scan-web/dist"), false);
  });
});
