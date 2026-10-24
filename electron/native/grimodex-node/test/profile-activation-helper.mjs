// NIR-1 DA-2 ST1 (DR-DA2-3, D-7): helpers of the node:test files that need a
// restricted profile.
//
// * `activateThroughGrant` drives the only activation Native has: the
//   pre-publication gate is opened the way the evaluation seam opens it, and
//   the ProfileActivation grant goes preview -> issue -> consume -> commit, as
//   Main does with the dialog approved. It is for the tests of the activation
//   itself (`profile-egress`, `egress-closure`, `profile-activation`).
// * `placeRestrictedProfile` writes a schema v2 restricted state file before
//   the Backend is built (K3/2 "公開" (b)). That is not an activation; it is
//   the existing startup read of a restricted profile.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROFILE_ACTIVATION_GATE = "profile-activation";
export const DISPLAY_DIGEST_DOMAIN =
  "grimodex/main-grant/v1/profile-activation/display";

/** The `canonicalJson` of `electron/main/mainGrant.ts`. */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The digest Main passes to the issue: over what it showed (P2-3). */
export function displayDigest(display, disclosureVersion) {
  const canonical = canonicalJson({
    domain: DISPLAY_DIGEST_DOMAIN,
    disclosureVersion,
    display,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export async function activateThroughGrant(
  backend,
  { senderId = 1, windowId = 1 } = {},
) {
  backend.mainOpenPrePublicationGate(PROFILE_ACTIVATION_GATE);
  const preview = JSON.parse(
    await backend.profileActivationPreview(senderId, windowId),
  );
  const { grantId } = JSON.parse(
    await backend.profileActivationIssue(
      preview.previewId,
      senderId,
      windowId,
      displayDigest(preview.display, preview.disclosureVersion),
    ),
  );
  backend.profileActivationConsume(grantId, senderId, windowId);
  return backend.profileActivationCommit();
}

export function restrictedProfileState(profileId = randomUUID()) {
  return {
    schemaVersion: 2,
    profileId,
    callerEpoch: 1,
    restricted: true,
    handlesInvalidated: true,
    inFlightStopped: true,
  };
}

export function placeRestrictedProfile(appData, profileId) {
  mkdirSync(appData, { recursive: true });
  writeFileSync(
    join(appData, "profile-egress.json"),
    JSON.stringify(restrictedProfileState(profileId)),
  );
}
