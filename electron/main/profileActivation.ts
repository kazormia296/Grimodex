/**
 * Main's side of the profile activation request (NIR-1 DA-2 ST2; K3/2
 * "activation の trigger と開示" 要求 and "Main の確認" 1 to 6; DR-DA2-16 and
 * DR-DA2-17 in `docs/plans/nir1-lane-decisions/da2-decisions.md`).
 *
 * The renderer can only ask. Main checks the sender, the window, the caller
 * and the state, asks Native for the preview (behind the closed-by-default
 * pre-publication gate: before PUB-G the answer is `not-activated` and no
 * dialog is shown), shows Native's text and nothing else with Cancel as the
 * default and a confirmation checkbox, passes the digest of exactly what it
 * showed to Native's issue, consumes the grant synchronously (stage 1) and,
 * in the same JS task, starts stages 2 to 7 on the profile gate.
 *
 * The renderer receives a closed status code only: no preview ID, grant ID,
 * text, digest or epoch, here or in any event.
 */
import { dialog } from "electron";
import type { BrowserWindow } from "electron";

import type { NapiBackendLike } from "../shared/ipcContract.js";
import {
  PROFILE_EGRESS_STATE_EVENT,
  type ProfileActivationRequestResult,
  type ProfileActivationRequestStatus,
  type ProfileEgressStatusView,
} from "../shared/profileEgressStatusWire.js";
import {
  canonicalJson,
  createMainGrantInFlight,
  mainGrantErrorCode,
  sha256Hex,
  type GrantSender,
  type GrantWindow,
  type MainGrantInFlight,
} from "./mainGrant.js";
import {
  consumeProfileActivation,
  type ProfileEgressGate,
} from "./profileEgress.js";

/** Domain of the digest over the dialog Main showed (DR-DA2-3, P2-3). */
export const PROFILE_ACTIVATION_DISPLAY_DIGEST_DOMAIN =
  "grimodex/main-grant/v1/profile-activation/display";

/** Native's dialog text, word for word (allowlisted shape). */
export interface ProfileActivationDisplay {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly checkboxLabel: string;
  readonly buttons: readonly [string, string];
  readonly defaultId: 0;
  readonly cancelId: 0;
}

export interface ProfileActivationConfirmation {
  readonly kind: "profile-activation";
  readonly display: ProfileActivationDisplay;
  readonly win: GrantWindow;
  readonly senderId: number;
  readonly windowId: number;
  /** The digest passed to Native's issue: over exactly `display`. */
  readonly displayDigest: string;
  /** Aborts when the confirmation is revoked or expires. */
  readonly signal: AbortSignal;
}

/** What the dialog answered. Approval needs both. */
export interface ProfileActivationConfirmResponse {
  readonly response: number;
  readonly checkboxChecked: boolean;
}

export type ProfileActivationConfirm = (
  confirmation: ProfileActivationConfirmation,
) => Promise<ProfileActivationConfirmResponse>;

/** The approve button is index 1; Cancel (index 0) is default and cancel. */
const APPROVE_RESPONSE = 1;

/**
 * The product's dialog: Native's strings only, Cancel by default, the
 * checkbox unchecked.
 */
export async function showProfileActivationDialog(
  confirmation: ProfileActivationConfirmation,
): Promise<ProfileActivationConfirmResponse> {
  const { display } = confirmation;
  const { response, checkboxChecked } = await dialog.showMessageBox(
    confirmation.win as unknown as BrowserWindow,
    {
      type: "warning",
      title: display.title,
      message: display.message,
      detail: display.detail,
      checkboxLabel: display.checkboxLabel,
      checkboxChecked: false,
      buttons: [...display.buttons],
      defaultId: display.defaultId,
      cancelId: display.cancelId,
      noLink: true,
      signal: confirmation.signal,
    },
  );
  return { response, checkboxChecked };
}

export function isProfileActivationApproved(
  answer: ProfileActivationConfirmResponse,
): boolean {
  return (
    answer.response === APPROVE_RESPONSE && answer.checkboxChecked === true
  );
}

/** `"sha256:" + hex(SHA-256(canonicalJson({ domain, disclosureVersion, display })))` */
export function profileActivationDisplayDigest(
  display: ProfileActivationDisplay,
  disclosureVersion: number,
): string {
  return `sha256:${sha256Hex(
    canonicalJson({
      domain: PROFILE_ACTIVATION_DISPLAY_DIGEST_DOMAIN,
      disclosureVersion,
      display: {
        title: display.title,
        message: display.message,
        detail: display.detail,
        checkboxLabel: display.checkboxLabel,
        buttons: [...display.buttons],
        defaultId: display.defaultId,
        cancelId: display.cancelId,
      },
    }),
  )}`;
}

const DISPLAY_KEYS = [
  "title",
  "message",
  "detail",
  "checkboxLabel",
  "buttons",
  "defaultId",
  "cancelId",
] as const;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Allowlist of the preview's dialog text; anything else is refused. */
export function parseProfileActivationDisplay(
  value: unknown,
): ProfileActivationDisplay | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== DISPLAY_KEYS.length ||
    !DISPLAY_KEYS.every((key) => Object.hasOwn(record, key))
  ) {
    return null;
  }
  const { title, message, detail, checkboxLabel, buttons } = record;
  if (
    !nonEmptyString(title) ||
    !nonEmptyString(message) ||
    !nonEmptyString(detail) ||
    !nonEmptyString(checkboxLabel) ||
    !Array.isArray(buttons) ||
    buttons.length !== 2 ||
    !nonEmptyString(buttons[0]) ||
    !nonEmptyString(buttons[1]) ||
    record.defaultId !== 0 ||
    record.cancelId !== 0
  ) {
    return null;
  }
  return {
    title,
    message,
    detail,
    checkboxLabel,
    buttons: [buttons[0], buttons[1]],
    defaultId: 0,
    cancelId: 0,
  };
}

interface ParsedPreview {
  readonly previewId: string;
  readonly display: ProfileActivationDisplay;
  readonly disclosureVersion: number;
  readonly expiresInMs: number;
}

function parsePreview(json: string): ParsedPreview | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const display = parseProfileActivationDisplay(record.display);
  if (
    !nonEmptyString(record.previewId) ||
    display === null ||
    !Number.isSafeInteger(record.disclosureVersion) ||
    (record.disclosureVersion as number) < 1 ||
    typeof record.expiresInMs !== "number" ||
    !Number.isFinite(record.expiresInMs)
  ) {
    return null;
  }
  return {
    previewId: record.previewId,
    display,
    disclosureVersion: record.disclosureVersion as number,
    expiresInMs: Math.max(0, record.expiresInMs),
  };
}

/** Native's closed refusal → the renderer's closed status (DR-DA2-16). */
export function profileActivationStatusForError(
  error: unknown,
): ProfileActivationRequestStatus {
  const code = mainGrantErrorCode(error);
  if (code.startsWith("PROFILE_EGRESS_UNAVAILABLE:")) return "unavailable";
  switch (code) {
    case "PROFILE_ACTIVATION_REFUSED:gate-closed":
      return "not-activated";
    case "PROFILE_ACTIVATION_REFUSED:already-restricted":
      return "already-restricted";
    case "PROFILE_ACTIVATION_REFUSED:unavailable":
      return "unavailable";
    case "PROFILE_ACTIVATION_REFUSED:lifecycle-busy":
    case "MAIN_GRANT_BUSY":
      return "busy";
    case "MAIN_GRANT_EXPIRED":
      return "expired";
    default:
      return "refused";
  }
}

export interface ProfileActivationRequestContext {
  readonly sender: GrantSender;
  /** `BrowserWindow.fromWebContents(sender)`, as the router found it. */
  readonly win: GrantWindow | null;
  /** The identity the router issued for this invoke, if any. */
  readonly callerIdentity: unknown;
}

export interface ProfileActivationController {
  request(
    context: ProfileActivationRequestContext,
  ): Promise<ProfileActivationRequestResult>;
}

export interface ProfileActivationControllerOptions {
  readonly backend: NapiBackendLike | null;
  readonly gate: ProfileEgressGate | null;
  /** Shared with MG-1 (P3-2). */
  readonly inFlight?: MainGrantInFlight;
  /** Replaces only the dialog's display and press (the journey seam). */
  readonly confirm?: ProfileActivationConfirm;
}

const result = (
  status: ProfileActivationRequestStatus,
): ProfileActivationRequestResult => ({ status });

export function createProfileActivationController(
  options: ProfileActivationControllerOptions,
): ProfileActivationController {
  const confirm = options.confirm ?? showProfileActivationDialog;
  const inFlight = options.inFlight ?? createMainGrantInFlight();

  return {
    async request(context) {
      const { backend, gate } = options;
      const { sender, win, callerIdentity } = context;

      // Main's check 1: the sender, its window and the caller Main bound.
      if (
        sender.isDestroyed() ||
        !win ||
        win.isDestroyed() ||
        !gate?.isIssuedCallerIdentity?.(callerIdentity) ||
        (callerIdentity as { senderId?: unknown }).senderId !== sender.id
      ) {
        return result("refused");
      }
      // Main's check 2: the state, and no other confirmation in flight.
      const view = gate.statusView?.();
      if (!view || view.state === "unavailable") return result("unavailable");
      if (view.state === "restricted") return result("already-restricted");
      if (view.state === "activating") return result("busy");
      if (
        !backend?.profileActivationPreview ||
        !backend.profileActivationIssue ||
        !backend.profileActivationConsume ||
        !backend.mainGrantRevoke ||
        !backend.mainGrantRevokeSender ||
        !gate.beginProfileActivation
      ) {
        return result("unavailable");
      }
      if (!inFlight.tryAcquire()) return result("busy");

      const preview = backend.profileActivationPreview.bind(backend);
      const issue = backend.profileActivationIssue.bind(backend);
      const revoke = backend.mainGrantRevoke.bind(backend);
      const revokeSender = backend.mainGrantRevokeSender.bind(backend);
      const senderId = sender.id;
      const windowId = win.id;
      const abort = new AbortController();
      let ended: "revoked" | "expired" | null = null;
      let consumed = false;
      let previewId: string | null = null;
      let expiry: ReturnType<typeof setTimeout> | null = null;

      const endConfirmation = (why: "revoked" | "expired"): void => {
        if (consumed || ended !== null) return;
        ended = why;
        abort.abort();
        try {
          if (previewId !== null) revoke(previewId);
          revokeSender(senderId);
        } catch {
          // Native refuses the next preview while its slot is held, and the
          // slot expires on its own.
        }
      };
      const onSenderGone = (): void => endConfirmation("revoked");
      const onNavigation = (details?: { isMainFrame?: boolean }): void => {
        if (details?.isMainFrame === false) return;
        endConfirmation("revoked");
      };
      const onWindowClosed = (): void => endConfirmation("revoked");
      const detach = (): void => {
        sender.removeListener("destroyed", onSenderGone);
        sender.removeListener("render-process-gone", onSenderGone);
        sender.removeListener("did-start-navigation", onNavigation);
        win.removeListener("closed", onWindowClosed);
      };
      sender.on("destroyed", onSenderGone);
      sender.on("render-process-gone", onSenderGone);
      sender.on("did-start-navigation", onNavigation);
      win.on("closed", onWindowClosed);
      const endedStatus = (): ProfileActivationRequestStatus =>
        ended === "expired" ? "expired" : "refused";

      try {
        // Main's check 3: Native's preview (gate-closed → not-activated).
        let previewed: ParsedPreview | null;
        try {
          previewed = parsePreview(await preview(senderId, windowId));
        } catch (error) {
          endConfirmation("revoked");
          return result(profileActivationStatusForError(error));
        }
        if (previewed === null) {
          endConfirmation("revoked");
          return result("refused");
        }
        previewId = previewed.previewId;
        if (ended !== null) return result(endedStatus());
        expiry = setTimeout(
          () => endConfirmation("expired"),
          previewed.expiresInMs,
        );
        expiry.unref?.();

        // Main's check 4: the dialog with Native's text only.
        const displayDigest = profileActivationDisplayDigest(
          previewed.display,
          previewed.disclosureVersion,
        );
        let answer: ProfileActivationConfirmResponse;
        try {
          answer = await confirm({
            kind: "profile-activation",
            display: previewed.display,
            win,
            senderId,
            windowId,
            displayDigest,
            signal: abort.signal,
          });
        } catch {
          if (ended !== null) return result(endedStatus());
          endConfirmation("revoked");
          return result("refused");
        }
        if (ended !== null) return result(endedStatus());
        if (sender.isDestroyed() || win.isDestroyed()) {
          endConfirmation("revoked");
          return result("refused");
        }
        if (!isProfileActivationApproved(answer)) {
          endConfirmation("revoked");
          return result("cancelled");
        }

        // Main's check 5: the issue, bound to the digest of what was shown.
        let grantId: string;
        try {
          const issued: unknown = JSON.parse(
            await issue(previewId, senderId, windowId, displayDigest),
          );
          const value =
            issued !== null && typeof issued === "object"
              ? (issued as Record<string, unknown>).grantId
              : undefined;
          if (!nonEmptyString(value)) throw new Error("MAIN_GRANT_FAILED");
          grantId = value;
        } catch (error) {
          if (ended !== null) return result(endedStatus());
          endConfirmation("revoked");
          return result(profileActivationStatusForError(error));
        }
        if (ended !== null) return result(endedStatus());
        if (expiry !== null) clearTimeout(expiry);
        expiry = null;

        // Stage 1 (synchronous) and, in the same JS task, stage 2.
        let stages: Promise<{ readonly state: string }>;
        try {
          const token = consumeProfileActivation(
            backend,
            grantId,
            senderId,
            windowId,
          );
          consumed = true;
          detach();
          stages = gate.beginProfileActivation(token);
        } catch (error) {
          if (!consumed) endConfirmation("revoked");
          return result(profileActivationStatusForError(error));
        }
        // From here the activation continues whatever happens to the sender;
        // the remaining windows learn the outcome from the state event.
        let outcome: { readonly state: string };
        try {
          outcome = await stages;
        } catch {
          return result("unavailable");
        }
        return result(
          outcome.state === "restricted" ? "activated" : "unavailable",
        );
      } finally {
        if (expiry !== null) clearTimeout(expiry);
        if (!consumed) {
          endConfirmation("revoked");
          if (previewId !== null) {
            try {
              revoke(previewId);
            } catch {
              // Same as above.
            }
          }
        }
        detach();
        inFlight.release();
      }
    },
  };
}

export interface ProfileEgressStatusNotifierDeps {
  /** Stage 2: every window title back to the product name. */
  readonly resetWindowTitles: () => void;
  /** Stage 2: the typed terminal of every stream in flight. */
  readonly terminateAiStreams: () => unknown;
  /** Unavailable: stop the periodic license check (P2-4). */
  readonly disposeLicenseValidation: () => void;
  /** Every change: the closed state to every window. */
  readonly broadcast: (channel: string, payload: unknown) => void;
}

/**
 * The gate's status listener that `index.ts` installs (DR-DA2-17,
 * DR-DA2-18). Stage 2's work throws through to the gate, which then fails
 * the activation closed.
 */
export function createProfileEgressStatusNotifier(
  deps: ProfileEgressStatusNotifierDeps,
): (view: ProfileEgressStatusView) => void {
  return (view) => {
    if (view.state === "activating") {
      deps.resetWindowTitles();
      deps.terminateAiStreams();
    }
    if (view.state === "unavailable") {
      deps.disposeLicenseValidation();
    }
    deps.broadcast(PROFILE_EGRESS_STATE_EVENT, view);
  };
}
