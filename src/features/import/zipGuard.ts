import type { UnzipFileInfo } from "fflate";

/**
 * ZIP 展開時の zip-bomb / 過大 zip 対策 (security audit PIO-3)。
 *
 * fflate の `unzipSync` は filter を通過した各エントリを `inflateSync(..,
 * { out: new u8(originalSize) })` で展開し、**非圧縮サイズ**分のバッファを
 * inflate 前に一括 alloc する。`originalSize` は central directory が宣言する値で
 * 攻撃者が完全制御できるため、数 KB に圧縮しつつ巨大な非圧縮サイズを宣言した
 * 単一エントリ (zip-bomb) でユーザーがファイルを選んだ瞬間に renderer が
 * 同期 alloc/展開でハング/OOM しうる。
 *
 * 本ガードを `unzipSync(bytes, { filter })` に渡すと、accept されたエントリの
 * **件数** と **非圧縮サイズ合計** に上限を課す。filter が false を返したエントリ
 * は materialize されず alloc にも到達しない。上限超過時は throw して展開を中断
 * する (呼び出し側は通常の import エラーとして表示)。
 */
export const MAX_ZIP_ENTRIES = 50_000;
export const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MiB

/**
 * `unzipSync` の `filter` に渡すガード関数を生成する。
 * @param accept 展開対象とするエントリ名の述語 (省略時は全エントリ対象)。
 *   markdown 取り込みのように拡張子で絞る場合に渡す。reject されたエントリは
 *   件数・サイズの集計対象にもならない。
 */
export function zipBombGuard(
  accept?: (name: string) => boolean,
): (file: UnzipFileInfo) => boolean {
  let count = 0;
  let totalBytes = 0;
  return (file: UnzipFileInfo): boolean => {
    if (accept && !accept(file.name)) return false;
    count += 1;
    if (count > MAX_ZIP_ENTRIES) {
      throw new Error(
        `ZIP 内のファイルが多すぎます (上限 ${MAX_ZIP_ENTRIES} 件)`,
      );
    }
    // size は圧縮後サイズ。alloc 量を bound するため非圧縮の originalSize を使う。
    totalBytes += file.originalSize;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(
        `ZIP の展開後サイズが上限 (${Math.round(
          MAX_ZIP_TOTAL_BYTES / (1024 * 1024),
        )} MiB) を超えています`,
      );
    }
    return true;
  };
}
