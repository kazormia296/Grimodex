// 同定の review の負荷の測定用に、AI に書かせた原稿（works/<key>/sections-*.md）を、
// 評価の場面の形式（fusion-slot-pd-scenes/1 と同じ形）に組み立てる。
//
// 入力：<root>/works/<key>/sections-NN.md。各ファイルは「# 章の題」の行と「## S001」の節の見出しの行を持ち、
//       本文は 1 段落を 1 行、段落の間は空行（前の AI 原稿 g-ja-1 と同じ形）。
// 出力：<root>/scenes/<key>.json（0600、dir は 0700）。1 節を 1 場面にする（節は 1,100〜1,600 字で書かせた）。
//       段落の文字列はルビの記法（｜親文字《読み》）を含むまま入れる。写しを作るときに製品の取り込みと同じ変換で
//       ruby node にする（renderer 側）。size はルビを親文字だけにし、空白を除いた字数。
// 標準出力：件数と hash だけ（本文・題・人物名は出さない）。
//
// 使い方：node assemble-works.mjs <root> <key> <expectedSections>
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const RUBY = /｜([^《｜\n]+)《([^》\n]*)》/gu;

export function baseText(text) {
  return text.replace(RUBY, "$1");
}

export function sizeOf(paragraphs) {
  return [...paragraphs.map((p) => baseText(p).replace(/\s/gu, "")).join("")].length;
}

export function parseSections(markdown) {
  const out = [];
  let current = null;
  for (const raw of markdown.split(/\r?\n/u)) {
    const line = raw.trim();
    const head = /^##\s+S(\d+)$/u.exec(line);
    if (head) {
      current = { id: Number(head[1]), paragraphs: [] };
      out.push(current);
      continue;
    }
    if (!current || line === "" || /^#\s/u.test(line)) continue;
    current.paragraphs.push(line);
  }
  return out;
}

export function rubyStats(paragraphs) {
  let pairs = 0;
  let broken = 0;
  for (const p of paragraphs) {
    pairs += (p.match(RUBY) ?? []).length;
    const rest = p.replace(RUBY, "");
    if (/[｜《》]/u.test(rest)) broken += 1;
  }
  return { pairs, broken };
}

function main() {
  const [root, key, expected] = process.argv.slice(2);
  if (!root || !key || !expected) throw new Error("usage: assemble-works.mjs <root> <key> <expectedSections>");
  const dir = path.join(root, "works", key);
  const files = readdirSync(dir).filter((f) => /^sections-\d+\.md$/u.test(f)).sort();
  const sections = files.flatMap((f) => parseSections(readFileSync(path.join(dir, f), "utf8")));
  sections.sort((a, b) => a.id - b.id);
  const n = Number(expected);
  const ids = sections.map((s) => s.id);
  const missing = Array.from({ length: n }, (_, i) => i + 1).filter((id) => !ids.includes(id));
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  const empty = sections.filter((s) => s.paragraphs.length === 0).map((s) => s.id);
  if (missing.length || duplicates.length || empty.length || ids.length !== n) {
    throw new Error(
      `sections incomplete: missing=${missing.length} duplicates=${duplicates.length} empty=${empty.length} count=${ids.length}`,
    );
  }
  const emphasis = sections.filter((s) => s.paragraphs.some((p) => /[*＊_]/u.test(p))).length;
  const ruby = sections.reduce(
    (acc, s) => {
      const r = rubyStats(s.paragraphs);
      return { pairs: acc.pairs + r.pairs, broken: acc.broken + r.broken };
    },
    { pairs: 0, broken: 0 },
  );
  if (ruby.broken > 0) throw new Error(`broken ruby notation in ${ruby.broken} paragraphs`);
  const scenes = sections.map((s, i) => ({ index: i + 1, size: sizeOf(s.paragraphs), paragraphs: s.paragraphs }));
  const sizes = scenes.map((s) => s.size);
  const corpus = JSON.stringify(sections.map((s) => ({ id: s.id, paragraphs: s.paragraphs })));
  const out = {
    schemaVersion: "fusion-slot-pd-scenes/1",
    evidenceScope: "not-cp4-evidence",
    key,
    role: "identity-load-ai-gen",
    language: "ja",
    sourceSha256: createHash("sha256").update(corpus).digest("hex"),
    rulesSha256: null,
    stats: {
      sections: sections.length,
      scenes: scenes.length,
      unit: "chars",
      minSize: Math.min(...sizes),
      maxSize: Math.max(...sizes),
      meanSize: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
      totalSize: sizes.reduce((a, b) => a + b, 0),
      paragraphs: scenes.reduce((a, s) => a + s.paragraphs.length, 0),
      rubyPairs: ruby.pairs,
      sectionsWithEmphasisMarks: emphasis,
    },
    scenes,
  };
  const outDir = path.join(root, "scenes");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const outFile = path.join(outDir, `${key}.json`);
  const serialized = `${JSON.stringify(out)}\n`;
  writeFileSync(outFile, serialized, { mode: 0o600 });
  chmodSync(outFile, 0o600);
  console.log(
    JSON.stringify({
      key,
      files: files.length,
      stats: out.stats,
      sourceSha256: out.sourceSha256,
      fileSha256: createHash("sha256").update(serialized).digest("hex"),
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
