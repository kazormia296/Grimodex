// 共通の小さな道具。本文は扱わない（件数・率・ID・enum だけ）。
import fs from "node:fs";
import crypto from "node:crypto";

export const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
export const readJsonl = (f) =>
  fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
export const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
export const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + "\n");
export const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 10 ** d) / 10 ** d);

export function wilson(k, n, z = 1.959964) {
  if (n === 0) return { n, successes: k, rate: null, low: null, high: null };
  const p = k / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { n, successes: k, rate: round(p), low: round(Math.max(0, c - h)), high: round(Math.min(1, c + h)) };
}

// 2 値の Cohen の κ。pairs は [a, b] の真偽の配列。
export function kappa(pairs) {
  const n = pairs.length;
  if (!n) return null;
  let a11 = 0, a10 = 0, a01 = 0, a00 = 0;
  for (const [a, b] of pairs) {
    if (a && b) a11++; else if (a && !b) a10++; else if (!a && b) a01++; else a00++;
  }
  const po = (a11 + a00) / n;
  const pa = (a11 + a10) / n, pb = (a11 + a01) / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  return pe === 1 ? null : round((po - pe) / (1 - pe), 4);
}

// 本文らしい文字列の検査。日本語（かな・漢字・全角記号）が minChars 字以上含まれる文字列を列挙する。
// 本文は句読点や英数字で途切れるので、連続ではなく合計で数える。見つかったものは目視で、
// 集計器が出す固定の説明文（note・definition など）かどうかを確かめる。
const JA = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/;
export function longJapaneseStrings(obj, minChars = 20, path = "$", out = []) {
  if (typeof obj === "string") {
    let n = 0;
    for (const ch of obj) if (JA.test(ch)) n++;
    if (n >= minChars) out.push({ path, jaChars: n, length: obj.length });
  } else if (Array.isArray(obj)) obj.forEach((v, i) => longJapaneseStrings(v, minChars, `${path}[${i}]`, out));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) longJapaneseStrings(v, minChars, `${path}.${k}`, out);
  return out;
}
