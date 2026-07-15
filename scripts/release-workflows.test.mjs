import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { load } from "js-yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function readWorkflow(name) {
  return load(
    await readFile(path.join(repoRoot, ".github", "workflows", name), "utf8"),
  );
}

function collectUses(value, result = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectUses(entry, result);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "uses" && typeof entry === "string") result.push(entry);
      collectUses(entry, result);
    }
  }
  return result;
}

describe("release workflow boundary", () => {
  it("freezes the existing Tauri v1 artifacts instead of retaining a mutable rebuild workflow", async () => {
    const workflowNames = await readdir(
      path.join(repoRoot, ".github", "workflows"),
    );
    assert.ok(!workflowNames.includes("release-tauri.yml"));
  });

  it("builds v2 Electron assets in matrix jobs and publishes once", async () => {
    const workflow = await readWorkflow("release.yml");
    assert.equal(workflow.name, "Electron v2 Release");
    assert.deepEqual(workflow.on.push.tags, ["v2.*"]);
    assert.ok(workflow.on.workflow_dispatch);
    assert.equal(workflow.jobs.ci.uses, "./.github/workflows/ci.yml");

    const matrix = workflow.jobs.build.strategy.matrix.include;
    assert.deepEqual(
      matrix.map((entry) => entry.os),
      ["ubuntu-24.04", "macos-15", "windows-latest"],
    );
    assert.deepEqual(
      matrix.map((entry) => entry.updaterMetadata),
      ["latest-linux.yml", "latest-mac.yml", "latest.yml"],
    );
    const buildCommands = workflow.jobs.build.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    assert.match(buildCommands, /pnpm electron:native:release/);
    assert.match(buildCommands, /pnpm test:electron --run/);
    assert.match(buildCommands, /pnpm electron:build/);
    assert.match(buildCommands, /electron-builder --publish never/);
    assert.match(buildCommands, /verify-electron-updater-metadata\.mjs/);

    const publishCommands = workflow.jobs.publish.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    assert.match(publishCommands, /generate-tauri-bridge-manifest\.mjs/);
    assert.match(publishCommands, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
    assert.match(publishCommands, /minisign -Vm/);
    assert.match(publishCommands, /plugins\.updater\.pubkey/);
    assert.match(
      publishCommands,
      /packaging\/tauri-v1\/updater-public-key\.pub/,
    );
    assert.match(publishCommands, /cmp -s/);
    assert.match(publishCommands, /base64 --decode/);
    assert.match(publishCommands, /gh release create/);
    assert.match(publishCommands, /latest\.json/);
    assert.equal(workflow.jobs.publish.permissions.contents, "write");
    assert.notEqual(workflow.jobs.build.permissions?.contents, "write");
    assert.deepEqual(
      Object.entries(workflow.jobs)
        .filter(([, job]) => job.permissions?.contents === "write")
        .map(([name]) => name),
      ["publish"],
    );
    assert.equal(
      workflow.jobs["build-arch"].if,
      "needs.release-gate.outputs.prerelease == 'false'",
    );
    assert.match(workflow.jobs.publish.if, /!cancelled\(\)/);
    assert.doesNotMatch(workflow.jobs.publish.if, /always\(\)/);
    assert.match(workflow.jobs.publish.if, /build-arch\.result == 'success'/);
    assert.match(workflow.jobs.publish.if, /prerelease == 'true'/);
    assert.match(workflow.jobs.publish.if, /build-arch\.result == 'skipped'/);
  });

  it("freezes the public key embedded by the published Tauri v1 client", async () => {
    const config = JSON.parse(
      await readFile(path.join(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
    );
    const frozenPublicKey = await readFile(
      path.join(repoRoot, "packaging/tauri-v1/updater-public-key.pub"),
    );

    assert.deepEqual(
      Buffer.from(config.plugins.updater.pubkey, "base64"),
      frozenPublicKey,
    );
  });

  it("pins every third-party action to an immutable commit", async () => {
    for (const name of ["release.yml", "ci.yml", "aur-publish.yml"]) {
      const workflow = await readWorkflow(name);
      for (const uses of collectUses(workflow)) {
        if (uses.startsWith("./")) continue;
        assert.match(uses, /^[^@]+@[0-9a-f]{40}$/, `${name}: ${uses}`);
      }
    }
  });

  it("runs npm dependency audits through the supported bulk advisory client", async () => {
    const workflow = await readWorkflow("ci.yml");
    const securitySteps = workflow.jobs.security.steps;
    const setupNode = securitySteps.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    const auditStep = securitySteps.find((step) => step.name === "pnpm audit");

    assert.equal(setupNode?.with?.["node-version"], 24);
    assert.match(auditStep?.run ?? "", /corepack pnpm@11\.13\.0/);
    assert.match(auditStep?.run ?? "", /--pm-on-fail=ignore/);
    assert.match(auditStep?.run ?? "", /audit --audit-level high/);
  });

  it("runs Electron shell and native backend gates in reusable CI", async () => {
    const workflow = await readWorkflow("ci.yml");
    assert.ok(workflow.jobs.electron);
    assert.ok(workflow.jobs["electron-windows-installer-contract"]);
    assert.ok(workflow.jobs["electron-native"]);
    const commands = [
      ...workflow.jobs.electron.steps,
      ...workflow.jobs["electron-native"].steps,
    ]
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    assert.match(commands, /release-workflows\.test\.mjs/);
    assert.match(commands, /verify-electron-updater-metadata\.test\.mjs/);
    assert.match(commands, /pnpm test:electron --run/);
    assert.match(commands, /legacy-keyring-migration/);
    assert.match(commands, /grimodex-mcp/);

    const windowsCommands = workflow.jobs[
      "electron-windows-installer-contract"
    ].steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    assert.match(windowsCommands, /Language\.Parser.*ParseFile/s);
    assert.match(windowsCommands, /electron-builder --win nsis --x64/);
    assert.match(windowsCommands, /electron-contract/);
  });
});
