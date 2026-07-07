import { isTauri } from "@/lib/tauri";
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
 * 保存（`saveTextFile`）が Rust 主導なのと異なり、読込は `@tauri-apps/plugin-dialog`
 * ＋ `@tauri-apps/plugin-fs` を renderer から直接呼ぶ（既存 import フローと同方針）。
 *
 * キャンセル時 / 非対応環境では null を返す。
 */
export async function openTextFile(
  filter: SaveFilter,
): Promise<OpenTextResult | null> {
  if (!isTauri()) {
    return openViaInput(filter);
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: filter.name, extensions: filter.extensions }],
  });
  if (typeof picked !== "string") return null;
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  const content = await readTextFile(picked);
  return { name: basename(picked), content };
}
