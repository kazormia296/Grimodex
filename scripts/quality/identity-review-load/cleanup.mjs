// 後始末の登録（SIGINT・SIGTERM・SIGHUP で、key を含む一時 file・dir を同期的に消す）。
// finally だけでは process が kill されると走らない。隔離 userData に保存した key（safeStorage で暗号化）と
// FIFO の dir は、signal で消えるまで残さない。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const cleanups = new Set();
let installed = false;
const SIGNALS = Object.freeze({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 });

export function runCleanups() {
  for (const fn of [...cleanups]) {
    try {
      fn();
    } catch {
      // 後始末の失敗は、他の後始末を止めない。
    }
  }
  cleanups.clear();
}

function install() {
  if (installed) return;
  installed = true;
  for (const [name, number] of Object.entries(SIGNALS)) {
    process.once(name, () => {
      runCleanups();
      process.exit(128 + number);
    });
  }
}

/** fn（同期）を signal の後始末に登録する。返す関数で登録を外す（通常の後始末の後）。 */
export function registerCleanup(fn) {
  install();
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

/**
 * 前の run が kill されて残した key 関係の一時物（FIFO の dir・B の cell の workRoot）を数える。
 * 残っていれば本測定を始めない（人が確認して消す）。名前だけ返し、中身は読まない。
 */
export function findKeyResidue(output) {
  const found = [];
  const scan = (dir, pattern) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir))
      if (pattern.test(name)) found.push(name);
  };
  scan(output, /^key-fifo-/u);
  scan(path.join(output, "run"), /^B-(?!dry-)/u);
  return found.sort();
}

/**
 * userData の下に、key を含みうる file（製品の ai-keys.json と、その一時 file）が残っているかを数える。
 * 内容は返さない。files＝見つけた数、withEntries＝1 件でも保存された key（service の下の account）を持つか、
 * 読めない・形が違う file の数（保守側に数える）。delete_api_key の後の ai-keys.json は空（{}）になりうるので、
 * 「file が無い」でなく「entry が無い」を見て、userData の削除の後は別に workRoot の不在を確かめる。
 */
export function inspectKeyFiles(dir) {
  const out = { files: 0, withEntries: 0 };
  const walk = (current) => {
    let items;
    try {
      items = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) walk(full);
      else if (/^ai-keys\.json(\..*)?$/u.test(item.name)) {
        out.files++;
        try {
          const store = JSON.parse(readFileSync(full, "utf8"));
          const entries =
            store && typeof store === "object"
              ? Object.values(store).reduce(
                  (n, bucket) =>
                    n +
                    (bucket && typeof bucket === "object"
                      ? Object.keys(bucket).length
                      : 1),
                  0,
                )
              : 1;
          if (entries > 0) out.withEntries++;
        } catch {
          out.withEntries++;
        }
      }
    }
  };
  walk(dir);
  return out;
}
