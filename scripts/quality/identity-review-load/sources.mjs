// 作品の入力元（scenes JSON）の所在。新しい 3 本は repo 外の測定 dir、m-ja-2 は評価データ
// （読むだけ。変えない）。--data-dir を渡したときは dir/<key>.json（試験用）。
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
