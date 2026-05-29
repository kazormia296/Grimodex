// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildAuthorshipExportZip, eventsToChainJson } from "./zipExport";
import {
  GENESIS_HASH,
  computeEventHash,
  verifyChain,
  bytesToHex,
} from "./hashChain";
import type { ProjectAuthorshipReport } from "@/features/attribution/projectAuthorship";
import type { ChangeEvent } from "@/db/schema";

const sampleReport: ProjectAuthorshipReport = {
  projectId: "p1",
  projectTitle: "Sample",
  generatedAt: "2026-05-29T00:00:00.000Z",
  scope: "body-text-only",
  totals: {
    human: 100,
    ai: 0,
    unknown: 0,
    unmarked: 0,
    total: 100,
    humanRatio: 1,
  },
  chapters: [],
  unparentedScenes: [],
};

async function buildEvents(count: number): Promise<ChangeEvent[]> {
  let prev: Uint8Array = GENESIS_HASH;
  const out: ChangeEvent[] = [];
  for (let i = 1; i <= count; i += 1) {
    const body = {
      projectId: "p1",
      sceneId: null,
      domain: "editor",
      opType: "doc.step",
      entityType: null,
      entityId: null,
      payload: `{"i":${i}}`,
      sessionId: "s",
      sequence: i,
      timestamp: 1_700_000_000_000 + i,
      prevHash: prev,
    };
    const hash = await computeEventHash(body);
    out.push({
      id: i,
      ...body,
      prevHash: bytesToHex(prev),
      hash: bytesToHex(hash),
    });
    prev = hash;
  }
  return out;
}

describe("buildAuthorshipExportZip", () => {
  it("emits a zip containing the documented entries", async () => {
    const events = await buildEvents(2);
    const zip = buildAuthorshipExportZip({ report: sampleReport, events });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual([
      "authorship-report.html",
      "authorship-report.json",
      "chain.json",
      "verify.html",
    ]);
    const reportJson = JSON.parse(strFromU8(files["authorship-report.json"]));
    expect(reportJson.projectId).toBe("p1");
    const chain = JSON.parse(strFromU8(files["chain.json"]));
    expect(chain).toHaveLength(2);
    expect(typeof chain[0].hash).toBe("string");
    expect(chain[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(strFromU8(files["verify.html"])).toContain("crypto.subtle");
  });

  it("chain.json round-trips through verifyChain", async () => {
    const events = await buildEvents(4);
    const chainJson = eventsToChainJson(events);
    // Reconstruct an EventForVerify[] from the JSON and confirm the chain
    // re-verifies — this is the contract that verify.html relies on.
    const reconstructed = chainJson.map((c) => ({
      projectId: c.projectId,
      sceneId: c.sceneId,
      domain: c.domain,
      opType: c.opType,
      entityType: c.entityType,
      entityId: c.entityId,
      payload: c.payload,
      sessionId: c.sessionId,
      sequence: c.sequence,
      timestamp: c.timestamp,
      prevHash: hexToBytes(c.prevHash),
      hash: hexToBytes(c.hash),
    }));
    expect((await verifyChain(reconstructed)).ok).toBe(true);
  });
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return out;
}
