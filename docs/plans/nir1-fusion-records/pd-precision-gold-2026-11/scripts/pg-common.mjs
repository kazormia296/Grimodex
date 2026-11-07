// 注釈の道具（表示・AI 注釈）の共通部分。本文を読む関数を含むが、本文を返すだけで書き出さない。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileSha256, sha256Hex } from "./agg-pg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PG_DIR = path.resolve(HERE, "..");
// scripts → pd-precision-gold-2026-11 → nir1-fusion-records → plans → docs → worktree の root
export const REPO_ROOT = path.resolve(HERE, "../../../../..");
export const PROMPT_FILE = path.join(PG_DIR, "annotation-prompt.md");
export const DATA_DIR = "/home/grimodex/fusion-eval-data/pd-2026-11";
export const SCENES_DIR = path.join(DATA_DIR, "scenes");
export const SHEET_DIR = path.join(DATA_DIR, "precision-gold");

/** 本文を repo の内側に置かないための確認（harness の assertOutsideRepo と同じ規則）。 */
export function assertOutsideRepo(file) {
  const relative = path.relative(REPO_ROOT, path.resolve(file));
  assert.ok(
    relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative),
    `[precheck] repo の外を指定する: ${file}`,
  );
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** 作品の scenes（本文を含む）。selection に記録された sha256 と一致することを確かめる。 */
export function loadScenes(scenesDir, selection, work) {
  const file = path.join(scenesDir, `${work}.json`);
  assertOutsideRepo(file);
  const sha = fileSha256(file);
  const expected = selection.sources?.[work]?.scenesFileSha256;
  assert.ok(
    !expected || expected === sha,
    `[precheck] ${work} の scenes の sha256 が selection と違う`,
  );
  const scenes = readJson(file);
  assert.equal(scenes.key, work);
  const byPosition = new Map(scenes.scenes.map((s) => [s.index, s]));
  return { file, sha256: sha, byPosition };
}

/** Scene の本文（段落を空行でつなぐ）。 */
export const sceneText = (scene) => scene.paragraphs.join("\n\n");

// 標識は行全体が標識だけの行（本文中の言及と区別する）。
const between = (text, begin, end) => {
  const offsets = [];
  let at = 0;
  for (const line of text.split("\n")) {
    offsets.push({ line, at });
    at += line.length + 1;
  }
  const find = (marker) => offsets.find((o) => o.line.trim() === marker);
  const a = find(begin);
  const b = find(end);
  assert.ok(a && b && b.at > a.at, `prompt file に ${begin}〜${end} が無い`);
  return text.slice(a.at + a.line.length, b.at).trim();
};

/** prompt file から、設問と類型の文面（表示と AI で共通）と、AI に送る system prompt を取る。 */
export function loadPrompt(file = PROMPT_FILE) {
  const text = fs.readFileSync(file, "utf8");
  return {
    file,
    fileSha256: fileSha256(file),
    criteria: between(text, "<!-- criteria:begin -->", "<!-- criteria:end -->"),
    // 送る system prompt から、criteria の標識の行（HTML コメント）は除く。
    system: between(text, "<!-- system:begin -->", "<!-- system:end -->")
      .split("\n")
      .filter((l) => !/^<!-- criteria:(begin|end) -->$/u.test(l.trim()))
      .join("\n"),
    get systemSha256() {
      return sha256Hex(this.system);
    },
  };
}

/** 作業用の 0〜(n−1) の並び替えの鍵。seed 固定（隠した順序の再現用）。 */
export const mixKey = (seed, ...parts) => sha256Hex([seed, ...parts].join("|"));
export const byMixKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
