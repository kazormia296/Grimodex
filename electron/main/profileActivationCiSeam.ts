/**
 * Main-process-only journey seam (a) of the profile activation (NIR-1 DA-2;
 * K3/2 "公開" (a), Negative (12); DR-DA2-10 in
 * `docs/plans/nir1-lane-decisions/da2-decisions.md`).
 *
 * Until PUB-G, Native's pre-publication entry `profile-activation` is closed
 * in every product launch, so Main answers every request `not-activated`.
 * The one exception is a launch that is not packaged, runs with `CI=true`,
 * carries the public owner token below, a per-launch UUIDv4 nonce and one of
 * the three responses, and whose userData is the journey's own
 * (`GRIMODEX_USER_DATA_DIR` set to the directory this launch uses, P3-4, and
 * that directory is neither the development nor the product data directory
 * a launch uses without the override, R-3).
 * Such a launch opens that one entry once at startup and replaces the
 * dialog's display and press with the response, and nothing else: the
 * request, Main's checks, Native's preview, the display digest, the issue,
 * the consume, stages 1 to 7 and the bounds are the product's path.
 *
 * The seam answers `profile-activation` and nothing else (the body
 * declaration seam answers only `body-declaration`). The token is public and
 * the nonce is not a secret; K3/2 accepts that residual for an unpackaged
 * process started with the exact environment. Renderer, preload and IPC can
 * neither enable nor disable the seam; it reads only `process.env` at startup.
 */
import path from "node:path";

import type { NapiBackendLike } from "../shared/ipcContract.js";
import type {
  ProfileActivationConfirm,
  ProfileActivationConfirmResponse,
} from "./profileActivation.js";

export const PROFILE_ACTIVATION_CI_SEAM_VERSION = 1;
export const PROFILE_ACTIVATION_CI_OWNER_TOKEN_ENV =
  "GRIMODEX_PROFILE_ACTIVATION_CI_OWNER_TOKEN";
export const PROFILE_ACTIVATION_CI_NONCE_ENV =
  "GRIMODEX_PROFILE_ACTIVATION_CI_NONCE";
export const PROFILE_ACTIVATION_CI_RESPONSE_ENV =
  "GRIMODEX_PROFILE_ACTIVATION_CI_RESPONSE";
/** Public constant; the seam is not a secret. */
export const PROFILE_ACTIVATION_CI_OWNER_TOKEN =
  "da2-profile-activation-owner-v1";
export const PROFILE_ACTIVATION_CI_GATE_ENTRY = "profile-activation";
/** The journey's own userData; the seam is inert without it (P3-4). */
export const PROFILE_ACTIVATION_CI_USER_DATA_ENV = "GRIMODEX_USER_DATA_DIR";

export const PROFILE_ACTIVATION_CI_RESPONSES = [
  "approve",
  "cancel",
  "timeout",
] as const;
export type ProfileActivationCiResponse =
  (typeof PROFILE_ACTIVATION_CI_RESPONSES)[number];

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ProfileActivationCiSeam =
  | { readonly active: false }
  | {
      readonly active: true;
      readonly nonce: string;
      readonly response: ProfileActivationCiResponse;
    };

/**
 * Parses the launch environment. Any mismatch is inactive and nothing of a
 * rejected value is kept. Nothing throws.
 */
export function parseProfileActivationCiSeam(
  env: NodeJS.ProcessEnv,
  options: {
    readonly isPackaged: boolean;
    readonly userDataDir: string;
    /**
     * The development and product data directories (`userData.ts`
     * `defaultUserDataDirectories`); an override equal to one is inert.
     */
    readonly defaultUserDataDirs: readonly string[];
  },
): ProfileActivationCiSeam {
  if (options.isPackaged) return { active: false };
  if (env.CI !== "true") return { active: false };
  if (
    env[PROFILE_ACTIVATION_CI_OWNER_TOKEN_ENV] !==
    PROFILE_ACTIVATION_CI_OWNER_TOKEN
  ) {
    return { active: false };
  }
  const nonce = env[PROFILE_ACTIVATION_CI_NONCE_ENV];
  if (typeof nonce !== "string" || !UUID_V4.test(nonce)) {
    return { active: false };
  }
  const response = env[PROFILE_ACTIVATION_CI_RESPONSE_ENV];
  if (
    typeof response !== "string" ||
    !(PROFILE_ACTIVATION_CI_RESPONSES as readonly string[]).includes(response)
  ) {
    return { active: false };
  }
  const journeyUserData = env[PROFILE_ACTIVATION_CI_USER_DATA_ENV];
  if (
    typeof journeyUserData !== "string" ||
    !path.isAbsolute(journeyUserData) ||
    !path.isAbsolute(options.userDataDir) ||
    path.resolve(journeyUserData) !== path.resolve(options.userDataDir)
  ) {
    return { active: false };
  }
  // R-3: the override must name a directory of the journey's own, not the
  // one an ordinary development or product launch uses.
  const defaults = options.defaultUserDataDirs;
  if (
    !Array.isArray(defaults) ||
    defaults.some(
      (directory) =>
        typeof directory !== "string" ||
        sameDirectory(directory, journeyUserData),
    )
  ) {
    return { active: false };
  }
  return {
    active: true,
    nonce: nonce.toLowerCase(),
    response: response as ProfileActivationCiResponse,
  };
}

/** Case-insensitive where the file system usually is (macOS, Windows). */
function sameDirectory(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "darwin" || process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export interface ProfileActivationCiSeamHandle {
  /** Replaces the dialog's display and press, for `profile-activation`. */
  readonly confirm: ProfileActivationConfirm;
}

const REFUSE: ProfileActivationConfirmResponse = {
  response: 0,
  checkboxChecked: false,
};

/**
 * Starts the seam for this launch: opens Native's one entry once and returns
 * the replacement confirmation. Returns null for an inactive launch without
 * touching the backend; if the entry cannot be opened the seam is not
 * started and the entry stays closed.
 */
export function startProfileActivationCiSeam(options: {
  readonly seam: ProfileActivationCiSeam;
  readonly backend: Pick<NapiBackendLike, "mainOpenPrePublicationGate"> | null;
  readonly isPackaged: boolean;
}): ProfileActivationCiSeamHandle | null {
  const { seam, backend, isPackaged } = options;
  // Defense in depth: a packaged launch never starts, whatever `seam` says.
  if (!seam.active || isPackaged) return null;
  if (typeof backend?.mainOpenPrePublicationGate !== "function") return null;
  try {
    backend.mainOpenPrePublicationGate(PROFILE_ACTIVATION_CI_GATE_ENTRY);
  } catch (error) {
    console.error(
      "[profile-activation-ci-seam] the entry could not be opened; the seam is not started:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
  const { response } = seam;
  const confirm: ProfileActivationConfirm = async (confirmation) => {
    // Only the profile activation. Any other kind is refused, never shown.
    if (confirmation.kind !== "profile-activation") return REFUSE;
    switch (response) {
      case "approve":
        return { response: 1, checkboxChecked: true };
      case "cancel":
        return REFUSE;
      case "timeout":
        // No answer until the preview's time runs out (Main's timer aborts).
        await new Promise<void>((resolve) => {
          if (confirmation.signal.aborted) {
            resolve();
            return;
          }
          confirmation.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return REFUSE;
      default: {
        const exhaustive: never = response;
        void exhaustive;
        return REFUSE;
      }
    }
  };
  return { confirm };
}
