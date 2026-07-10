import { electronBridge, isElectron } from "@/lib/shell";
import { invoke, isTauri } from "@/lib/tauri";
import type { SaveFilter } from "@/lib/exportFile";

/** 読み込んだテキストファイルの中身とファイル名。 */
export interface OpenTextResult {
  /** 拡張子込みのファイル名（ディレクトリは含まない）。 */
  name: string;
  content: string;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 非 Tauri（dev サーバー / テスト）向け: `<input type=file>` で読み込む。 */
function openViaInput(filter: SaveFilter): Promise<OpenTextResult | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = filter.extensions.map((e) => `.${e}`).join(",");
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      void file.text().then((content) => {
        resolve({ name: file.name, content });
      });
    };
    // キャンセル検出は環境依存で不確実なため、ここでは onchange 発火のみ扱う。
    input.click();
  });
}

/**
 * ネイティブのファイル選択ダイアログを開き、選んだ単一テキストファイルを読み込む。
 * 保存（`saveTextFile`）と同じく Rust 主導: ダイアログを開いてその場で読む
 * `import_open_text_file` コマンドを invoke する（renderer に fs:read capability を
 * 与えず、任意パスの silent read を防ぐ。設計は src-tauri/src/commands/import_fs.rs）。
 *
 * キャンセル時 / 非対応環境では null を返す。
 */
export async function openTextFile(
  filter: SaveFilter,
): Promise<OpenTextResult | null> {
  if (isTauri()) {
    const picked = await invoke<OpenTextResult | null>(
      "import_open_text_file",
      { filterName: filter.name, extensions: filter.extensions },
    );
    return picked ?? null;
  }
  if (isElectron()) {
    // main プロセスのネイティブファイルピッカ + fs 読み込み（§3.4）。
    const bridge = electronBridge();
    const picked = await bridge.dialog.openFile({
      name: filter.name,
      extensions: filter.extensions,
    });
    if (typeof picked !== "string") return null;
    const content = await bridge.fs.readTextFile(picked);
    return { name: basename(picked), content };
  }
  return openViaInput(filter);
}
