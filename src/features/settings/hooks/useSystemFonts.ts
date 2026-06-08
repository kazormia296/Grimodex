import { useEffect, useState } from "react";
import { invoke } from "@/lib/tauri";

/**
 * システムにインストール済みのフォント family 名を返すフック。
 *
 * Rust の `list_system_fonts` を**セッション中 1 回だけ**呼び、モジュールレベルで
 * キャッシュする（フォント列挙は OS スキャンを伴うため）。失敗時は空配列に
 * フォールバックする（ビルトイン serif/monospace は別途利用可能なので致命ではない）。
 */
let cachedFonts: string[] | null = null;
let inflight: Promise<string[]> | null = null;

function fetchSystemFonts(): Promise<string[]> {
  if (cachedFonts) return Promise.resolve(cachedFonts);
  inflight ??= invoke<string[]>("list_system_fonts")
    .then((list) => {
      cachedFonts = Array.isArray(list) ? list : [];
      return cachedFonts;
    })
    .catch(() => {
      inflight = null; // 失敗は再試行を許す
      return [];
    });
  return inflight;
}

export function useSystemFonts(): string[] {
  const [fonts, setFonts] = useState<string[]>(cachedFonts ?? []);

  useEffect(() => {
    if (cachedFonts) {
      setFonts(cachedFonts);
      return;
    }
    let alive = true;
    void fetchSystemFonts().then((list) => {
      if (alive) setFonts(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  return fonts;
}
