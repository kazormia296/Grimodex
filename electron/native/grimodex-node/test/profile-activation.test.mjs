// NIR-1 DA-2 ST1 (K3/2 Positive (3), Negative (4)(5)(6), Recovery (4)): the
// profile activation through the real addon. Main's flow is ST2; here the test
// plays Main with the dialog approved, the way `activateThroughGrant` does.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  PROFILE_ACTIVATION_GATE,
  activateThroughGrant,
  displayDigest,
} from "./profile-activation-helper.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const SENDER = 7;
const WINDOW = 11;

function rig(label) {
  const root = mkdtempSync(join(tmpdir(), `grimodex-profile-activation-${label}-`));
  const appData = join(root, "app-data");
  const backend = new Backend(appData);
  return {
    root,
    appData,
    backend,
    statePath: join(appData, "profile-egress.json"),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function preview(backend) {
  return JSON.parse(await backend.profileActivationPreview(SENDER, WINDOW));
}

async function issue(backend, previewed, digest) {
  return JSON.parse(
    await backend.profileActivationIssue(previewed.previewId, SENDER, WINDOW, digest),
  ).grantId;
}

test("the backend has no grant-less activation (Negative (6))", () => {
  const r = rig("surface");
  try {
    assert.equal(typeof r.backend.activateProfileEgress, "undefined");
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(r.backend));
    const restricting = names.filter((name) => /restrict|profileactivation|egress/i.test(name));
    assert.deepEqual(restricting.sort(), [
      "initializeProfileEgress",
      "invalidateProfileEgressCallers",
      "profileActivationAbortInFlight",
      "profileActivationCommit",
      "profileActivationConsume",
      "profileActivationIssue",
      "profileActivationPreview",
      "registerProfileEgressCaller",
    ]);
    const declarations = readFileSync(join(here, "..", "index.d.ts"), "utf8");
    assert.doesNotMatch(declarations, /activateProfileEgress/);
    assert.match(declarations, /profileActivationConsume\(grantId: string, senderId: number, windowId: number\): void/);
    assert.match(declarations, /profileActivationAbortInFlight\(\): boolean/);
  } finally {
    r.close();
  }
});

test("the closed gate refuses the preview before anything is written (A-1)", async () => {
  const r = rig("closed");
  try {
    await r.backend.initializeProfileEgress();
    await assert.rejects(
      r.backend.profileActivationPreview(SENDER, WINDOW),
      /^Error: PROFILE_ACTIVATION_REFUSED:gate-closed$/,
    );
    await assert.rejects(
      r.backend.profileActivationCommit(),
      /PROFILE_ACTIVATION_REFUSED:not-reserved/,
    );
    assert.equal(existsSync(r.statePath), false);
    // The generic preview does not serve this kind.
    r.backend.mainOpenPrePublicationGate(PROFILE_ACTIVATION_GATE);
    await assert.rejects(
      r.backend.mainGrantPreview(PROFILE_ACTIVATION_GATE, "{}", SENDER, WINDOW),
      /MAIN_GRANT_KIND/,
    );
  } finally {
    r.close();
  }
});

test("Main's digest of the shown text is Native's; another text is refused (P2-3)", async () => {
  const r = rig("digest");
  try {
    r.backend.mainOpenPrePublicationGate(PROFILE_ACTIVATION_GATE);
    const first = await preview(r.backend);
    assert.deepEqual(Object.keys(first).sort(), [
      "disclosureVersion",
      "display",
      "expiresInMs",
      "previewId",
    ]);
    assert.deepEqual(first.display.buttons, ["取消", "有効にする"]);
    assert.equal(first.display.defaultId, 0);
    assert.equal(first.display.cancelId, 0);
    assert.ok(first.display.checkboxLabel.length > 0);
    const raw = JSON.stringify(first);
    assert.doesNotMatch(raw, /sha256:|profileId|callerEpoch/);

    const altered = { ...first.display, detail: `${first.display.detail} ` };
    await assert.rejects(
      issue(r.backend, first, displayDigest(altered, first.disclosureVersion)),
      /PROFILE_ACTIVATION_REFUSED:display-mismatch/,
    );
    // The preview was revoked by the mismatch.
    await assert.rejects(
      issue(r.backend, first, displayDigest(first.display, first.disclosureVersion)),
      /MAIN_GRANT_REVOKED/,
    );
    const second = await preview(r.backend);
    const grantId = await issue(
      r.backend,
      second,
      displayDigest(second.display, second.disclosureVersion),
    );
    assert.equal(typeof grantId, "string");
    assert.ok(!raw.includes(grantId));
  } finally {
    r.close();
  }
});

test("preview, issue, synchronous consume and commit restrict the profile once (Positive (3))", async () => {
  const r = rig("path");
  try {
    const initial = JSON.parse(await r.backend.initializeProfileEgress());
    r.backend.mainOpenPrePublicationGate(PROFILE_ACTIVATION_GATE);
    const previewed = await preview(r.backend);
    const grantId = await issue(
      r.backend,
      previewed,
      displayDigest(previewed.display, previewed.disclosureVersion),
    );
    // Stage 1 is synchronous (P3-1): no Promise to await before stage 2.
    const consumed = r.backend.profileActivationConsume(grantId, SENDER, WINDOW);
    assert.equal(consumed, undefined);
    assert.equal(existsSync(r.statePath), false, "nothing is persisted before stage 4");
    assert.throws(
      () => r.backend.profileActivationConsume(grantId, SENDER, WINDOW),
      /MAIN_GRANT_BUSY/,
    );
    await assert.rejects(r.backend.profileActivationPreview(SENDER, WINDOW), /MAIN_GRANT_BUSY/);

    const status = JSON.parse(await r.backend.profileActivationCommit());
    assert.equal(status.restricted, true);
    assert.equal(status.inFlightStopped, true);
    assert.equal(status.profileId, initial.profileId);
    assert.equal(status.callerEpoch, initial.callerEpoch + 1);
    assert.equal(status.unavailableReason, undefined);
    const persisted = JSON.parse(readFileSync(r.statePath, "utf8"));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.restricted, true);
    assert.equal(persisted.inFlightStopped, true);

    await assert.rejects(
      r.backend.profileActivationPreview(SENDER, WINDOW),
      /PROFILE_ACTIVATION_REFUSED:already-restricted/,
    );
    await assert.rejects(r.backend.profileActivationCommit(), /not-reserved/);

    // Recovery (4): a restart follows the state file.
    const restarted = new Backend(r.appData);
    const after = JSON.parse(await restarted.initializeProfileEgress());
    assert.equal(after.restricted, true);
    assert.equal(after.callerEpoch, status.callerEpoch);
    restarted.mainOpenPrePublicationGate(PROFILE_ACTIVATION_GATE);
    await assert.rejects(
      restarted.profileActivationPreview(SENDER, WINDOW),
      /already-restricted/,
    );
  } finally {
    r.close();
  }
});

test("a workspace open between issue and consume revokes the grant; nothing closes (D-3)", async () => {
  const r = rig("lifecycle");
  try {
    await r.backend.initializeProfileEgress();
    r.backend.mainOpenPrePublicationGate(PROFILE_ACTIVATION_GATE);
    const previewed = await preview(r.backend);
    const grantId = await issue(
      r.backend,
      previewed,
      displayDigest(previewed.display, previewed.disclosureVersion),
    );
    await r.backend.openWorkspace(join(r.root, "workspace"));
    assert.throws(
      () => r.backend.profileActivationConsume(grantId, SENDER, WINDOW),
      /MAIN_GRANT_REVOKED/,
    );
    await assert.rejects(r.backend.profileActivationCommit(), /not-reserved/);
    assert.equal(existsSync(r.statePath), false);
    // With the workspace Ready, the activation goes through.
    const status = JSON.parse(await activateThroughGrant(r.backend));
    assert.equal(status.restricted, true);
  } finally {
    r.close();
  }
});

test("Main's in-flight cancellation acts only on a reservation and restricts nothing (DR-DA2-24)", async () => {
  const r = rig("abort-in-flight");
  try {
    await r.backend.initializeProfileEgress();
    // No activation has started: nothing happens.
    assert.equal(r.backend.profileActivationAbortInFlight(), false);
    r.backend.mainOpenPrePublicationGate(PROFILE_ACTIVATION_GATE);
    const previewed = await preview(r.backend);
    const grantId = await issue(
      r.backend,
      previewed,
      displayDigest(previewed.display, previewed.disclosureVersion),
    );
    // An issued grant is not a reservation either.
    assert.equal(r.backend.profileActivationAbortInFlight(), false);
    r.backend.profileActivationConsume(grantId, SENDER, WINDOW);
    // Synchronous (no Promise), idempotent, and it closes or persists
    // nothing: the profile stays unrestricted and no state file appears.
    assert.equal(r.backend.profileActivationAbortInFlight(), true);
    assert.equal(r.backend.profileActivationAbortInFlight(), true);
    assert.equal(existsSync(r.statePath), false);
    const egress = JSON.parse(await r.backend.initializeProfileEgress());
    assert.equal(egress.restricted, false);
    assert.equal(egress.unavailableReason, undefined);
    // The activation itself still needs the commit, and only the commit.
    const status = JSON.parse(await r.backend.profileActivationCommit());
    assert.equal(status.restricted, true);
    assert.equal(status.inFlightStopped, true);
    assert.equal(r.backend.profileActivationAbortInFlight(), false);
  } finally {
    r.close();
  }
});
