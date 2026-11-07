#!/usr/bin/env node
// 使い方: node make-sha256sums.mjs <dataDir> <resultsDir>
// results/ のファイル（SHA256SUMS 自身を除く）と、data の主な file の sha256 を SHA256SUMS に書く。
import fs from "node:fs";
import path from "node:path";
import { sha256File } from "./lib.mjs";

const [dataDir, dir] = process.argv.slice(2);
if (!dataDir || !dir) { console.error("usage: node make-sha256sums.mjs <dataDir> <resultsDir>"); process.exit(2); }
const walk = (d, base = "") => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name), path.join(base, e.name)) : [path.join(base, e.name)]);
const lines = [];
for (const f of walk(dir).filter((f) => f !== "SHA256SUMS").sort()) lines.push(`${sha256File(path.join(dir, f))}  ${f}`);
const dataFiles = [
  "main-sonnet/answers.jsonl", "main-sonnet/judge.v3.jsonl", "main-sonnet/summary.json", "main-sonnet/summary.pre-verification.json",
  "main-haiku/answers.jsonl", "main-haiku/judge.v3.jsonl", "main-haiku/summary.json",
  "verify-main-sonnet/results.jsonl", "verify-main-sonnet/key.json", "verify-main-sonnet/selection-summary.json", "verify-main-sonnet/materials.json",
  "calibration-judgments.json", "calibration-key.json", "calibration-selection.json", "spend-ledger.jsonl", "freeze-manifest.json",
];
for (const f of dataFiles) lines.push(`${sha256File(path.join(dataDir, f))}  DATA/${f}`);
fs.writeFileSync(path.join(dir, "SHA256SUMS"), lines.join("\n") + "\n");
console.log(lines.length, "entries");
