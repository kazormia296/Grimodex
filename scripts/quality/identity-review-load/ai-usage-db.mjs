// workspace の DB から、ai_usage の行（surface・model・tokens）と ai_audit_events の path_id を
// 読み取り専用で読む（測定 B の要求ごとの token の確認と、終了時の surface の集合の確認）。
// 本文・metadata は読まない。出力は ASCII の識別子と数値だけ。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export function findDbFiles(workspaceDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(db|sqlite|sqlite3)$/u.test(entry.name)) found.push(full);
    }
  };
  if (existsSync(workspaceDir)) walk(workspaceDir);
  return found.sort();
}

function query(file, sql) {
  return execFileSync(
    "sqlite3",
    [
      "-readonly",
      "-nullvalue",
      "NULL",
      "-separator",
      "|",
      `file:${file}?mode=ro`,
      sql,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  )
    .split("\n")
    .filter(Boolean);
}

const toNumber = (text) =>
  text === "NULL" || text === "" ? null : Number(text);

/**
 * ai_usage の全行（作成順）。tokens が NULL の行は null として返す（行なし・null・0 を別の失敗理由にするため）。
 * 読めなかった DB の数も返す（fail-closed の判断は呼び出し側）。
 */
export function readAiUsageRows(workspaceDir) {
  const rows = [];
  let unreadable = 0;
  let readable = 0;
  for (const file of findDbFiles(workspaceDir)) {
    try {
      for (const line of query(
        file,
        "SELECT surface, model, tokens_in, tokens_out FROM ai_usage ORDER BY created_at, rowid",
      )) {
        const [surface, model, tokensIn, tokensOut] = line.split("|");
        rows.push({
          surface,
          model: model === "NULL" ? null : model,
          tokens_in: toNumber(tokensIn),
          tokens_out: toNumber(tokensOut),
        });
      }
      readable++;
    } catch {
      unreadable++;
    }
  }
  return { rows, readable, unreadable };
}

/** ai_audit_events の path_id の集合（distinct）。 */
export function readAuditPathIds(workspaceDir) {
  const ids = new Set();
  let unreadable = 0;
  let readable = 0;
  for (const file of findDbFiles(workspaceDir)) {
    try {
      for (const line of query(
        file,
        "SELECT DISTINCT path_id FROM ai_audit_events",
      ))
        ids.add(line);
      readable++;
    } catch {
      unreadable++;
    }
  }
  return { pathIds: [...ids].sort(), readable, unreadable };
}
