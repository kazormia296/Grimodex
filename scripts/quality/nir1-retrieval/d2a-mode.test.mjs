import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256 } from "./contract.mjs";
import {
  D2A_MODES,
  placeD2aProfileState,
  resolveD2aMode,
  restrictedProfileEgressState,
  runNir1Retrieval,
} from "../run-nir1-retrieval.mjs";

// NIR-1 DA-1 ST4 (K3/2 acceptance: R and R+IR rank the same in a restricted
// profile). The harness only learns *which* D2a mode to start Electron in; the
// contract, the Gold set and every expectation are untouched, and the default
// keeps the unrestricted measurement exactly as it was.

test("the D2a mode defaults to unrestricted and accepts only the two modes", () => {
  assert.deepEqual([...D2A_MODES], ["unrestricted", "restricted"]);
  assert.equal(resolveD2aMode({}), "unrestricted");
  assert.equal(resolveD2aMode({ "d2a-mode": "unrestricted" }), "unrestricted");
  assert.equal(resolveD2aMode({ "d2a-mode": "restricted" }), "restricted");
  for (const value of ["", "Restricted", "local-only", "off", "true"]) {
    assert.throws(
      () => resolveD2aMode({ "d2a-mode": value }),
      /--d2a-mode must be one of unrestricted, restricted/,
      JSON.stringify(value),
    );
  }
});

test("the restricted state file is schema v2 of an already restricted, quiesced profile", () => {
  const state = restrictedProfileEgressState("profile-fixed");
  assert.deepEqual(state, {
    schemaVersion: 2,
    profileId: "profile-fixed",
    callerEpoch: 1,
    restricted: true,
    handlesInvalidated: true,
    inFlightStopped: true,
  });
  assert.notEqual(
    restrictedProfileEgressState().profileId,
    restrictedProfileEgressState().profileId,
  );
  assert.equal(restrictedProfileEgressState().restricted, true);
});

test("only a restricted run places the state file, and never over an existing one", async (t) => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "nir1-d2a-state-"));
  t.after(() => rm(userData, { force: true, recursive: true }));
  assert.equal(await placeD2aProfileState(userData, "unrestricted"), undefined);
  await assert.rejects(readFile(path.join(userData, "profile-egress.json")));
  const placed = await placeD2aProfileState(userData, "restricted");
  const bytes = await readFile(placed.path);
  assert.equal(placed.path, path.join(userData, "profile-egress.json"));
  assert.equal(placed.schemaVersion, 2);
  assert.equal(placed.sha256, sha256(bytes));
  const state = JSON.parse(bytes);
  assert.equal(state.restricted, true);
  assert.equal(state.schemaVersion, 2);
  // a second placement must not silently replace the profile under test
  await assert.rejects(placeD2aProfileState(userData, "restricted"), /EEXIST/);
});

test("a precheck receipt records the D2a mode and defaults to unrestricted", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "nir1-d2a-mode-"));
  t.after(() => rm(output, { force: true, recursive: true }));
  for (const [options, expected] of [
    [{}, "unrestricted"],
    [{ "d2a-mode": "restricted" }, "restricted"],
  ]) {
    const receipt = await runNir1Retrieval({
      mode: "precheck",
      output: path.join(output, expected),
      ...options,
    });
    // The precheck stops on its missing inputs, but the mode is already
    // recorded; a restricted run never gets as far as writing a state file.
    assert.equal(receipt.d2aMode, expected);
    assert.equal(receipt.d2aStateFile, undefined);
    const written = JSON.parse(
      await readFile(path.join(output, expected, "receipt.json"), "utf8"),
    );
    assert.equal(written.d2aMode, expected);
  }
});

test("an invalid D2a mode blocks the run with a precheck error and measures nothing", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "nir1-d2a-mode-bad-"));
  t.after(() => rm(output, { force: true, recursive: true }));
  const receipt = await runNir1Retrieval({
    mode: "precheck",
    output,
    "d2a-mode": "sandboxed",
  });
  assert.equal(receipt.status, "blocked");
  assert.match(receipt.errors.join("\n"), /--d2a-mode must be one of/);
  assert.equal(receipt.cases.length, 0);
  assert.equal(receipt.d2aMode, undefined);
});
