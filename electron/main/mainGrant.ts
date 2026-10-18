/**
 * Main's one-time confirmation of a protected author action (MG-1, CB-2).
 *
 * A command in `GRANT_REQUIRED_COMMANDS` is not dispatched on the renderer's
 * word. Main asks Native to read the target and build the dialog text
 * (`mainGrantPreview`), shows that text and nothing else in a native dialog,
 * and only after an explicit approval asks Native for the grant
 * (`mainGrantIssue`). The grant travels to Native as a non-enumerable symbol
 * sidecar on the dispatch args; it is never returned to the renderer, never
 * put in an event, and never stored in a renderer-reachable value.
 *
 * Main keeps at most one confirmation in flight for the whole process (the
 * second one is refused with `MAIN_GRANT_BUSY`, never queued). Native's slot
 * is the authority for expiry, binding and single use; Main additionally
 * revokes when the sender is destroyed or navigates, its render process is
 * gone, its window closes, or the time left on the preview runs out.
 *
 * The gate (PUB-G) is Native's: a closed gate refuses the preview before the
 * database is read, so Main shows no dialog. Nothing here opens it.
 */
import { createHash } from "node:crypto";

import { dialog } from "electron";
import type { BrowserWindow } from "electron";

import {
  MAIN_GRANT_SIDECAR,
  type NAPI_COMMANDS,
  type Envelope,
  type NapiBackendLike,
} from "../shared/ipcContract.js";

/**
 * The commands that need a one-time grant, command to grant kind. The only
 * entry is the body declaration entry (K2/4). `narrative_scene_scope_update`
 * (the A1 save) and the revoke entry (K2-3) are not here, and a test pins it.
 */
export const GRANT_REQUIRED_COMMANDS = [
  "narrative_scene_body_declaration_declare",
] as const satisfies readonly (keyof typeof NAPI_COMMANDS)[];

export type GrantRequiredCommand = (typeof GRANT_REQUIRED_COMMANDS)[number];
export type MainGrantKind = "body-declaration";

const GRANT_KIND_BY_COMMAND = {
  narrative_scene_body_declaration_declare: "body-declaration",
} as const satisfies Record<GrantRequiredCommand, MainGrantKind>;

export const MAIN_GRANT_BUSY = "MAIN_GRANT_BUSY";
export const MAIN_GRANT_REQUIRED = "MAIN_GRANT_REQUIRED";
export const MAIN_GRANT_CANCELLED = "MAIN_GRANT_CANCELLED";
export const MAIN_GRANT_REVOKED = "MAIN_GRANT_REVOKED";
export const MAIN_GRANT_SENDER_UNAVAILABLE = "MAIN_GRANT_SENDER_UNAVAILABLE";
export const MAIN_GRANT_FAILED = "MAIN_GRANT_FAILED";

export function isGrantRequiredCommand(
  command: string,
): command is GrantRequiredCommand {
  return (GRANT_REQUIRED_COMMANDS as readonly string[]).includes(command);
}

/** Fields a renderer must never supply at the sidecar position. */
const RENDERER_GRANT_FIELDS = [
  "grant",
  "mainGrant",
  "grantId",
  "previewId",
  "senderId",
  "windowId",
] as const;

/**
 * Drops grant-shaped fields a renderer put next to the request. The grant is
 * attached later, as a symbol sidecar, and only by this module.
 */
export function stripRendererGrantFields(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...args };
  for (const field of RENDERER_GRANT_FIELDS) {
    Reflect.deleteProperty(copy, field);
  }
  // A symbol-keyed value is never taken from the caller either.
  Reflect.deleteProperty(copy, MAIN_GRANT_SIDECAR);
  return copy;
}

/** What `confirm` is shown. The text is Native's, never the renderer's. */
export interface MainGrantConfirmation {
  readonly kind: MainGrantKind;
  readonly display: string;
  readonly win: GrantWindow;
  readonly senderId: number;
  readonly windowId: number;
  /**
   * Digest over what Main bound the approval to: the kind, the dialog text,
   * the request and the sender and window. Native keeps its own binding and
   * its u64 values; they never reach Main.
   */
  readonly approvalDigest: string;
  /** Aborts when the confirmation is revoked or expires. */
  readonly signal: AbortSignal;
}

export type MainGrantConfirm = (
  confirmation: MainGrantConfirmation,
) => Promise<boolean>;

export interface GrantSender {
  readonly id: number;
  isDestroyed(): boolean;
  on(event: "destroyed", listener: () => void): unknown;
  on(event: "render-process-gone", listener: () => void): unknown;
  on(
    event: "did-start-navigation",
    listener: (details?: { isMainFrame?: boolean }) => void,
  ): unknown;
  removeListener(
    event: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (...args: any[]) => void,
  ): unknown;
}

export interface GrantWindow {
  readonly id: number;
  isDestroyed(): boolean;
  on(event: "closed", listener: () => void): unknown;
  removeListener(
    event: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (...args: any[]) => void,
  ): unknown;
}

export interface MainGrantRunContext {
  readonly command: string;
  readonly sender: GrantSender;
  readonly win: GrantWindow | null;
  /** The renderer's request, already past the authority gate and stripped. */
  readonly args: Record<string, unknown>;
  /** Dispatches the command with the given args. */
  readonly dispatch: (args: Record<string, unknown>) => Promise<Envelope>;
}

export interface MainGrantController {
  run(context: MainGrantRunContext): Promise<Envelope>;
}

export interface MainGrantControllerOptions {
  readonly backend: NapiBackendLike | null;
  /** Replaces only the dialog's display and button press (the CI seam). */
  readonly confirm?: MainGrantConfirm;
}

const DIALOG_TITLE = "本文の開示の宣言";
const DIALOG_CANCEL = "キャンセル";
const DIALOG_CONFIRM = "宣言する";

/**
 * The product's dialog. Its text is Native's `display` only. The default
 * button is Cancel; the only other button is the explicit confirmation. The
 * button labels are fixed strings of this module.
 */
export async function showMainGrantDialog(
  confirmation: MainGrantConfirmation,
): Promise<boolean> {
  const { response } = await dialog.showMessageBox(
    confirmation.win as unknown as BrowserWindow,
    {
      type: "question",
      title: DIALOG_TITLE,
      message: confirmation.display,
      buttons: [DIALOG_CANCEL, DIALOG_CONFIRM],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal: confirmation.signal,
    },
  );
  return response === 1;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function failure(error: string): Envelope {
  return { ok: false, error };
}

const NATIVE_CODE =
  /(NEX_BODY_DECLARATION_REFUSED:[a-z0-9-]+|MAIN_GRANT_[A-Z_]+|D2A_EGRESS_DENIED[^\n]*|IPC_[A-Z_]+)/u;

/**
 * Keeps only the closed code of a Native refusal. Nothing else of the message
 * (it could carry a path or a name) reaches the renderer.
 */
export function mainGrantErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return NATIVE_CODE.exec(message)?.[1] ?? MAIN_GRANT_FAILED;
}

function parseObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(MAIN_GRANT_FAILED);
  }
  return value as Record<string, unknown>;
}

function callerIdentityJson(args: Record<string, unknown>): string | undefined {
  return args.callerIdentity === undefined
    ? undefined
    : JSON.stringify(args.callerIdentity);
}

export function createMainGrantController(
  options: MainGrantControllerOptions,
): MainGrantController {
  const confirm = options.confirm ?? showMainGrantDialog;
  /** At most one confirmation for the whole process, whatever its kind. */
  let inFlight = false;

  return {
    async run(context: MainGrantRunContext): Promise<Envelope> {
      if (!isGrantRequiredCommand(context.command)) {
        return failure(MAIN_GRANT_FAILED);
      }
      const kind = GRANT_KIND_BY_COMMAND[context.command];
      const backend = options.backend;
      const { sender, win } = context;
      if (inFlight) return failure(MAIN_GRANT_BUSY);
      if (
        !backend?.mainGrantPreview ||
        !backend.mainGrantIssue ||
        !backend.mainGrantRevoke ||
        !backend.mainGrantRevokeSender
      ) {
        return failure("IPC_BACKEND_UNAVAILABLE: main grant is unavailable");
      }
      if (sender.isDestroyed() || !win || win.isDestroyed()) {
        return failure(MAIN_GRANT_SENDER_UNAVAILABLE);
      }
      inFlight = true;

      const preview = backend.mainGrantPreview.bind(backend);
      const issue = backend.mainGrantIssue.bind(backend);
      const revoke = backend.mainGrantRevoke.bind(backend);
      const revokeSender = backend.mainGrantRevokeSender.bind(backend);
      const senderId = sender.id;
      const windowId = win.id;
      const abort = new AbortController();
      let ended = false;
      let previewId: string | null = null;
      let expiry: ReturnType<typeof setTimeout> | null = null;

      const endConfirmation = (): void => {
        if (ended) return;
        ended = true;
        abort.abort();
        try {
          if (previewId !== null) revoke(previewId);
          revokeSender(senderId);
        } catch {
          // A failed revoke is not hidden: Native refuses the next preview
          // while its slot is held, and the slot expires on its own.
        }
      };
      const onSenderGone = (): void => endConfirmation();
      const onNavigation = (details?: { isMainFrame?: boolean }): void => {
        if (details?.isMainFrame === false) return;
        endConfirmation();
      };
      const onWindowClosed = (): void => endConfirmation();
      sender.on("destroyed", onSenderGone);
      sender.on("render-process-gone", onSenderGone);
      sender.on("did-start-navigation", onNavigation);
      win.on("closed", onWindowClosed);

      try {
        const request = {
          expectedWorkspacePath: context.args.expectedWorkspacePath,
          payload: context.args.payload,
        };
        const requestJson = JSON.stringify(request);
        const previewed = parseObject(
          await preview(
            kind,
            requestJson,
            senderId,
            windowId,
            callerIdentityJson(context.args),
          ),
        );
        if (
          typeof previewed.previewId !== "string" ||
          typeof previewed.display !== "string" ||
          typeof previewed.expiresInMs !== "number"
        ) {
          throw new Error(MAIN_GRANT_FAILED);
        }
        previewId = previewed.previewId;
        if (ended) return failure(MAIN_GRANT_REVOKED);
        expiry = setTimeout(
          endConfirmation,
          Math.max(0, previewed.expiresInMs),
        );
        expiry.unref?.();

        const approved = await confirm({
          kind,
          display: previewed.display,
          win,
          senderId,
          windowId,
          approvalDigest: sha256Hex(
            canonicalJson({
              kind,
              display: previewed.display,
              request,
              senderId,
              windowId,
            }),
          ),
          signal: abort.signal,
        });
        if (ended || sender.isDestroyed() || win.isDestroyed()) {
          endConfirmation();
          return failure(MAIN_GRANT_REVOKED);
        }
        if (!approved) {
          endConfirmation();
          return failure(MAIN_GRANT_CANCELLED);
        }
        const issued = parseObject(await issue(previewId, senderId, windowId));
        if (typeof issued.grantId !== "string" || issued.grantId.length === 0) {
          throw new Error(MAIN_GRANT_FAILED);
        }
        if (ended) return failure(MAIN_GRANT_REVOKED);
        // From here Native's consume spends the grant; the expiry timer no
        // longer applies. Listeners stay until the writer returns, and a
        // late revoke of a consumed grant is a no-op in Native.
        if (expiry !== null) clearTimeout(expiry);
        expiry = null;
        const dispatchArgs: Record<string, unknown> = {
          ...stripRendererGrantFields(context.args),
        };
        if (context.args.callerIdentity !== undefined) {
          Object.defineProperty(dispatchArgs, "callerIdentity", {
            value: context.args.callerIdentity,
            enumerable: false,
            configurable: true,
          });
        }
        Object.defineProperty(dispatchArgs, MAIN_GRANT_SIDECAR, {
          value: Object.freeze({
            grantId: issued.grantId,
            senderId,
            windowId,
          }),
          enumerable: false,
          configurable: true,
        });
        return await context.dispatch(dispatchArgs);
      } catch (error) {
        endConfirmation();
        return failure(mainGrantErrorCode(error));
      } finally {
        if (expiry !== null) clearTimeout(expiry);
        // Every path ends the confirmation. `endConfirmation` is idempotent;
        // when it already ran before the preview resolved (previewId was
        // still null), the preview Native created afterwards is revoked
        // here, so Native's slot never outlives Main's record. Revoking a
        // consumed grant is a no-op in Native.
        endConfirmation();
        if (previewId !== null) {
          try {
            revoke(previewId);
          } catch {
            // Same as above: Native refuses the next preview while held.
          }
        }
        sender.removeListener("destroyed", onSenderGone);
        sender.removeListener("render-process-gone", onSenderGone);
        sender.removeListener("did-start-navigation", onNavigation);
        win.removeListener("closed", onWindowClosed);
        inFlight = false;
      }
    },
  };
}
