/**
 * Main's side of the Mastra agent turn route, gate L (MP-3b, DR-MP3-2, -4, -17;
 * wire: `electron/shared/mastraAgentTurnWire.ts`).
 *
 * - Main's gate: `mastra_agent_turn_start` and `mastra_agent_turn_cancel` are
 *   answered with a typed `gate-closed` refusal before the caller identity, the
 *   profile gate, the key store or any handler is reached, unless the journey
 *   seam opened the gate at startup. A launch of the product never does; there
 *   is no other opener. The gate is Main's only: there is no Native entry and
 *   no Native method behind it (DR-MP3-2), so this file never opens one.
 * - The journey seam: a launch that is not packaged (the environment is then
 *   not read at all), runs with `CI=true`, carries this route's own owner token
 *   and a per-launch UUIDv4 nonce, and runs with the journey's own userData
 *   (different from the default data directories) opens Main's gate. The seam
 *   names (owner token, nonce) are this route's; the userData variable is the
 *   application's and the other seams' shared name (`GRIMODEX_USER_DATA_DIR`).
 *   It replaces nothing else: the destination, the transport, the key, the
 *   profile gate and the audit stay the product's. Renderer, preload, IPC and
 *   settings can neither enable nor disable it.
 * - With the gate open the sender, its window and the caller identity are
 *   checked, the request is re-checked with the wire's parser, and an admitted
 *   command goes to the turn owner (`mastraTurnOwner.ts`, 3c). Without an owner
 *   (3b's shape, and the tests of the route alone) an admitted `start` is
 *   refused as `unsupported` and `cancel` answers `found: false`.
 *
 * This file imports no `@mastra/*` (a static test holds it); the owner loads the
 * runtime, and only while this gate is open.
 */
import { realpathSync } from "node:fs";
import path from "node:path";

import {
  isMastraAgentTurnCommand,
  MASTRA_AGENT_TURN_ANSWER_COMMAND,
  MASTRA_AGENT_TURN_CANCEL_COMMAND,
  MASTRA_AGENT_TURN_START_COMMAND,
  mastraAgentTurnRefusalValue,
  parseMastraAgentTurnAnswerRequest,
  parseMastraAgentTurnCancelRequest,
  parseMastraAgentTurnStartRequest,
  type MastraAgentTurnCommand,
  type MastraAgentTurnRefusalReason,
} from "../shared/mastraAgentTurnWire.js";
import type {
  CommandArgs,
  Envelope,
  ShellCommandHandlers,
} from "../shared/ipcContract.js";
import type {
  MastraAgentTurnCancelRequest,
  MastraAgentTurnStartRequest,
} from "../shared/mastraAgentTurnWire.js";
import type { ProfileEgressGate } from "./profileEgress.js";

export const MASTRA_AGENT_TURN_CI_SEAM_VERSION = 1;
export const MASTRA_AGENT_TURN_CI_OWNER_TOKEN_ENV =
  "GRIMODEX_MASTRA_AGENT_TURN_CI_OWNER_TOKEN";
export const MASTRA_AGENT_TURN_CI_NONCE_ENV =
  "GRIMODEX_MASTRA_AGENT_TURN_CI_NONCE";
/** Public constant; the seam is not a secret. */
// The value avoids the hyphenated name of the third bundle, which 3a's static
// test (`mastraWorkspaceDisabled.static.test.ts`) reserves for 3c's loader.
export const MASTRA_AGENT_TURN_CI_OWNER_TOKEN = "mp3b-turn-gate-owner-v1";
/** The journey's own userData; shared with the application and the other seams. */
export const MASTRA_AGENT_TURN_CI_USER_DATA_ENV = "GRIMODEX_USER_DATA_DIR";
/** The env names a journey receipt records with the seam version. */
export const MASTRA_AGENT_TURN_CI_ENV_NAMES = [
  "CI",
  MASTRA_AGENT_TURN_CI_OWNER_TOKEN_ENV,
  MASTRA_AGENT_TURN_CI_NONCE_ENV,
  MASTRA_AGENT_TURN_CI_USER_DATA_ENV,
] as const;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type MastraAgentTurnCiSeam =
  | { readonly active: false }
  | { readonly active: true; readonly nonce: string };

const INACTIVE: MastraAgentTurnCiSeam = { active: false };

/** What a launch knows at startup; the same facts the other seams read once. */
export interface MastraAgentTurnLaunch {
  /** Only `false` can activate the seam. */
  readonly isPackaged: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly userDataDir: string;
  /** The development and product data directories; computed only if needed. */
  readonly defaultUserDataDirs: () => readonly string[];
}

/**
 * Parses the launch. A packaged launch returns before any value of the
 * environment is read. Any mismatch is inactive; nothing of a rejected value is
 * kept. Nothing throws.
 */
export function parseMastraAgentTurnCiSeam(
  launch: MastraAgentTurnLaunch,
): MastraAgentTurnCiSeam {
  if (launch.isPackaged !== false) return INACTIVE;
  try {
    const { env } = launch;
    // Own properties only: a value inherited through a polluted prototype is
    // never a seam value.
    const read = (name: string): unknown =>
      Object.hasOwn(env, name) ? env[name] : undefined;
    if (read("CI") !== "true") return INACTIVE;
    if (
      read(MASTRA_AGENT_TURN_CI_OWNER_TOKEN_ENV) !==
      MASTRA_AGENT_TURN_CI_OWNER_TOKEN
    ) {
      return INACTIVE;
    }
    const nonce = read(MASTRA_AGENT_TURN_CI_NONCE_ENV);
    if (typeof nonce !== "string" || !UUID_V4.test(nonce)) return INACTIVE;
    const journeyUserData = read(MASTRA_AGENT_TURN_CI_USER_DATA_ENV);
    if (
      typeof journeyUserData !== "string" ||
      !path.isAbsolute(journeyUserData) ||
      typeof launch.userDataDir !== "string" ||
      !path.isAbsolute(launch.userDataDir)
    ) {
      return INACTIVE;
    }
    // The same directory after links are resolved; an unresolvable one
    // (missing, unreadable) is inert.
    const journeyReal = realpathSync(journeyUserData);
    if (!sameDirectory(journeyReal, realpathSync(launch.userDataDir))) {
      return INACTIVE;
    }
    const defaults = launch.defaultUserDataDirs();
    if (
      !Array.isArray(defaults) ||
      defaults.some(
        (directory) =>
          typeof directory !== "string" ||
          sameDirectory(resolvedDirectory(directory), journeyReal),
      )
    ) {
      return INACTIVE;
    }
    return { active: true, nonce: nonce.toLowerCase() };
  } catch {
    return INACTIVE;
  }
}

/** A directory with its links resolved when it exists, else as written. */
function resolvedDirectory(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return path.resolve(directory);
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
 * Whether Main's gate is open for this launch. There is no Native entry to
 * open (DR-MP3-2): the seam alone decides, and a packaged launch never opens,
 * whatever `seam` says (defense in depth).
 */
export function openMastraAgentTurnGate(options: {
  readonly seam: MastraAgentTurnCiSeam;
  readonly isPackaged: boolean;
}): boolean {
  return options.seam.active && options.isPackaged === false;
}

// ---------------------------------------------------------------------------
// The route (Main's gate, the sender checks, the handlers).
// ---------------------------------------------------------------------------

export interface MastraAgentTurnSender {
  readonly id: number;
  isDestroyed(): boolean;
}

export interface MastraAgentTurnWindow {
  readonly id: number;
  isDestroyed(): boolean;
  readonly webContents: unknown;
}

export interface MastraAgentTurnInvokeContext {
  readonly sender: MastraAgentTurnSender;
  readonly win: MastraAgentTurnWindow | null;
  /** The identity the router issued for this invoke. */
  readonly callerIdentity: unknown;
}

/**
 * What the route needs of the turn owner (`mastraTurnOwner.ts`): the two
 * commands, for a request the route has already admitted and parsed.
 */
export interface MastraAgentTurnOwnerPort {
  /** A start's answer value (a refusal or the completed turn), or a rejection. */
  start(
    context: MastraAgentTurnInvokeContext,
    request: MastraAgentTurnStartRequest,
  ): Promise<unknown>;
  cancel(
    context: MastraAgentTurnInvokeContext,
    request: MastraAgentTurnCancelRequest,
  ): unknown;
}

export interface MastraAgentTurnRoute {
  /** Whether the seam opened Main's gate for this launch. */
  readonly open: boolean;
  /**
   * Main's gate, before anything else of the invoke: a typed `gate-closed`
   * refusal for a route command while closed, otherwise null.
   */
  gateRefusal(command: string): Envelope | null;
  /**
   * After the profile gate admitted the invoke: the sender, its own window and
   * the caller Main issued. A typed `sender-refused`, or null to go on. A caller
   * identity that Main did not issue to this sender is never accepted, and a
   * missing identity is a refusal too: this route never issues one itself.
   */
  admit(
    command: MastraAgentTurnCommand,
    context: MastraAgentTurnInvokeContext,
  ): Envelope | null;
  /**
   * The shell handlers of the two commands (they re-check the request). These
   * carry no sender, so they never reach the owner: a start is `unsupported`.
   */
  readonly handlers: ShellCommandHandlers;
  /**
   * The same handlers for one admitted invoke: with the sender, its window and
   * the caller identity the router issued, which the owner binds a turn to.
   */
  handlersFor(context: MastraAgentTurnInvokeContext): ShellCommandHandlers;
}

export interface MastraAgentTurnRouteOptions {
  readonly open: boolean;
  /** The turn owner; without one an admitted start is `unsupported`. */
  readonly owner?: MastraAgentTurnOwnerPort;
  readonly profileEgress?: Pick<ProfileEgressGate, "isIssuedCallerIdentity">;
}

function refusal(
  command: MastraAgentTurnCommand,
  reason: MastraAgentTurnRefusalReason,
): Envelope {
  return { ok: true, value: mastraAgentTurnRefusalValue(command, reason) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createMastraAgentTurnRoute(
  options: MastraAgentTurnRouteOptions,
): MastraAgentTurnRoute {
  const { open, profileEgress, owner } = options;

  const handlerValue = (
    command: MastraAgentTurnCommand,
    args: CommandArgs,
    context: MastraAgentTurnInvokeContext | null,
  ): unknown => {
    // Defense in depth: the router answers a closed gate first.
    if (!open) return mastraAgentTurnRefusalValue(command, "gate-closed");
    if (command === MASTRA_AGENT_TURN_START_COMMAND) {
      const parsed = parseMastraAgentTurnStartRequest(args);
      if (!parsed.ok) return mastraAgentTurnRefusalValue(command, "invalid");
      // Without an owner, or without the invoke's sender, nothing is run.
      if (!owner || !context) {
        return mastraAgentTurnRefusalValue(command, "unsupported");
      }
      return owner.start(context, parsed.value);
    }
    const parsed = parseMastraAgentTurnCancelRequest(args);
    if (!parsed.ok) return mastraAgentTurnRefusalValue(command, "invalid");
    if (!owner || !context) {
      return { status: "ok", turnId: parsed.value.turnId, found: false };
    }
    return owner.cancel(context, parsed.value);
  };

  const handlersWith = (
    context: MastraAgentTurnInvokeContext | null,
  ): ShellCommandHandlers => ({
    [MASTRA_AGENT_TURN_START_COMMAND]: (args) =>
      new Promise((resolve, reject) => {
        try {
          resolve(handlerValue(MASTRA_AGENT_TURN_START_COMMAND, args, context));
        } catch (error) {
          reject(error);
        }
      }),
    [MASTRA_AGENT_TURN_CANCEL_COMMAND]: (args) =>
      new Promise((resolve, reject) => {
        try {
          resolve(
            handlerValue(MASTRA_AGENT_TURN_CANCEL_COMMAND, args, context),
          );
        } catch (error) {
          reject(error);
        }
      }),
    [MASTRA_AGENT_TURN_ANSWER_COMMAND]: async (args) => {
      const parsed = parseMastraAgentTurnAnswerRequest(args);
      return parsed.ok
        ? { status: "refused", reason: "no-pending" }
        : { status: "refused", reason: "invalid" };
    },
  });

  return {
    open,

    gateRefusal(command) {
      if (open || !isMastraAgentTurnCommand(command)) return null;
      return refusal(command, "gate-closed");
    },

    admit(command, context) {
      if (!open) return refusal(command, "gate-closed");
      const { sender, win, callerIdentity } = context;
      if (
        sender.isDestroyed() ||
        !win ||
        win.isDestroyed() ||
        win.webContents !== sender ||
        !isRecord(callerIdentity) ||
        callerIdentity.senderId !== sender.id ||
        profileEgress?.isIssuedCallerIdentity?.(callerIdentity) !== true
      ) {
        return refusal(command, "sender-refused");
      }
      return null;
    },

    handlers: handlersWith(null),

    handlersFor: (context) => handlersWith(context),
  };
}
