/**
 * 用語辞書（表記揺れ辞書）の CSV シリアライズ / パース。
 *
 * 正準フォーマット（`docs/Grimodex_Linter設計書.md` §「CSV インポート /
 * エクスポート」）:
 *
 *     preferred,variants,severity,note,enabled
 *     ウェブ,"web|Web|ウエブ",warning,企画書§3.2,true
 *
 * エクスポートは常にこの正準形（ヘッダ付き・variants は `|` 区切り）で出力する。
 * インポートは「色々なフォーマットがありそう」という現実（textlint-rule-prh
 * からの手作業移行、他ツール由来 CSV、Excel 編集など）を吸収するため寛容に
 * パースする：
 *   - ヘッダ有無どちらでも可（無ければ列位置で解釈）
 *   - 列順は不問（ヘッダ名で対応付け）
 *   - 1 エントリ 1 行でも、1 バリアント 1 行（ロング形式）でも可
 *     — preferred でグループ化して variants を union するため両対応
 *   - variants セル内の区切りは `| ｜ , ， 、 ; ； ／` を許容
 *   - severity / enabled の表記揺れを正規化
 *
 * ここは純粋関数のみ。ファイル I/O・DB・store には一切依存しない。
 */

export type TermSeverity = "warning" | "info";

export interface SerializableTermEntry {
  preferred: string;
  variants: string[];
  severity: TermSeverity;
  note: string | null;
  enabled: boolean;
}

export type ParsedTermEntry = SerializableTermEntry;

export interface CsvParseResult {
  /** グループ化・正規化済みのエントリ（preferred でユニーク）。 */
  entries: ParsedTermEntry[];
  /** スキップした行の人間可読な理由（1 行 1 メッセージ）。 */
  errors: string[];
  /** ヘッダを除いたデータ行数。 */
  rowCount: number;
}

const CANONICAL_HEADER = [
  "preferred",
  "variants",
  "severity",
  "note",
  "enabled",
] as const;

/** variants セル内の許容区切り文字。半角スラッシュ `/` は語中に現れうるので除外。 */
const VARIANT_SPLIT = /[|｜,，、;；／]/;

function csvEscapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * 正準 CSV を生成する。ヘッダ行 + 1 エントリ 1 行、variants は `|` 区切り。
 * 行末は CRLF（Excel / 表計算ソフトとの互換性重視）。
 */
export function serializeTermDictionaryCsv(
  entries: SerializableTermEntry[],
): string {
  const lines: string[] = [CANONICAL_HEADER.join(",")];
  for (const e of entries) {
    const cells = [
      e.preferred,
      e.variants.join("|"),
      e.severity,
      e.note ?? "",
      e.enabled ? "true" : "false",
    ];
    lines.push(cells.map(csvEscapeField).join(","));
  }
  // 末尾に改行を 1 つ付けておく（POSIX テキストファイル慣習）。
  return lines.join("\r\n") + "\r\n";
}

/**
 * RFC 4180 準拠の CSV パーサ。ダブルクォート内のカンマ・改行・エスケープ
 * (`""`) を扱う。CRLF / LF / CR いずれの行末も許容する。空行（フィールド
 * ゼロの完全な空行）はスキップする。
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    // 完全な空行（1 セルで中身が空）は捨てる。
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row);
    }
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // CRLF は \n をまとめて消費、単独 CR も行末扱い。
      pushRow();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // 末尾フィールド / 行を flush（ファイルが改行で終わっていない場合）。
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }
  return rows;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function normalizeSeverity(raw: string): TermSeverity {
  const v = raw.trim().toLowerCase();
  if (v === "info" || v === "情報") return "info";
  // warn / warning / 警告 / 空 / その他はすべて warning に倒す。
  return "warning";
}

function normalizeEnabled(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "") return true; // 既定は有効
  if (
    ["false", "0", "no", "off", "disabled", "無効", "オフ", "×"].includes(v)
  ) {
    return false;
  }
  return true;
}

function splitVariants(cell: string): string[] {
  return cell
    .split(VARIANT_SPLIT)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** ヘッダ行かどうかを、既知列名を含むかで判定する。 */
function detectHeader(first: string[]): Record<string, number> | null {
  const map: Record<string, number> = {};
  let hits = 0;
  first.forEach((cell, idx) => {
    const key = cell.trim().toLowerCase();
    // `variant`（単数・ロング形式ヘッダ）も variants として扱う。
    if (key === "variant" || key === "variants") {
      if (map.variants === undefined) map.variants = idx;
      hits++;
    } else if (
      (CANONICAL_HEADER as readonly string[]).includes(key) &&
      map[key] === undefined
    ) {
      map[key] = idx;
      hits++;
    }
  });
  // 2 列以上が既知列名に一致したらヘッダとみなす。
  return hits >= 2 ? map : null;
}

/**
 * 寛容な用語辞書 CSV パーサ。ヘッダ有無・列順・1 行 1 エントリ / ロング形式の
 * いずれも受け付ける。preferred でグループ化し variants を union するため、
 * 同じ preferred が複数行に散っていても 1 エントリにまとまる。
 */
export function parseTermDictionaryCsv(text: string): CsvParseResult {
  const errors: string[] = [];
  const rows = parseCsvRows(stripBom(text));
  if (rows.length === 0) {
    return { entries: [], errors, rowCount: 0 };
  }

  const header = detectHeader(rows[0]);
  const dataRows = header ? rows.slice(1) : rows;

  // 列インデックス解決。ヘッダがあればヘッダに従い、無ければ位置固定。
  const col = {
    preferred: header?.preferred ?? 0,
    variants: header?.variants ?? 1,
    severity: header?.severity ?? 2,
    note: header?.note ?? 3,
    enabled: header?.enabled ?? 4,
  };

  // preferred → 集約中エントリ。挿入順を保つため Map を使う。
  const byPreferred = new Map<
    string,
    { entry: ParsedTermEntry; seen: Set<string> }
  >();

  dataRows.forEach((cells, idx) => {
    // 行番号はヘッダ分と 1 始まりを補正して人間の見た目に合わせる。
    const lineNo = idx + 1 + (header ? 1 : 0);
    const preferred = (cells[col.preferred] ?? "").trim();
    const variantsCell = cells[col.variants] ?? "";
    const variants = splitVariants(variantsCell);

    if (!preferred) {
      errors.push(`行 ${lineNo}: 推奨表記（preferred）が空のためスキップ`);
      return;
    }
    if (variants.length === 0) {
      errors.push(
        `行 ${lineNo}: 「${preferred}」の許容しない表記（variants）が空のためスキップ`,
      );
      return;
    }

    const severity = normalizeSeverity(cells[col.severity] ?? "");
    const noteRaw = (cells[col.note] ?? "").trim();
    const enabled = normalizeEnabled(cells[col.enabled] ?? "");

    const existing = byPreferred.get(preferred);
    if (existing) {
      // ロング形式 / 重複 preferred: variants を union、他属性は初出を優先。
      for (const v of variants) {
        if (v === preferred) continue;
        if (!existing.seen.has(v)) {
          existing.seen.add(v);
          existing.entry.variants.push(v);
        }
      }
      if (existing.entry.note === null && noteRaw) {
        existing.entry.note = noteRaw;
      }
      return;
    }

    const seen = new Set<string>();
    const cleanVariants: string[] = [];
    for (const v of variants) {
      if (v === preferred) continue; // preferred 自身は variant にしない
      if (seen.has(v)) continue;
      seen.add(v);
      cleanVariants.push(v);
    }
    if (cleanVariants.length === 0) {
      errors.push(
        `行 ${lineNo}: 「${preferred}」の variants が推奨表記と同一のみのためスキップ`,
      );
      return;
    }
    byPreferred.set(preferred, {
      entry: {
        preferred,
        variants: cleanVariants,
        severity,
        note: noteRaw || null,
        enabled,
      },
      seen,
    });
  });

  return {
    entries: [...byPreferred.values()].map((x) => x.entry),
    errors,
    rowCount: dataRows.length,
  };
}
