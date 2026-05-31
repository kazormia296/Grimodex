/**
 * 執筆タイムラプス hash chain.
 *
 * Each event carries `hash = sha256(prevHash || canonicalSerialize(eventBody))`.
 * `eventBody` omits `id`/`hash` (they're derived) but includes everything else
 * — including `prevHash` — so re-ordering or in-place mutation breaks the chain.
 *
 * `crypto.subtle.digest` is available in modern browsers and Node 20+. Tests
 * run under happy-dom which polyfills it via Node's Web Crypto.
 */

/**
 * Hash chain verifies against any row shape that has the chain-relevant
 * fields. We accept either `Uint8Array` or `Buffer` for the hashes — drizzle
 * returns Buffer at runtime but tests sometimes hand-build with Uint8Array.
 */
export interface EventForVerify {
  projectId: string;
  sceneId: string | null;
  domain: string;
  opType: string;
  entityType: string | null;
  entityId: string | null;
  payload: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  // Hex string (from the DB) or raw bytes (in-memory / tests); toBytes handles both.
  prevHash: Uint8Array | Buffer | string;
  hash: Uint8Array | Buffer | string;
}

/** 32-byte zero hash used as the bootstrap prevHash for the very first event. */
export const GENESIS_HASH: Uint8Array = new Uint8Array(32);

/**
 * Canonicalise the event body before hashing.
 *
 * Key order is fixed in code so that two events with the same content always
 * serialize identically regardless of JS object insertion order quirks.
 * `payload` is treated as opaque text — callers should canonicalise their own
 * JSON before passing it in.
 */
export function canonicalSerializeEvent(body: {
  projectId: string;
  sceneId: string | null;
  domain: string;
  opType: string;
  entityType: string | null;
  entityId: string | null;
  payload: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  prevHash: Uint8Array;
}): Uint8Array {
  const obj: Record<string, unknown> = {
    projectId: body.projectId,
    sceneId: body.sceneId,
    domain: body.domain,
    opType: body.opType,
    entityType: body.entityType,
    entityId: body.entityId,
    payload: body.payload,
    sessionId: body.sessionId,
    sequence: body.sequence,
    timestamp: body.timestamp,
    prevHash: bytesToHex(body.prevHash),
  };
  return new TextEncoder().encode(JSON.stringify(obj));
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // `crypto.subtle.digest` returns ArrayBuffer; wrap into Uint8Array.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(digest);
}

/**
 * Compute the hash of the next event given its body (with prevHash).
 */
export async function computeEventHash(body: {
  projectId: string;
  sceneId: string | null;
  domain: string;
  opType: string;
  entityType: string | null;
  entityId: string | null;
  payload: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  prevHash: Uint8Array;
}): Promise<Uint8Array> {
  return sha256(canonicalSerializeEvent(body));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1)
    s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

/** Convert a hex string back into a 32-byte Uint8Array; throws on bad input. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return out;
}

export interface VerifyResult {
  ok: boolean;
  /** Sequence number of the first event whose hash didn't match. */
  brokenAt?: number;
  /** Human-readable summary for UI/logs. */
  reason?: string;
}

/**
 * Verify chain continuity over a contiguous, sequence-sorted slice of events.
 *
 * Caller is responsible for selecting the slice (typically all events for one
 * project, sorted by `sequence`).
 *
 * For each event we recompute `sha256(canonical(body))` and assert it matches
 * the stored `hash`; the next event's `prevHash` must equal the previous
 * event's `hash`. The first event's `prevHash` is accepted as-is (it points
 * into the prior session's tail; cross-session anchoring is verified by the
 * caller if desired).
 */
export async function verifyChain(
  events: readonly EventForVerify[],
): Promise<VerifyResult> {
  let prev: Uint8Array | null = null;
  for (const ev of events) {
    const evPrev = toBytes(ev.prevHash);
    if (prev && !bytesEqual(prev, evPrev)) {
      return {
        ok: false,
        brokenAt: ev.sequence,
        reason: `prevHash mismatch at sequence ${ev.sequence}`,
      };
    }
    const recomputed = await computeEventHash({
      projectId: ev.projectId,
      sceneId: ev.sceneId,
      domain: ev.domain,
      opType: ev.opType,
      entityType: ev.entityType,
      entityId: ev.entityId,
      payload: ev.payload,
      sessionId: ev.sessionId,
      sequence: ev.sequence,
      timestamp: ev.timestamp,
      prevHash: evPrev,
    });
    const stored = toBytes(ev.hash);
    if (!bytesEqual(recomputed, stored)) {
      return {
        ok: false,
        brokenAt: ev.sequence,
        reason: `hash mismatch at sequence ${ev.sequence}`,
      };
    }
    prev = stored;
  }
  return { ok: true };
}

function toBytes(
  v: Uint8Array | Buffer | ArrayBuffer | string | unknown,
): Uint8Array {
  // Hashes are stored as hex TEXT (the sqlite-proxy can't round-trip BLOBs).
  if (typeof v === "string") return hexToBytes(v);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // drizzle returns Node Buffer for blob columns; Buffer extends Uint8Array
  // already, so the first branch usually catches it. Guard anyway.
  if (
    typeof v === "object" &&
    v !== null &&
    "buffer" in (v as { buffer?: unknown }) &&
    "byteLength" in (v as { byteLength?: unknown })
  ) {
    const view = v as {
      buffer: ArrayBufferLike;
      byteOffset: number;
      byteLength: number;
    };
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error("unsupported hash representation");
}
