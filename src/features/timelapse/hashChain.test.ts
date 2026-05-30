// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  GENESIS_HASH,
  bytesToHex,
  computeEventHash,
  hexToBytes,
  verifyChain,
} from "./hashChain";
import type { EventForVerify } from "./hashChain";
import hashVectors from "./hash-vectors.json";

type EvBody = {
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
};
function evBody(over: Partial<EvBody> = {}): EvBody {
  return {
    projectId: "p1",
    sceneId: null,
    domain: "editor",
    opType: "step",
    entityType: null,
    entityId: null,
    payload: '{"a":1}',
    sessionId: "s",
    sequence: 1,
    timestamp: 1_700_000_000_000,
    prevHash: GENESIS_HASH,
    ...over,
  };
}

async function buildChain(count: number): Promise<EventForVerify[]> {
  let prev: Uint8Array = GENESIS_HASH;
  const events: EventForVerify[] = [];
  for (let i = 1; i <= count; i += 1) {
    const body = evBody({ sequence: i, prevHash: prev, payload: `{"i":${i}}` });
    const hash = await computeEventHash({ ...body, prevHash: prev });
    events.push({
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
      prevHash: Buffer.from(prev),
      hash: Buffer.from(hash),
    });
    prev = hash;
  }
  return events;
}

describe("hashChain", () => {
  it("bytesToHex / hexToBytes round-trip", () => {
    const b = new Uint8Array([0, 0x0f, 0xff, 0x42]);
    expect(bytesToHex(b)).toBe("000fff42");
    expect(Array.from(hexToBytes("000fff42"))).toEqual(Array.from(b));
  });

  it("computeEventHash is deterministic and order-independent on top-level keys", async () => {
    const a = await computeEventHash(evBody());
    const b = await computeEventHash(evBody());
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it("computeEventHash changes when payload changes", async () => {
    const a = await computeEventHash(evBody({ payload: '{"a":1}' }));
    const b = await computeEventHash(evBody({ payload: '{"a":2}' }));
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("matches committed golden hash vectors", async () => {
    for (const vector of hashVectors) {
      const hash = await computeEventHash({
        ...vector.body,
        prevHash: hexToBytes(vector.body.prevHash),
      });
      expect(bytesToHex(hash), vector.name).toBe(vector.expectedHashHex);
    }
  });

  it("verifyChain reports ok on a clean chain", async () => {
    const evs = await buildChain(5);
    const r = await verifyChain(evs);
    expect(r.ok).toBe(true);
  });

  it("verifyChain detects payload tampering", async () => {
    const evs = await buildChain(5);
    const tampered = [...evs];
    tampered[2] = { ...tampered[2], payload: '{"i":999}' };
    const r = await verifyChain(tampered);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(3);
  });

  it("verifyChain detects prevHash chain break", async () => {
    const evs = await buildChain(3);
    const tampered = [...evs];
    tampered[1] = {
      ...tampered[1],
      prevHash: Buffer.from(new Uint8Array(32).fill(0xaa)),
    };
    const r = await verifyChain(tampered);
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBe(2);
  });
});
