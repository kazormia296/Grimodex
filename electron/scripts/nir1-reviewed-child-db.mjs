import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

// This query is intentionally used only after every Electron process that
// owns the fixture has exited. Renderer SQL remains unable to read either
// payload_json column; this is a diagnostic snapshot of the closed fixture.
const REVISION_SNAPSHOT_QUERY = `
  SELECT id AS revisionId,
         proposal_id AS proposalId,
         revision_number AS revisionNumber,
         payload_json AS payloadJson,
         origin_kind AS originKind,
         reconciliation_envelope_json AS envelopeJson,
         reconciliation_envelope_digest AS envelopeDigest,
         created_at AS createdAt,
         created_by AS createdBy
    FROM narrative_proposal_revisions
   ORDER BY revision_number ASC, id ASC;
`;

function requiredString(row, key, index) {
  const value = row?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`closed revision snapshot row ${index} has invalid ${key}`);
  }
  return value;
}

function parseJsonColumn(row, key, index) {
  const raw = requiredString(row, key, index);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `closed revision snapshot row ${index} has malformed ${key}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Convert sqlite3 JSON rows into the same revision shape used by the
 * evidence assertions. Kept pure so the closed-fixture contract is tested
 * without opening a renderer SQL route.
 */
export function parseClosedRevisionRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("closed revision snapshot must be an array");
  }
  return rows.map((row, index) => {
    const revisionNumber = row?.revisionNumber;
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
      throw new Error(
        `closed revision snapshot row ${index} has invalid revisionNumber`,
      );
    }
    return {
      revisionId: requiredString(row, "revisionId", index),
      proposalId: requiredString(row, "proposalId", index),
      revisionNumber,
      originKind: requiredString(row, "originKind", index),
      envelopeDigest: requiredString(row, "envelopeDigest", index),
      createdAt: requiredString(row, "createdAt", index),
      createdBy: requiredString(row, "createdBy", index),
      envelope: parseJsonColumn(row, "envelopeJson", index),
      payloadJson: parseJsonColumn(row, "payloadJson", index),
    };
  });
}

export function findClosedRevision(rows, revisionId) {
  const revision = rows.find((row) => row.revisionId === revisionId);
  if (!revision) {
    throw new Error(
      `closed revision snapshot is missing requested revision ${revisionId}`,
    );
  }
  return revision;
}

export async function readClosedRevisionSnapshot(databasePath) {
  const { stdout } = await execFile(
    "sqlite3",
    [
      "-readonly",
      "-nofollow",
      "-bail",
      "-json",
      databasePath,
      REVISION_SNAPSHOT_QUERY,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const raw = JSON.parse(String(stdout).trim() || "[]");
  return parseClosedRevisionRows(raw);
}
