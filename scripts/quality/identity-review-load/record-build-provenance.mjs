// build の直後に、測定が動かす build 物の出所の記録を書く（F2 の R2。照合は build-provenance.mjs と launcher）。
// build 自体は実行しない・変更しない。読むのは git の HEAD・commit 時刻・未 commit の数と、build 物の sha256 だけ。
// source が dirty なら、build 物が HEAD の commit より古ければ、build の後に追跡している入力 file が書き換えられていれば
// （checkout・revert・pull で mtime が build 物より新しい。F3a の M3）、何も書かずに止まる。
// 測定の process の中で動く guard の file（renderer.ts・起動 script など。build-provenance.mjs の GUARD_FILES）の sha256 も
// 記録する。それらを変えたら、この script を取り直す（build は不要）。
//
// 使い方（build の直後、clean な HEAD で）：
//   node scripts/quality/identity-review-load/record-build-provenance.mjs [--record <path>]
// 既定の記録先は dist-electron/idl-build-provenance.json（0600）。出力は件数・ID・hash だけ。
import console from "node:console";
import process from "node:process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { safeErrorSummary } from "./lib.mjs";
import {
  PROVENANCE_RECORD_RELATIVE,
  buildProvenanceRecord,
  collectBuildState,
} from "./build-provenance.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

export function parseRecordArgs(args) {
  if (args.length === 0) return { record: "" };
  if (args.length !== 2 || args[0] !== "--record" || !args[1])
    throw new Error(
      "[precheck] USAGE record-build-provenance.mjs [--record <path>]",
    );
  return { record: args[1] };
}

/** 記録を作って書く。書いた path と記録を返す。 */
export function recordBuildProvenance({
  root = ROOT,
  recordPath = path.join(root, PROVENANCE_RECORD_RELATIVE),
  state,
  now,
} = {}) {
  const collected = state ?? collectBuildState({ root });
  const record = buildProvenanceRecord(collected, {
    ...(now ? { now } : {}),
  });
  mkdirSync(path.dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  chmodSync(recordPath, 0o600);
  return { recordPath, record };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const { record: recordArg } = parseRecordArgs(process.argv.slice(2));
    const { recordPath, record } = recordBuildProvenance({
      ...(recordArg ? { recordPath: path.resolve(recordArg) } : {}),
    });
    console.log(
      JSON.stringify({
        status: "recorded",
        record: path.relative(ROOT, recordPath),
        head: record.head,
        recordedAt: record.recordedAt,
        files: record.files,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({ status: "record-failed", ...safeErrorSummary(error) }),
    );
    process.exitCode = 1;
  }
}
