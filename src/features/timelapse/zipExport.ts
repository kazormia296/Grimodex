import { zipSync, strToU8 } from "fflate";
import type { ChangeEvent } from "@/db/schema";
import type { ProjectAuthorshipReport } from "@/features/attribution/projectAuthorship";
import {
  exportAuthorshipHtml,
  exportAuthorshipJson,
} from "@/features/attribution/exportReport";
import { VERIFY_HTML_TEMPLATE } from "./verifyHtmlTemplate";
import { bytesToHex, hexToBytes } from "./hashChain";

/**
 * 執筆タイムラプス zip export.
 *
 * Bundles a self-contained evidence package:
 *   authorship-report.html  — standalone breakdown report (P1)
 *   authorship-report.json  — structured form of the same
 *   chain.json              — event metadata + hashes (no zstd payloads)
 *   verify.html             — drop-in chain re-verifier (P8)
 *
 * Entries are stored uncompressed (level 0) so the bundled verify.html can
 * pull `chain.json` back out with a tiny inline ZIP reader. Compression
 * gains on JSON would be ~3× but cost a deflate decoder in verify.html and
 * a CSP/blob-URL story we'd rather avoid.
 */
export interface BuildExportZipInput {
  report: ProjectAuthorshipReport;
  events: readonly ChangeEvent[];
}

export interface ChainJsonEvent {
  sequence: number;
  timestamp: number;
  sessionId: string;
  domain: string;
  opType: string;
  projectId: string;
  sceneId: string | null;
  entityType: string | null;
  entityId: string | null;
  payload: string;
  prevHash: string;
  hash: string;
}

export function eventsToChainJson(
  events: readonly ChangeEvent[],
): ChainJsonEvent[] {
  return events.map((ev) => ({
    sequence: ev.sequence,
    timestamp: ev.timestamp,
    sessionId: ev.sessionId,
    domain: ev.domain,
    opType: ev.opType,
    projectId: ev.projectId,
    sceneId: ev.sceneId,
    entityType: ev.entityType,
    entityId: ev.entityId,
    payload: ev.payload,
    prevHash: bytesToHex(toBytes(ev.prevHash)),
    hash: bytesToHex(toBytes(ev.hash)),
  }));
}

export function buildAuthorshipExportZip(
  input: BuildExportZipInput,
): Uint8Array {
  const chain = eventsToChainJson(input.events);
  const files = {
    "authorship-report.html": strToU8(exportAuthorshipHtml(input.report)),
    "authorship-report.json": strToU8(exportAuthorshipJson(input.report)),
    "chain.json": strToU8(`${JSON.stringify(chain, null, 2)}\n`),
    "verify.html": strToU8(VERIFY_HTML_TEMPLATE),
  };
  // level 0 = store; keeps the bundled verify.html's inline ZIP reader tiny.
  return zipSync(files, { level: 0 });
}

function toBytes(v: unknown): Uint8Array {
  // Hashes round-trip as hex TEXT from the DB; raw bytes only in tests.
  if (typeof v === "string") return hexToBytes(v);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (
    v &&
    typeof v === "object" &&
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
  throw new Error("unsupported hash bytes");
}
