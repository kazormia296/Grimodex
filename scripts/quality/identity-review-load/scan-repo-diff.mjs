// repo に追加する前・PR 本文を書く前の走査（事前登録 §10）。
// git diff（base..HEAD と作業ツリー）の追加行・commit message・追加の file（PR 本文の下書きなど）を、
// (1) 原稿の連続 8 文字（shingle）、(2) 目録の表記（repo 外の surfaces/*.json）、
// (3) 表記の hash（rows.json の surfaceHash）で走査し、件数だけを標準出力に出す。
// 一致した箇所・値は出さない。1 件でもあれば非 0 終了（push・PR の前に必ず通す）。
//
// 使い方: node scripts/quality/identity-review-load/scan-repo-diff.mjs [--base origin/master] [--extra <file>]...
import console from "node:console";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  WORKS,
  buildShingleSet,
  expectedSceneText,
  rubyBaseText,
  scenesFromWork,
} from "./lib.mjs";
import { resolveWorkSource } from "./sources.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_OUTPUT = "/home/grimodex/identity-review-load-2026-11";

/**
 * text を走査して件数だけ返す（一致の中身は返さない）。
 * - shingleHits：非 ASCII を含む原稿の連続 8 文字（失敗の対象）
 * - asciiShingleHits：ASCII だけの 8 文字（"function" など一般語の偶然の一致。参考）
 * - surfaceHits：3 文字以上の表記（失敗の対象）／ shortSurfaceHits：2 文字の表記（一般語との
 *   偶然の一致が多い。参考）
 * - hashHits：表記の hash（失敗の対象）
 */
export function scanText(text, { shingles, surfaces, hashes }) {
  let shingleHits = 0;
  let asciiShingleHits = 0;
  const chars = [...text];
  for (let i = 0; i + 8 <= chars.length; i++) {
    const gram = chars.slice(i, i + 8).join("");
    if (!shingles.has(gram)) continue;
    if (/^[\x20-\x7e]+$/u.test(gram)) asciiShingleHits++;
    else shingleHits++;
  }
  let surfaceHits = 0;
  let shortSurfaceHits = 0;
  for (const surface of surfaces) {
    const length = [...surface].length;
    if (length < 2) continue;
    let from = 0;
    while ((from = text.indexOf(surface, from)) !== -1) {
      if (length === 2) shortSurfaceHits++;
      else surfaceHits++;
      from += surface.length;
    }
  }
  let hashHits = 0;
  for (const match of text.matchAll(/[0-9a-f]{16}/gu)) {
    if (hashes.has(match[0])) hashHits++;
  }
  return {
    shingleHits,
    asciiShingleHits,
    surfaceHits,
    shortSurfaceHits,
    hashHits,
  };
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function addedLines(diff) {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function loadMaterial(output, dataDir) {
  const texts = [];
  for (const key of Object.keys(WORKS)) {
    const file = resolveWorkSource(key, dataDir || null);
    if (!existsSync(file)) continue;
    const work = scenesFromWork(JSON.parse(readFileSync(file, "utf8")));
    texts.push(...work.map((scene) => expectedSceneText(scene.paragraphs)));
    // ルビ記法を親文字だけにした形でも走査する（ルビのある作品は、記法の有無で別の連続になる）。
    texts.push(
      ...work.map((scene) =>
        expectedSceneText(scene.paragraphs.map(rubyBaseText)),
      ),
    );
  }
  const surfaces = new Set();
  const surfaceDir = path.join(output, "surfaces");
  if (existsSync(surfaceDir)) {
    for (const name of readdirSync(surfaceDir)) {
      const data = JSON.parse(
        readFileSync(path.join(surfaceDir, name), "utf8"),
      );
      for (const surface of [...(data.seed ?? []), ...(data.candidate ?? [])])
        if ([...surface].length >= 2) surfaces.add(surface);
    }
  }
  // 名簿（repo 外）の名前・別名も、原稿由来の表記として走査する。
  const rosterRoot = path.join(output, "roster");
  if (existsSync(rosterRoot)) {
    for (const work of readdirSync(rosterRoot)) {
      const dir = path.join(rosterRoot, work);
      for (const name of readdirSync(dir)) {
        if (!/^roster-.*\.json$/u.test(name)) continue;
        try {
          const roster = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
          for (const entity of roster.entities ?? [])
            for (const surface of [
              entity.name,
              ...(entity.aliases ?? []).map((a) => a.surface),
              ...(entity.honorificSurfaces ?? []),
            ])
              if (typeof surface === "string" && [...surface].length >= 2)
                surfaces.add(surface);
        } catch {
          // 読めない名簿は無視（作りかけ）。
        }
      }
    }
  }
  const hashes = new Set();
  for (const dirName of ["inventory", "extract-empty"]) {
    const dir = path.join(output, dirName);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".rows.json")) continue;
      for (const match of readFileSync(path.join(dir, name), "utf8").matchAll(
        /"surfaceHash": "([0-9a-f]{16})"/gu,
      ))
        hashes.add(match[1]);
    }
  }
  return {
    shingles: buildShingleSet(texts),
    surfaces,
    hashes,
    textCount: texts.length,
  };
}

function main(argv) {
  const options = {
    base: "origin/master",
    output: DEFAULT_OUTPUT,
    "data-dir": "",
    extra: [],
  };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].slice(2);
    if (name === "extra") options.extra.push(argv[i + 1]);
    else options[name] = argv[i + 1];
  }
  const material = loadMaterial(
    path.resolve(options.output),
    options["data-dir"],
  );
  const sources = {
    committedDiff: addedLines(
      git(["diff", "--unified=0", `${options.base}...HEAD`]),
    ),
    workingTreeDiff: addedLines(git(["diff", "--unified=0", "HEAD"])),
    commitMessages: git(["log", `${options.base}..HEAD`, "--format=%B"]),
  };
  for (const file of options.extra)
    sources[`extra:${path.basename(file)}`] = readFileSync(file, "utf8");
  const report = {
    manuscriptSceneCount: material.textCount,
    surfaceCount: material.surfaces.size,
    hashCount: material.hashes.size,
    sources: {},
  };
  let total = 0;
  for (const [name, text] of Object.entries(sources)) {
    const counts = scanText(text, material);
    report.sources[name] = { bytes: text.length, ...counts };
    total += counts.shingleHits + counts.surfaceHits + counts.hashHits; // 参考の ascii／短い表記は数えない
  }
  report.totalHits = total;
  console.log(JSON.stringify(report, null, 2));
  if (total > 0 || material.textCount === 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main(process.argv.slice(2));
