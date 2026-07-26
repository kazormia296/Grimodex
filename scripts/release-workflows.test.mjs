import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { load } from "js-yaml";

import { RELEASE_BUILD_TARGETS } from "./resolve-release-workflow.mjs";

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

  it("builds v2 Electron assets in matrix jobs and creates one Draft Release", async () => {
    const workflow = await readWorkflow("release.yml");
    assert.equal(workflow.name, "Electron v2 Release");
    assert.match(workflow["run-name"], /inputs\.target/);
    assert.match(workflow["run-name"], /inputs\.candidate_ref/);
    assert.deepEqual(workflow.on.push.tags, ["v2.*"]);
    assert.ok(workflow.on.workflow_dispatch);
    assert.match(workflow.concurrency.group, /inputs\.target/);
    assert.match(workflow.concurrency.group, /inputs\.candidate_ref/);
    assert.match(workflow.concurrency.group, /release-electron-v2-mutation/);
    assert.match(workflow.concurrency.group, /inputs\.recover_draft == true/);
    assert.equal(workflow.concurrency["cancel-in-progress"], false);
    assert.equal(workflow.concurrency.queue, "max");
    assert.equal(workflow.jobs.ci.uses, "./.github/workflows/ci.yml");

    const matrix = RELEASE_BUILD_TARGETS;
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
    assert.match(publishCommands, /minisign -Vm/);
    assert.match(publishCommands, /plugins\.updater\.pubkey/);
    assert.match(
      publishCommands,
      /packaging\/tauri-v1\/updater-public-key\.pub/,
    );
    assert.match(publishCommands, /cmp -s/);
    assert.match(publishCommands, /base64 --decode/);
    assert.match(
      publishCommands,
      /PUB_DATE=\$\(git show -s --format=%cI "\$SOURCE_SHA"\)/,
    );
    assert.doesNotMatch(
      publishCommands,
      /PUB_DATE=\$\(git show -s --format=%cI "\$TAG"\)/,
    );
    assert.match(publishCommands, /gh release create/);
    assert.match(publishCommands, /latest\.json/);
    assert.match(workflow.jobs.publish.name, /draft/i);
    assert.match(
      publishCommands,
      /public\/RELEASE_NOTES\/v\$\{VERSION\}\.ja\.md/,
    );
    assert.match(
      publishCommands,
      /public\/RELEASE_NOTES\/v\$\{VERSION\}\.en\.md/,
    );
    assert.match(publishCommands, /--notes-file/);
    assert.match(publishCommands, /--method PATCH/);
    assert.doesNotMatch(publishCommands, /gh release edit/);
    assert.match(publishCommands, /--draft/);
    assert.match(publishCommands, /compose-github-release-notes\.mjs/);
    const createOrUpdateRelease = workflow.jobs.publish.steps.find(
      (step) =>
        step.name === "Create or update the single draft GitHub release",
    )?.run;
    assert.ok(createOrUpdateRelease);
    assert.match(
      createOrUpdateRelease,
      /else\s+CREATE_ARGS=\(--draft[\s\S]*?gh release create "\$TAG" "\$\{CREATE_ARGS\[@\]\}"\s+fi/,
    );
    const publishDraftVerificationStep = workflow.jobs.publish.steps.at(-1);
    assert.equal(
      publishDraftVerificationStep?.name,
      "Verify Draft identity and exact body through the GitHub API",
    );
    const publishDraftVerification = publishDraftVerificationStep?.run ?? "";
    assert.match(publishDraftVerification, /gh api --paginate --slurp/);
    assert.match(publishDraftVerification, /releases\?per_page=100/);
    assert.match(publishDraftVerification, /release\.draft!==true/);
    assert.match(publishDraftVerification, /release\.body!==expectedBody/);
    assert.equal(workflow.jobs["verify-draft-release"], undefined);
    assert.equal(workflow.jobs.publish.outputs, undefined);
    const workflowDefinition = JSON.stringify(workflow);
    assert.doesNotMatch(workflowDefinition, /--draft=false/);
    assert.doesNotMatch(workflowDefinition, /["']?draft["']?\s*[:=]\s*false/);
    assert.equal(workflow.jobs.publish.permissions.contents, "write");
    assert.equal(workflow.jobs.publish.permissions.actions, "read");
    assert.notEqual(workflow.jobs.build.permissions?.contents, "write");
    assert.deepEqual(
      Object.entries(workflow.jobs)
        .filter(([, job]) => job.permissions?.contents === "write")
        .map(([name]) => name),
      ["publish"],
    );
    assert.equal(
      workflow.jobs["build-arch"].if,
      [
        "always() &&",
        "!cancelled() &&",
        "github.event_name == 'push' &&",
        "github.ref_type == 'tag' &&",
        "needs.release-gate.outputs.should_publish == 'true' &&",
        "needs.release-gate.outputs.prerelease == 'false' &&",
        "needs.build.result == 'success'",
      ].join(" "),
    );
    assert.match(workflow.jobs.publish.if, /^always\(\) && !cancelled\(\)/);
    assert.match(workflow.jobs.publish.if, /build-arch\.result == 'success'/);
    assert.match(workflow.jobs.publish.if, /prerelease == 'true'/);
    assert.match(workflow.jobs.publish.if, /build-arch\.result == 'skipped'/);
  });

  it("supports targeted branch debugging without creating a release", async () => {
    const workflow = await readWorkflow("release.yml");
    const inputs = workflow.on.workflow_dispatch.inputs;

    assert.deepEqual(inputs.target.options, [
      "windows",
      "mac",
      "linux",
      "publish",
      "all",
    ]);
    assert.equal(inputs.target.default, "windows");
    assert.equal(inputs.publish.type, "boolean");
    assert.equal(inputs.publish.default, false);
    assert.equal(inputs.recover_draft.type, "boolean");
    assert.equal(inputs.recover_draft.default, false);
    assert.equal(inputs.source_run_id.type, "string");
    assert.equal(inputs.candidate_ref.type, "string");
    assert.equal(inputs.candidate_ref.default, "master");

    const gate = workflow.jobs["release-gate"];
    const gateCommands = gate.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    const workflowSource = gate.steps.find(
      (step) => step.id === "workflow-source",
    );
    const candidate = gate.steps.find((step) => step.id === "candidate");
    assert.equal(workflowSource?.with?.path, "workflow-source");
    assert.equal(candidate?.with?.path, "candidate");
    assert.equal(candidate?.with?.ref, "${{ inputs.candidate_ref }}");
    assert.match(gateCommands, /resolve-release-workflow\.mjs/);
    assert.match(gateCommands, /--base-package/);
    assert.match(gateCommands, /--candidate-ref/);
    assert.match(gateCommands, /--candidate-sha/);
    assert.match(gateCommands, /--recover-draft/);
    assert.deepEqual(workflow.jobs.ci.needs, [
      "release-gate",
      "bridge-signing-preflight",
    ]);
    assert.match(workflow.jobs.ci.if, /github\.event_name == 'push'/);
    assert.match(workflow.jobs.ci.if, /github\.ref_type == 'tag'/);
    assert.match(workflow.jobs.ci.if, /should_publish == 'true'/);
    assert.match(workflow.jobs.ci.if, /bridge-signing-preflight/);
    assert.equal(
      workflow.jobs.build.strategy.matrix,
      "${{ fromJSON(needs.release-gate.outputs.matrix) }}",
    );
    const buildCheckout = workflow.jobs.build.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    assert.equal(
      buildCheckout?.with?.ref,
      "${{ needs.release-gate.outputs.checkout_ref }}",
    );
    assert.match(workflow.jobs.build.if, /run_build == 'true'/);
    assert.match(workflow.jobs.build.if, /needs\.ci\.result == 'skipped'/);
    assert.match(
      workflow.jobs.build.if,
      /bridge-signing-preflight\.result == 'skipped'/,
    );
    assert.match(workflow.jobs["build-arch"].if, /should_publish == 'true'/);
    assert.match(workflow.jobs.publish.if, /should_publish == 'true'/);

    const preflight = workflow.jobs["bridge-signing-preflight"];
    const releaseState = workflow.jobs["release-state"];
    const releaseStateCommands = releaseState.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    assert.match(releaseStateCommands, /gh api --paginate --slurp/);
    assert.match(releaseStateCommands, /releases\/assets/);
    assert.match(releaseStateCommands, /validateBridgeManifestSchema/);
    assert.match(releaseStateCommands, /compose-github-release-notes\.mjs/);
    assert.match(releaseStateCommands, /release\.draft!==true/);
    assert.match(
      releaseStateCommands,
      /release\.prerelease!==expectedPrerelease/,
    );
    assert.match(releaseStateCommands, /release\.body!==expectedBody/);
    assert.match(releaseStateCommands, /Number\.isSafeInteger\(release\.id\)/);
    assert.match(
      releaseStateCommands,
      /release\.body!==expectedBody[\s\S]*echo "complete=true"/,
    );
    assert.deepEqual(preflight.needs, ["release-gate", "release-state"]);
    assert.match(preflight.if, /release-state\.outputs\.complete != 'true'/);
    const preflightCommands = preflight.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    assert.match(preflight.if, /target == 'publish'/);
    assert.match(preflight.if, /github\.ref_name/);
    assert.match(preflight.if, /github\.event\.repository\.default_branch/);
    assert.match(preflightCommands, /pnpm tauri signer sign/);
    assert.match(preflightCommands, /minisign -Vm/);
    assert.doesNotMatch(
      preflightCommands,
      /TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required/,
    );

    const publishDebug = workflow.jobs["publish-debug"];
    const publishDebugDefinition = JSON.stringify(publishDebug);
    const publishDebugCommands = publishDebug.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    assert.equal(publishDebug.permissions.contents, "read");
    assert.match(publishDebugDefinition, /source_run_id/);
    assert.match(publishDebugDefinition, /github-token/);
    for (const artifact of [
      "electron-linux",
      "electron-mac",
      "electron-windows",
    ]) {
      assert.match(publishDebugDefinition, new RegExp(artifact));
    }
    assert.doesNotMatch(publishDebugDefinition, /pattern.*electron-\*/);
    assert.match(publishDebugCommands, /pnpm tauri signer sign/);
    assert.match(publishDebugCommands, /generate-tauri-bridge-manifest\.mjs/);
    assert.match(publishDebugCommands, /workflow_dispatch/);
    assert.match(publishDebugCommands, /DEFAULT_BRANCH/);
    assert.match(publishDebugCommands, /WORKFLOW_PATH/);
    assert.match(publishDebugCommands, /git\/ref\/tags/);
    assert.match(publishDebugCommands, /SOURCE_SHA/);
    assert.doesNotMatch(publishDebugCommands, /gh release (?:create|upload)/);

    const unsignedPackage = workflow.jobs.build.steps.find(
      (step) =>
        step.name === "Build non-macOS host packages without publishing",
    );
    const signedMacPackage = workflow.jobs.build.steps.find(
      (step) => step.name === "Build signed macOS packages without publishing",
    );
    assert.equal(unsignedPackage?.if, "matrix.id != 'mac'");
    assert.equal(unsignedPackage?.env, undefined);
    assert.match(signedMacPackage?.if ?? "", /matrix\.id == 'mac'/);
    assert.match(signedMacPackage?.if ?? "", /github\.ref_name/);
    assert.match(JSON.stringify(signedMacPackage?.env), /APPLE_API_KEY/);
    assert.match(workflow.jobs.publish.if, /github\.event_name == 'push'/);
    assert.match(publishDebug.if, /inputs\.target == 'publish'/);
    assert.match(publishDebug.if, /inputs\.recover_draft == false/);
    assert.match(publishDebug.if, /github\.ref_name/);
  });

  it("recovers only a Draft from one failed immutable tag run", async () => {
    const workflow = await readWorkflow("release.yml");
    const publish = workflow.jobs.publish;
    const publishDefinition = JSON.stringify(publish);
    const publishCommands = publish.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    const recoverySource = publish.steps.find(
      (step) => step.id === "recovery-source",
    );
    const currentRunDownload = publish.steps.find(
      (step) => step.name === "Download all host artifacts into one directory",
    );
    const releaseStateCommands =
      workflow.jobs["release-state"].steps.find((step) => step.id === "state")
        ?.run ?? "";
    const publishReleaseStateCommands =
      publish.steps.find((step) => step.id === "release-state")?.run ?? "";
    const releaseMutationCommands =
      publish.steps.find(
        (step) =>
          step.name === "Create or update the single draft GitHub release",
      )?.run ?? "";
    const publishDraftVerificationCommands =
      publish.steps.find(
        (step) =>
          step.name ===
          "Verify Draft identity and exact body through the GitHub API",
      )?.run ?? "";

    assert.deepEqual(publish.needs, [
      "release-gate",
      "release-state",
      "ci",
      "bridge-signing-preflight",
      "build",
      "build-arch",
    ]);
    assert.equal(publish.permissions.actions, "read");
    assert.equal(publish.permissions.contents, "write");
    assert.equal(currentRunDownload?.if, "github.event_name == 'push'");
    assert.equal(
      publish.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
        ?.with?.["fetch-depth"],
      0,
    );
    assert.equal(
      publish.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
        ?.with?.["persist-credentials"],
      false,
    );

    assert.ok(recoverySource);
    assert.match(recoverySource.if, /workflow_dispatch/);
    assert.match(recoverySource.if, /inputs\.recover_draft == true/);
    assert.match(recoverySource.run, /CONCLUSION.*failure/s);
    assert.match(recoverySource.run, /EVENT.*push/s);
    assert.match(recoverySource.run, /WORKFLOW_PATH/);
    assert.doesNotMatch(recoverySource.run, /WORKFLOW_NAME/);
    assert.match(recoverySource.run, /git\/ref\/tags/);
    assert.match(recoverySource.run, /requires an annotated release tag/);
    assert.match(recoverySource.run, /SOURCE_SHA/);
    assert.match(recoverySource.run, /git merge-base --is-ancestor/);
    assert.match(recoverySource.run, /SOURCE_BLOB/);
    assert.match(recoverySource.run, /TRUSTED_BLOB/);
    assert.match(recoverySource.run, /package\.json/);
    assert.match(recoverySource.run, /RELEASE_NOTES/);
    assert.match(recoverySource.run, /updater-public-key\.pub/);
    assert.match(recoverySource.run, /src-tauri\/tauri\.conf\.json/);
    assert.match(recoverySource.run, /JOBS_TOTAL/);
    assert.match(recoverySource.run, /ARTIFACTS_TOTAL/);
    assert.match(recoverySource.run, /-gt 100/);
    assert.match(recoverySource.run, /ARTIFACT_ID/);
    for (const job of [
      "Build Electron (windows)",
      "Build Electron (linux)",
      "Build Electron (mac)",
      "Build Electron (arch pacman package)",
    ]) {
      assert.ok(recoverySource.run.includes(job));
    }
    assert.match(recoverySource.run, /Assemble one Draft Release/);
    assert.match(recoverySource.run, /\.expired == false/);

    for (const artifact of [
      "electron-linux",
      "electron-mac",
      "electron-windows",
      "electron-arch",
    ]) {
      assert.match(publishDefinition, new RegExp(artifact));
    }
    assert.match(publishDefinition, /source_run_id/);
    assert.match(publishDefinition, /github-token/);
    assert.match(publishDefinition, /artifact-ids/);
    for (const artifactIdOutput of [
      "linux_artifact_id",
      "mac_artifact_id",
      "windows_artifact_id",
      "arch_artifact_id",
    ]) {
      assert.match(publishDefinition, new RegExp(artifactIdOutput));
    }
    assert.match(publish.if, /workflow_dispatch/);
    assert.match(publish.if, /inputs\.target == 'publish'/);
    assert.match(publish.if, /inputs\.publish == false/);
    assert.match(publish.if, /inputs\.recover_draft == true/);
    assert.match(publish.if, /inputs\.candidate_ref/);
    assert.match(publish.if, /release-state\.outputs\.complete != 'true'/);
    assert.match(publishCommands, /gh release create/);
    assert.match(publishCommands, /--draft/);
    assert.doesNotMatch(publishCommands, /--draft=false/);
    assert.match(publishCommands, /tag moved before Release mutation/i);
    for (const commands of [
      releaseStateCommands,
      publishReleaseStateCommands,
      releaseMutationCommands,
      publishDraftVerificationCommands,
    ]) {
      assert.match(commands, /gh api --paginate --slurp/);
      assert.match(commands, /releases\?per_page=100/);
      assert.doesNotMatch(commands, /gh release view/);
    }
    for (const commands of [
      releaseStateCommands,
      publishReleaseStateCommands,
    ]) {
      assert.match(commands, /releases\/assets/);
      assert.match(commands, /latest\.json/);
      assert.match(commands, /LATEST_ASSET_COUNT/);
      assert.match(commands, /LATEST_ASSET_COUNT" -gt 1/);
    }
    assert.match(releaseMutationCommands, /--method PATCH/);
    assert.match(releaseMutationCommands, /releases\/\$\{RELEASE_ID\}/);
    assert.doesNotMatch(releaseMutationCommands, /gh release edit/);
    assert.match(
      releaseMutationCommands,
      /RELEASE_MATCH_COUNT" -eq 1[\s\S]*--method PATCH[\s\S]*else[\s\S]*gh release create/,
    );
    assert.match(
      publishDraftVerificationCommands,
      /RELEASE_MATCH_COUNT" -ne 1/,
    );
    assert.match(publishDraftVerificationCommands, /tag_name/);
    assert.match(publishDraftVerificationCommands, /release\.draft/);
    assert.match(publishDraftVerificationCommands, /release\.html_url/);
    assert.equal(workflow.jobs["verify-draft-release"], undefined);
    assert.equal(publish.outputs, undefined);
  });

  it("freezes the public key configured by the Tauri v1.0.0 bridge draft", async () => {
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

  it("passes electron-builder a certificate name without the identity prefix", async () => {
    const workflow = await readWorkflow("release.yml");
    const importCertificate = workflow.jobs.build.steps.find(
      (step) => step.name === "Import Apple Developer ID certificate",
    );
    const commands = importCertificate?.run ?? "";

    assert.match(
      commands,
      /CERT_NAME="\$\{CERT_ID#Developer ID Application: \}"/,
    );
    assert.match(commands, /echo "CSC_NAME=\$CERT_NAME"/);
    assert.doesNotMatch(commands, /CSC_NAME=\$CERT_ID/);
  });

  it("allows the frozen Tauri updater key to be passwordless", async () => {
    const workflow = await readWorkflow("release.yml");
    const signBridge = workflow.jobs.publish.steps.find(
      (step) =>
        step.name === "Sign Electron installers for the final Tauri v1 bridge",
    );
    const commands = signBridge?.run ?? "";

    assert.equal(
      signBridge?.env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
      "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    );
    assert.match(commands, /TAURI_SIGNING_PRIVATE_KEY is required/);
    assert.doesNotMatch(
      commands,
      /TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required/,
    );
  });

  it("resolves updater metadata without shell-specific environment variable syntax", async () => {
    const workflow = await readWorkflow("release.yml");
    const verifyMetadata = workflow.jobs.build.steps.find(
      (step) => step.name === "Require electron-updater metadata for this host",
    );
    const commands = verifyMetadata?.run ?? "";

    assert.match(
      commands,
      /--metadata "release\/electron\/\$\{\{ matrix\.updaterMetadata \}\}"/,
    );
    assert.doesNotMatch(commands, /\$UPDATE_METADATA/);
  });

  it("builds Windows release artifacts explicitly unsigned", async () => {
    const workflow = await readWorkflow("release.yml");
    const buildSteps = workflow.jobs.build.steps;
    const configureUnsigned = buildSteps.find(
      (step) => step.name === "Configure unsigned Windows packages",
    );
    const verifyUnsigned = buildSteps.find(
      (step) => step.name === "Verify unsigned Windows artifacts",
    );
    const buildDefinition = JSON.stringify(buildSteps);

    assert.equal(configureUnsigned?.if, "matrix.id == 'windows'");
    assert.match(
      configureUnsigned?.run ?? "",
      /CSC_IDENTITY_AUTO_DISCOVERY=false/,
    );
    assert.equal(verifyUnsigned?.if, "matrix.id == 'windows'");
    assert.match(verifyUnsigned?.run ?? "", /Get-AuthenticodeSignature/);
    assert.match(verifyUnsigned?.run ?? "", /NotSigned/);
    assert.doesNotMatch(
      buildDefinition,
      /WINDOWS_CERTIFICATE|CSC_LINK|CSC_KEY_PASSWORD/,
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

  it("publishes exact-version public releases to AUR with the protected SSH key", async () => {
    const workflow = await readWorkflow("aur-publish.yml");
    const publish = workflow.jobs.publish;
    const checkout = publish.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const commands = publish.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    const definition = JSON.stringify(publish);

    assert.equal(publish.environment, "aur");
    assert.match(publish.if, /github\.repository == 'kazormia296\/Grimodex'/);
    assert.equal(
      checkout?.with?.ref,
      "${{ github.event.repository.default_branch }}",
    );
    assert.equal(checkout?.with?.["persist-credentials"], false);
    assert.match(commands, /gh api .*releases\/tags/);
    assert.match(commands, /published_at/);
    assert.match(commands, /makepkg --printsrcinfo/);
    assert.match(commands, /AUR_SSH_PRIVATE_KEY is required/);
    assert.match(
      commands,
      /SHA256:RFzBCUItH9LZS0cKB5UE6ceAYhBD5C8GeOBip8Z11\+4/,
    );
    assert.match(
      commands,
      /ssh:\/\/aur@aur\.archlinux\.org\/grimodex-bin\.git/,
    );
    assert.match(commands, /git -C "\$aur_repository" push origin HEAD:master/);
    assert.doesNotMatch(definition, /event\.release\.prerelease/);
    assert.doesNotMatch(definition, /AUR_USERNAME|AUR_EMAIL/);
    assert.doesNotMatch(definition, /KSXGitHub\/github-actions-deploy-aur/);
  });

  it("runs npm dependency audits through the supported bulk advisory client", async () => {
    const workflow = await readWorkflow("ci.yml");
    const securitySteps = workflow.jobs.security.steps;
    const setupNode = securitySteps.find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    const auditStep = securitySteps.find((step) => step.name === "pnpm audit");

    assert.equal(setupNode?.with?.["node-version"], 22);
    assert.match(auditStep?.run ?? "", /pnpm dlx pnpm@11\.13\.0/);
    assert.match(auditStep?.run ?? "", /--pm-on-fail=ignore/);
    assert.match(auditStep?.run ?? "", /audit --audit-level high/);
  });

  it("pins brace-expansion to the patched version required by the audit gate", async () => {
    const workspace = await readFile(
      path.join(repoRoot, "pnpm-workspace.yaml"),
      "utf8",
    );
    const lockfile = await readFile(
      path.join(repoRoot, "pnpm-lock.yaml"),
      "utf8",
    );

    assert.match(workspace, /^  "brace-expansion@5\.0\.6": 5\.0\.8$/m);
    assert.match(workspace, /^  "brace-expansion@2\.1\.2": 5\.0\.8$/m);
    assert.match(workspace, /^  "brace-expansion@1\.1\.14": 5\.0\.8$/m);
    assert.match(lockfile, /^  brace-expansion@5\.0\.6: 5\.0\.8$/m);
    assert.match(lockfile, /^  brace-expansion@2\.1\.2: 5\.0\.8$/m);
    assert.match(lockfile, /^  brace-expansion@1\.1\.14: 5\.0\.8$/m);
    assert.match(lockfile, /^  brace-expansion@5\.0\.8:$/m);
    assert.doesNotMatch(lockfile, /^  brace-expansion@5\.0\.7:/m);
    assert.doesNotMatch(lockfile, /^      brace-expansion: 2\.1\.2$/m);
    assert.doesNotMatch(lockfile, /^      brace-expansion: 1\.1\.16$/m);
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
    assert.match(windowsCommands, /pnpm test:electron --run/);
    assert.match(windowsCommands, /Language\.Parser.*ParseFile/s);
    assert.match(windowsCommands, /electron-builder --win nsis --x64/);
    assert.match(windowsCommands, /electron-contract/);
  });
});
