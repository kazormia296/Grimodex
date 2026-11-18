/**
 * 自分の tmp＋rename の書込み（`<file>.<pid>.<uuid>.tmp`）が、crash・kill で残した tmp の片付け。
 * 対象は「基準の file 名 + `.` + pid + `.` + UUID + `.tmp`」に**完全一致**する通常の file だけで、
 * 同じ directory の他の file（他の module の tmp、基準の file そのもの、directory）には触れない。
 * 書込みは同期で、同じ process の中で tmp を作って rename まで await なしに終えるので、起動時
 * （書込みの前）に呼べば、走行中の書込みを消すことはない（単一 instance lock で、別の process も無い）。
 */
import { lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 基準の file 名に対する、自分の tmp の名前の形。 */
export function ownTemporaryFilePattern(baseFileName: string): RegExp {
  return new RegExp(
    `^${escapeRegExp(baseFileName)}\\.\\d+\\.${UUID_SOURCE}\\.tmp$`,
    "i",
  );
}

/** 残骸を消し、消した件数を返す。directory が無い・読めない・消せないときは投げない。 */
export function removeOwnTemporaryFiles(
  directory: string,
  baseFileName: string,
): number {
  const pattern = ownTemporaryFilePattern(baseFileName);
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const target = path.join(directory, name);
    try {
      if (!lstatSync(target).isFile()) continue;
      rmSync(target, { force: true });
      removed += 1;
    } catch {
      // 消せない残骸は、次の起動で再び試す。
    }
  }
  return removed;
}
