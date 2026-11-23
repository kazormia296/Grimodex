// 作品の入力元（scenes JSON）の所在。新しい 3 本は repo 外の測定 dir、m-ja-2 は評価データ
// （読むだけ。変えない）。--data-dir を渡したときは dir/<key>.json（試験用）。
import { createHash } from "node:crypto";
import path from "node:path";
import { REVIEWED_WORKS, WORKS } from "./lib.mjs";

export const MEASUREMENT_ROOT = "/home/grimodex/identity-review-load-2026-11";
export const EVAL_SCENES_DIR =
  "/home/grimodex/fusion-eval-data/pd-2026-11/scenes";

export function resolveWorkSource(workKey, dataDir = null) {
  if (!(workKey in WORKS)) throw new RangeError("[precheck] unknown work");
  if (dataDir) return path.join(dataDir, `${workKey}.json`);
  if (REVIEWED_WORKS.includes(workKey))
    return path.join(MEASUREMENT_ROOT, "scenes", `${workKey}.json`);
  return path.join(EVAL_SCENES_DIR, `${workKey}.json`);
}

/** 作品の入力元（scenes JSON）の本文の sha256（16 進）。候補の file が今の scenes から作られたかの照合に使う（DR-ILM-41）。 */
export function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * inventory が書く surfaces file に、使った scenes の sha256 を添える。surfaces は {seed, candidate}（repo 外の 0600 の file）。
 * 測定 A は、この hash が今の scenes の hash と違えば候補を使わない（stale）。
 */
export function surfacesFileWithProvenance(surfaces, scenesSha256) {
  if (
    surfaces === null ||
    typeof surfaces !== "object" ||
    Array.isArray(surfaces)
  )
    throw new TypeError("[artifact] SURFACES_NOT_OBJECT");
  if (!/^[0-9a-f]{64}$/u.test(scenesSha256 ?? ""))
    throw new TypeError("[artifact] SCENES_SHA256_INVALID");
  return { ...surfaces, scenesSha256 };
}
