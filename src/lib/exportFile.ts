import { isElectron } from "@/lib/shell";
import { invoke, isTauri } from "@/lib/tauri";

/** 保存ダイアログのファイル種別フィルタ。 */
export interface SaveFilter {
  name: string;
  extensions: string[];
}

/**
 * ネイティブ保存ダイアログ経由の export が使えるシェルか
 * （supportsPanelWindows / supportsTrashBin と同作法の実行シェルゲート。
 * Electron 側の実装は electron/main/shellCommands.ts — PIO-2 の
 * 「renderer は保存先パスを渡さない」設計を維持した main プロセス実装）。
 */
function supportsNativeExport(): boolean {
  return isTauri() || isElectron();
}

/** ブラウザ (dev サーバー / テスト) フォールバック: anchor でダウンロードさせる。 */
function downloadBlob(blob: Blob, suggestedName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
}

// String.fromCharCode の引数数上限を避けるため chunk 分割する。
const B64_CHUNK = 0x8000; // 32 KiB

/** Uint8Array を base64 文字列へ。IPC でバイナリを Rust へ渡すための符号化。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    const chunk = bytes.subarray(i, i + B64_CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * テキストをネイティブ保存ダイアログ経由で保存する。**ダイアログは Rust 側で
 * 開かれ、renderer は保存先パスを一切渡さない** (security audit PIO-2; 詳細は
 * `src-tauri/src/commands/export.rs`)。保存できたら絶対パス、ユーザーがキャンセル
 * したら null を返す。
 *
 * 非 Tauri 環境 (dev サーバー / vitest) では browser ダウンロードにフォールバック
 * し、suggestedName を返す。
 */
export async function saveTextFile(
  suggestedName: string,
  filter: SaveFilter,
  contents: string,
  mime = "text/plain",
): Promise<string | null> {
  if (supportsNativeExport()) {
    return invoke<string | null>("export_save_text", {
      suggestedName,
      filterName: filter.name,
      extensions: filter.extensions,
      contents,
    });
  }
  downloadBlob(
    new Blob([contents], { type: `${mime};charset=utf-8` }),
    suggestedName,
  );
  return suggestedName;
}

/**
 * バイナリをネイティブ保存ダイアログ経由で保存する (text 版と同じ Rust 主導の
 * パス決定)。保存できたら絶対パス、キャンセル時は null。非 Tauri では browser
 * ダウンロードにフォールバック。
 */
export async function saveBinaryFile(
  suggestedName: string,
  filter: SaveFilter,
  bytes: Uint8Array,
  mime = "application/octet-stream",
): Promise<string | null> {
  if (supportsNativeExport()) {
    return invoke<string | null>("export_save_bytes", {
      suggestedName,
      filterName: filter.name,
      extensions: filter.extensions,
      contentsBase64: bytesToBase64(bytes),
    });
  }
  downloadBlob(new Blob([bytes as BlobPart], { type: mime }), suggestedName);
  return suggestedName;
}
