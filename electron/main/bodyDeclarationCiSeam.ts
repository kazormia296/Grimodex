/**
 * Main-process-only evaluation seam for the body declaration (CB-2, K2/4
 * "Main の一回限りの確認 > 評価用の CI seam").
 *
 * Until PUB-G the pre-publication gate is closed in every product launch. The
 * one exception is a launch that is not packaged, runs with `CI=true`, and
 * carries both the public owner token below and a per-launch UUIDv4 nonce.
 * Such a launch opens Native's gate once at startup and replaces the dialog's
 * display and button press, and nothing else: Native's preview, issue,
 * consume, writer, expiry, the single in-flight confirmation and the sender
 * and window binding are the product's own path.
 *
 * The seam approves `body-declaration` and nothing else. The owner token is
 * public and the nonce is not a secret: whoever starts an unpackaged process
 * with the right environment can approve without a dialog. K2/4 accepts that
 * residual. Renderer, preload and IPC can neither enable nor disable the seam;
 * it reads only `process.env` at startup.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import path from "node:path";

import type { NapiBackendLike } from "../shared/ipcContract.js";
import type { MainGrantConfirm } from "./mainGrant.js";

export const BODY_DECLARATION_CI_SEAM_VERSION = 1;
export const BODY_DECLARATION_CI_OWNER_TOKEN_ENV =
  "GRIMODEX_BODY_DECLARATION_CI_OWNER_TOKEN";
export const BODY_DECLARATION_CI_NONCE_ENV =
  "GRIMODEX_BODY_DECLARATION_CI_NONCE";
/** Public constant; the seam is not a secret (K2/4 Out-of-scope). */
export const BODY_DECLARATION_CI_OWNER_TOKEN = "cb2-body-declaration-owner-v1";
export const BODY_DECLARATION_CI_GATE_ENTRY = "scene-body-declaration";
export const BODY_DECLARATION_CI_RECEIPT_TYPE =
  "grimodex:body-declaration-ci-receipt";
export const BODY_DECLARATION_CI_RECEIPT_ROOT_NAME =
  ".grimodex-body-declaration-ci-receipts";
export const BODY_DECLARATION_CI_RECEIPT_MAX_BYTES = 4_096;
/** The receipt keeps the newest approvals; the count keeps growing. */
export const BODY_DECLARATION_CI_RECEIPT_MAX_DIGESTS = 16;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type BodyDeclarationCiSeam =
  | { readonly active: false }
  | { readonly active: true; readonly nonce: string };

/**
 * Parses the launch environment. Any mismatch (packaged, `CI` other than the
 * exact string `true`, a token that differs from the constant, a nonce that is
 * not a UUIDv4) is inactive and the gate stays closed. Nothing throws and
 * nothing of a rejected value is kept.
 */
export function parseBodyDeclarationCiSeam(
  env: NodeJS.ProcessEnv,
  { isPackaged }: { readonly isPackaged: boolean },
): BodyDeclarationCiSeam {
  if (isPackaged) return { active: false };
  if (env.CI !== "true") return { active: false };
  if (
    env[BODY_DECLARATION_CI_OWNER_TOKEN_ENV] !== BODY_DECLARATION_CI_OWNER_TOKEN
  ) {
    return { active: false };
  }
  const nonce = env[BODY_DECLARATION_CI_NONCE_ENV];
  if (typeof nonce !== "string" || !UUID_V4.test(nonce)) {
    return { active: false };
  }
  return { active: true, nonce: nonce.toLowerCase() };
}

export interface BodyDeclarationCiReceipt {
  readonly version: typeof BODY_DECLARATION_CI_SEAM_VERSION;
  readonly type: typeof BODY_DECLARATION_CI_RECEIPT_TYPE;
  readonly seamVersion: typeof BODY_DECLARATION_CI_SEAM_VERSION;
  readonly envNames: {
    readonly ci: "CI";
    readonly ownerToken: typeof BODY_DECLARATION_CI_OWNER_TOKEN_ENV;
    readonly nonce: typeof BODY_DECLARATION_CI_NONCE_ENV;
  };
  /** The nonce itself is never written. */
  readonly nonceDigest: string;
  readonly isPackaged: false;
  readonly gateEntry: typeof BODY_DECLARATION_CI_GATE_ENTRY;
  /** false: written just before Native's gate is opened; true: after. */
  readonly gateOpened: boolean;
  readonly approvedGrantKinds: readonly ["body-declaration"];
  readonly approvedGrantCount: number;
  /** Digests of what Main bound each approval to, newest last. */
  readonly approvedBindingDigests: readonly string[];
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function bodyDeclarationCiNonceDigest(nonce: string): string {
  return `sha256:${sha256Hex(nonce)}`;
}

function encodeReceipt(receipt: BodyDeclarationCiReceipt): string {
  // The object is built with a fixed key order, so this is stable.
  return JSON.stringify(receipt);
}

/** `<userData>/.grimodex-body-declaration-ci-receipts/<nonce digest>/receipt.json` */
export function bodyDeclarationCiReceiptPath(
  userDataDir: string,
  nonce: string,
): string {
  return path.join(
    userDataDir,
    BODY_DECLARATION_CI_RECEIPT_ROOT_NAME,
    sha256Hex(nonce),
    "receipt.json",
  );
}

async function requireRealDirectory(candidate: string): Promise<void> {
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      "body declaration receipt directory must be a regular directory",
    );
  }
}

/**
 * Writes the receipt next to the others in the already-configured userData:
 * a private directory, a temporary file created exclusively, and a rename in
 * the same directory, so a reader sees no receipt or one complete receipt.
 */
async function writeReceipt(
  userDataDir: string,
  nonce: string,
  receipt: BodyDeclarationCiReceipt,
  sequence: number,
): Promise<void> {
  if (!path.isAbsolute(userDataDir) || userDataDir.includes("\u0000")) {
    throw new Error("body declaration receipt userDataDir must be absolute");
  }
  const userDataReal = await realpath(userDataDir);
  const finalPath = bodyDeclarationCiReceiptPath(userDataReal, nonce);
  const dir = path.dirname(finalPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await requireRealDirectory(path.dirname(dir));
  await requireRealDirectory(dir);
  const encoded = encodeReceipt(receipt);
  if (
    Buffer.byteLength(encoded, "utf8") > BODY_DECLARATION_CI_RECEIPT_MAX_BYTES
  ) {
    throw new Error("body declaration receipt exceeds its byte bound");
  }
  const temporaryPath = path.join(dir, `receipt.${sequence}.tmp`);
  const handle = await open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, finalPath);
}

export interface BodyDeclarationCiSeamHandle {
  /** Replaces the dialog's display and button press, for `body-declaration`. */
  readonly confirm: MainGrantConfirm;
  readonly receiptPath: string;
}

/**
 * Starts the seam for this launch: writes the first receipt, opens Native's
 * gate once, writes the receipt that says it opened, and returns the replacement confirmation. Returns null for an
 * inactive launch without touching the backend. If the gate cannot be opened
 * the seam is not started and the gate stays closed.
 */
export async function startBodyDeclarationCiSeam(options: {
  readonly seam: BodyDeclarationCiSeam;
  readonly backend: Pick<NapiBackendLike, "mainOpenPrePublicationGate"> | null;
  readonly isPackaged: boolean;
  readonly userDataDir: string;
}): Promise<BodyDeclarationCiSeamHandle | null> {
  const { seam, backend, isPackaged, userDataDir } = options;
  // Defense in depth: a packaged launch never starts, whatever `seam` says.
  if (!seam.active || isPackaged) return null;
  if (typeof backend?.mainOpenPrePublicationGate !== "function") return null;

  const digests: string[] = [];
  let approvedGrantCount = 0;
  let sequence = 0;
  const receiptFor = (
    count: number,
    approved: readonly string[],
    gateOpened = true,
  ): BodyDeclarationCiReceipt => ({
    version: BODY_DECLARATION_CI_SEAM_VERSION,
    type: BODY_DECLARATION_CI_RECEIPT_TYPE,
    seamVersion: BODY_DECLARATION_CI_SEAM_VERSION,
    envNames: {
      ci: "CI",
      ownerToken: BODY_DECLARATION_CI_OWNER_TOKEN_ENV,
      nonce: BODY_DECLARATION_CI_NONCE_ENV,
    },
    nonceDigest: bodyDeclarationCiNonceDigest(seam.nonce),
    isPackaged: false,
    gateEntry: BODY_DECLARATION_CI_GATE_ENTRY,
    gateOpened,
    approvedGrantKinds: ["body-declaration"],
    approvedGrantCount: count,
    approvedBindingDigests: [...approved],
  });

  // The receipt comes first: a gate is never opened without evidence that this
  // seam was about to open it. If this write fails the gate stays closed.
  try {
    sequence += 1;
    await writeReceipt(
      userDataDir,
      seam.nonce,
      receiptFor(0, [], false),
      sequence,
    );
    backend.mainOpenPrePublicationGate(BODY_DECLARATION_CI_GATE_ENTRY);
  } catch (error) {
    console.error(
      "[body-declaration-ci-seam] startup failed; the seam is not started:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
  const receiptPath = bodyDeclarationCiReceiptPath(userDataDir, seam.nonce);
  try {
    sequence += 1;
    await writeReceipt(
      userDataDir,
      seam.nonce,
      receiptFor(approvedGrantCount, digests),
      sequence,
    );
  } catch (error) {
    // The gate is open but the "opened" receipt failed. Return a handle that
    // refuses every approval, so an open gate never reaches the product's own
    // dialog in a launch whose evidence is incomplete.
    console.error(
      "[body-declaration-ci-seam] receipt failed after the gate opened; every approval is refused:",
      error instanceof Error ? error.message : String(error),
    );
    return { confirm: async () => false, receiptPath };
  }

  const confirm: MainGrantConfirm = async (confirmation) => {
    // Only the body declaration is approved. Any other kind (a future
    // ProfileActivation, for one) falls through to a refusal, never to the
    // product's dialog.
    if (confirmation.kind !== "body-declaration") return false;
    try {
      const nextDigests = [...digests, confirmation.approvalDigest].slice(
        -BODY_DECLARATION_CI_RECEIPT_MAX_DIGESTS,
      );
      sequence += 1;
      // The evidence is on disk before the approval is given.
      await writeReceipt(
        userDataDir,
        seam.nonce,
        receiptFor(approvedGrantCount + 1, nextDigests),
        sequence,
      );
      approvedGrantCount += 1;
      digests.splice(0, digests.length, ...nextDigests);
      return true;
    } catch (error) {
      console.error(
        "[body-declaration-ci-seam] receipt failed; the confirmation is refused:",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  };

  return { confirm, receiptPath };
}
