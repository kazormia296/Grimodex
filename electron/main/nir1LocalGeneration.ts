/**
 * Main's side of the NIR-1 local generation route (DD-1b;
 * `docs/plans/nir1-lane-decisions/dd1b-decisions.md`, DR-DD1B-1..8; K5/3
 * `nir1-local-product-send` 必須防御 16, 17).
 *
 * - Main's gate: the six commands of K5/3's "IPC の command" table are refused
 *   with a typed value before the caller identity, D2a, the key store or
 *   Native is reached, unless the journey seam opened Native's gate at
 *   startup. PUB-L does not open this gate; it is closed in every product
 *   launch.
 * - The journey seam: a launch that is not packaged (the environment is then
 *   not read at all), runs with `CI=true`, carries the public owner token, a
 *   per-launch UUIDv4 nonce and the journey's own userData opens Native's
 *   `nir1-local-generation` entry once and, only if that succeeded, Main's
 *   gate. It replaces nothing else: the destination, the transport, the key
 *   verdict, the route rules, the AI usage policy, D2a and the audit stay the
 *   product's. Renderer, preload, IPC and settings can neither enable nor
 *   disable it.
 * - The sender, its window and the caller Main issued (the profile
 *   activation's Main check 1), the binding of a handle to the sender that
 *   started it, and the stop of the sender's generations when it is
 *   destroyed, its window closes or its caller identity is replaced.
 * - Main's key verdict for the route's endpoint, attached as a symbol sidecar.
 */
import path from "node:path";

import {
  isNir1LocalGenerationCommand,
  isNir1LocalWireId,
  NIR1_LOCAL_MAIN_KEY_VERDICT,
  nir1LocalRefusalValue,
  type Envelope,
  type NapiBackendLike,
  type Nir1LocalGenerationCommand,
  type Nir1LocalMainKeyVerdict,
  type Nir1LocalRefusalReason,
  type SecretsResolver,
} from "../shared/ipcContract.js";
import type { ProfileEgressGate } from "./profileEgress.js";

export const NIR1_LOCAL_GENERATION_CI_SEAM_VERSION = 1;
export const NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN_ENV =
  "GRIMODEX_NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN";
export const NIR1_LOCAL_GENERATION_CI_NONCE_ENV =
  "GRIMODEX_NIR1_LOCAL_GENERATION_CI_NONCE";
/** Public constant; the seam is not a secret. */
export const NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN =
  "dd1b-nir1-local-generation-owner-v1";
/** The journey's own userData; the seam is inert without it. */
export const NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV = "GRIMODEX_USER_DATA_DIR";
export const NIR1_LOCAL_GENERATION_CI_GATE_ENTRY = "nir1-local-generation";
/** The env names a journey receipt records with the seam version. */
export const NIR1_LOCAL_GENERATION_CI_ENV_NAMES = [
  "CI",
  NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN_ENV,
  NIR1_LOCAL_GENERATION_CI_NONCE_ENV,
  NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV,
] as const;
/** Handles Main keeps bound at once (Native keeps at most 16). */
export const NIR1_LOCAL_BOUND_HANDLE_LIMIT = 64;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type Nir1LocalGenerationCiSeam =
  | { readonly active: false }
  | { readonly active: true; readonly nonce: string };

const INACTIVE: Nir1LocalGenerationCiSeam = { active: false };

/** What a launch knows at startup; read once by `registerIpcRouter`. */
export interface Nir1LocalGenerationLaunch {
  /** Only `false` can activate the seam. */
  readonly isPackaged: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly userDataDir: string;
  /** The development and product data directories; computed only if needed. */
  readonly defaultUserDataDirs: () => readonly string[];
}

/**
 * Parses the launch. A packaged launch returns before any value of the
 * environment is read. Any mismatch is inactive; nothing of a rejected value
 * is kept. Nothing throws.
 */
export function parseNir1LocalGenerationCiSeam(
  launch: Nir1LocalGenerationLaunch,
): Nir1LocalGenerationCiSeam {
  if (launch.isPackaged !== false) return INACTIVE;
  try {
    const { env } = launch;
    if (env.CI !== "true") return INACTIVE;
    if (
      env[NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN_ENV] !==
      NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN
    ) {
      return INACTIVE;
    }
    const nonce = env[NIR1_LOCAL_GENERATION_CI_NONCE_ENV];
    if (typeof nonce !== "string" || !UUID_V4.test(nonce)) return INACTIVE;
    const journeyUserData = env[NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV];
    if (
      typeof journeyUserData !== "string" ||
      !path.isAbsolute(journeyUserData) ||
      typeof launch.userDataDir !== "string" ||
      !path.isAbsolute(launch.userDataDir) ||
      path.resolve(journeyUserData) !== path.resolve(launch.userDataDir)
    ) {
      return INACTIVE;
    }
    const defaults = launch.defaultUserDataDirs();
    if (
      !Array.isArray(defaults) ||
      defaults.some(
        (directory) =>
          typeof directory !== "string" ||
          sameDirectory(directory, journeyUserData),
      )
    ) {
      return INACTIVE;
    }
    return { active: true, nonce: nonce.toLowerCase() };
  } catch {
    return INACTIVE;
  }
}

/** Case-insensitive where the file system usually is (macOS, Windows). */
function sameDirectory(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "darwin" || process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Opens Native's entry once for an active seam. Returns whether the route's
 * gates are open; a packaged launch, an inactive seam or a failed open leaves
 * both closed.
 */
export function startNir1LocalGenerationCiSeam(options: {
  readonly seam: Nir1LocalGenerationCiSeam;
  readonly backend: Pick<NapiBackendLike, "mainOpenPrePublicationGate"> | null;
  readonly isPackaged: boolean;
}): boolean {
  const { seam, backend, isPackaged } = options;
  // Defense in depth: a packaged launch never opens, whatever `seam` says.
  if (!seam.active || isPackaged !== false) return false;
  if (typeof backend?.mainOpenPrePublicationGate !== "function") return false;
  try {
    backend.mainOpenPrePublicationGate(NIR1_LOCAL_GENERATION_CI_GATE_ENTRY);
  } catch (error) {
    console.error(
      "[nir1-local-generation-ci-seam] the entry could not be opened; the route stays closed:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The route (Main's gate, the sender binding, the key verdict).
// ---------------------------------------------------------------------------

export interface Nir1LocalSender {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
}

export interface Nir1LocalWindow {
  readonly id: number;
  isDestroyed(): boolean;
  readonly webContents: unknown;
  once(event: "closed", listener: () => void): unknown;
}

export interface Nir1LocalInvokeContext {
  readonly sender: Nir1LocalSender;
  readonly win: Nir1LocalWindow | null;
  /** The identity the router issued for this invoke. */
  readonly callerIdentity: unknown;
}

interface BoundHandle {
  readonly senderId: number;
  readonly windowId: number;
  readonly identity: unknown;
  /**
   * A cancel's capture writer failed: Native keeps the handle through a
   * drained continue so the cancel can be retried (DR-DD1A-15).
   */
  withdrawalPending: boolean;
}

export interface Nir1LocalGenerationRoute {
  /** Whether the seam opened the route's gates for this launch. */
  readonly open: boolean;
  /**
   * Main's gate, before anything else of the invoke: a typed refusal for a
   * route command while closed, otherwise null.
   */
  gateRefusal(command: string): Envelope | null;
  /**
   * After D2a admitted the invoke: the sender, window and caller checks, the
   * stop on a replaced caller, the handle binding, and for a start Main's key
   * verdict (attached to `dispatchArgs`). A typed refusal, or null to go on.
   */
  admit(
    command: Nir1LocalGenerationCommand,
    context: Nir1LocalInvokeContext,
    dispatchArgs: Record<string, unknown>,
  ): Promise<Envelope | null>;
  /** After the completion check published `envelope`: keeps the bindings. */
  observePublished(
    command: Nir1LocalGenerationCommand,
    context: Nir1LocalInvokeContext,
    args: Record<string, unknown>,
    envelope: Envelope,
  ): void;
  /**
   * The completion check refused a start's result: the handle is not
   * returned, so the sender's generations are stopped (DR-DD1B-7).
   */
  onUnpublished(command: Nir1LocalGenerationCommand, senderId: number): void;
}

export interface Nir1LocalGenerationRouteOptions {
  readonly open: boolean;
  readonly backend: NapiBackendLike | null;
  readonly secrets?: SecretsResolver;
  readonly profileEgress?: Pick<
    ProfileEgressGate,
    "onStatusChange" | "isIssuedCallerIdentity"
  >;
}

function refusal(
  command: Nir1LocalGenerationCommand,
  reason: Nir1LocalRefusalReason,
): Envelope {
  return { ok: true, value: nir1LocalRefusalValue(command, reason) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createNir1LocalGenerationRoute(
  options: Nir1LocalGenerationRouteOptions,
): Nir1LocalGenerationRoute {
  const { open, backend, secrets, profileEgress } = options;
  const handles = new Map<string, BoundHandle>();
  const lastIdentity = new Map<number, unknown>();
  const boundSenders = new WeakSet<object>();
  const boundWindows = new WeakSet<object>();
  const liveSenders = new Set<number>();

  /** Not a withdrawal: the owner stops, the captures stay (DR-DD1A-7). */
  const cancelSender = (senderId: number): void => {
    for (const [handle, bound] of handles) {
      if (bound.senderId === senderId) handles.delete(handle);
    }
    try {
      backend?.mainNir1LocalGenerationCancelSender?.(senderId);
    } catch (error) {
      console.warn(
        "[nir1-local-generation] sender stop failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  if (open) {
    try {
      // Activation, unavailability and the end of an activation replace the
      // caller identities; stop what the old identities started. Never
      // throws (a throwing listener would fail stage 2).
      profileEgress?.onStatusChange?.(() => {
        try {
          for (const senderId of [...liveSenders]) cancelSender(senderId);
        } catch {
          // Best effort; Native's own re-check still stops the run.
        }
      });
    } catch {
      // No status listener: the per-invoke identity check below remains.
    }
  }

  const bindLifecycle = (
    sender: Nir1LocalSender,
    win: Nir1LocalWindow,
  ): void => {
    const senderId = sender.id;
    liveSenders.add(senderId);
    if (!boundSenders.has(sender)) {
      boundSenders.add(sender);
      sender.once("destroyed", () => {
        liveSenders.delete(senderId);
        lastIdentity.delete(senderId);
        cancelSender(senderId);
      });
    }
    if (!boundWindows.has(win)) {
      boundWindows.add(win);
      win.once("closed", () => cancelSender(senderId));
    }
  };

  const keyVerdict = async (): Promise<Nir1LocalMainKeyVerdict | null> => {
    let endpointId: unknown;
    try {
      const settings: unknown = JSON.parse(await backend!.getAiSettings());
      endpointId = isRecord(settings)
        ? settings.activeOpenaiCompatibleEndpointId
        : undefined;
    } catch {
      return null;
    }
    if (!isNir1LocalWireId(endpointId)) return null;
    const hasApiKey = secrets?.hasApiKey;
    if (typeof hasApiKey !== "function") {
      return { endpointId, keyVerdict: "check-failed" };
    }
    try {
      return {
        endpointId,
        keyVerdict: hasApiKey.call(secrets, "openai-compatible", endpointId)
          ? "present"
          : "absent",
      };
    } catch {
      return { endpointId, keyVerdict: "check-failed" };
    }
  };

  return {
    open,

    gateRefusal(command) {
      if (open || !isNir1LocalGenerationCommand(command)) return null;
      return refusal(command, "NIR1_LOCAL_GATE_CLOSED");
    },

    async admit(command, context, dispatchArgs) {
      if (!open) return refusal(command, "NIR1_LOCAL_GATE_CLOSED");
      const { sender, win, callerIdentity } = context;
      // Main's check: the sender, its own window, the caller Main issued.
      if (
        sender.isDestroyed() ||
        !win ||
        win.isDestroyed() ||
        win.webContents !== sender ||
        !isRecord(callerIdentity) ||
        callerIdentity.senderId !== sender.id ||
        profileEgress?.isIssuedCallerIdentity?.(callerIdentity) !== true
      ) {
        return refusal(command, "NIR1_LOCAL_SENDER_REFUSED");
      }
      // A replaced caller (epoch, workspace switch, activation): what the old
      // identity started is stopped before anything new is dispatched.
      const previous = lastIdentity.get(sender.id);
      if (previous !== undefined && previous !== callerIdentity) {
        cancelSender(sender.id);
      }
      lastIdentity.set(sender.id, callerIdentity);
      bindLifecycle(sender, win);

      if (
        command === "nir1_local_generation_continue" ||
        command === "nir1_local_generation_cancel"
      ) {
        const handle = dispatchArgs.handle;
        if (typeof handle === "string") {
          const bound = handles.get(handle);
          if (
            !bound ||
            bound.senderId !== sender.id ||
            bound.windowId !== win.id ||
            bound.identity !== callerIdentity
          ) {
            return refusal(command, "NIR1_LOCAL_HANDLE_NOT_FOUND");
          }
        }
        // A non-string handle is refused by the contract's validation.
      }

      if (command === "nir1_local_generation_start") {
        Reflect.deleteProperty(dispatchArgs, NIR1_LOCAL_MAIN_KEY_VERDICT);
        if (!backend) return null; // the contract answers backend-unavailable
        const verdict = await keyVerdict();
        if (!verdict)
          return refusal(command, "NIR1_LOCAL_ENDPOINT_UNAVAILABLE");
        Object.defineProperty(dispatchArgs, NIR1_LOCAL_MAIN_KEY_VERDICT, {
          value: verdict,
          enumerable: false,
          configurable: true,
        });
      }
      return null;
    },

    observePublished(command, context, args, envelope) {
      if (!envelope.ok || !isRecord(envelope.value)) return;
      const value = envelope.value;
      const { sender, win, callerIdentity } = context;
      if (command === "nir1_local_generation_start") {
        if (value.status !== "started" || typeof value.handle !== "string") {
          return;
        }
        if (!win) return;
        handles.set(value.handle, {
          senderId: sender.id,
          windowId: win.id,
          identity: callerIdentity,
          withdrawalPending: false,
        });
        while (handles.size > NIR1_LOCAL_BOUND_HANDLE_LIMIT) {
          const oldest = handles.keys().next().value;
          if (oldest === undefined) break;
          handles.delete(oldest);
        }
        return;
      }
      const handle = args.handle;
      if (typeof handle !== "string") return;
      const bound = handles.get(handle);
      if (!bound) return;
      if (
        value.status === "refused" &&
        (value.reason === "NIR1_LOCAL_HANDLE_NOT_FOUND" ||
          value.reason === "NIR1_LOCAL_CALLER_REVOKED")
      ) {
        handles.delete(handle);
        return;
      }
      if (command === "nir1_local_generation_cancel") {
        if (value.status === "ok") bound.withdrawalPending = false;
        else if (value.reason === "NIR1_LOCAL_CANCEL_CAPTURE_FAILED") {
          bound.withdrawalPending = true;
        }
        return;
      }
      if (
        command === "nir1_local_generation_continue" &&
        value.status === "ok" &&
        value.drained === true &&
        !bound.withdrawalPending
      ) {
        handles.delete(handle);
      }
    },

    onUnpublished(command, senderId) {
      if (command === "nir1_local_generation_start") cancelSender(senderId);
    },
  };
}
