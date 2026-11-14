// 同定の review の負荷の測定：名簿づくりの道具の command line。AI は呼ばない。
// 標準出力は件数・ID・path・列名だけ（assertOutputClean で原稿の混入を検査してから出す）。
// 原稿の本文・表記を含む file（chunk・packet・作者向けの表）は repo 外の 0700 dir・0600 file にだけ書く。
//
//   node roster-cli.mjs chunks --work g-ja-2
//   node roster-cli.mjs check --work g-ja-2 --roster <file>
//   node roster-cli.mjs reconcile --work g-ja-2            （roster-A.json と roster-B.json を突き合わせる）
//   node roster-cli.mjs sheet --work g-ja-2 --roster <file> --seed <種>
//   node roster-cli.mjs ingest --work g-ja-2 --roster <file> --responses <file>
//   node roster-cli.mjs finalize-unreviewed --work m-ja-2 --roster <file>
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  REVIEWED_WORKS,
  WORKS,
  assertOutputClean,
  expectedSceneText,
  findCollisions,
  safeErrorSummary,
  scenesFromWork,
  validateRoster,
} from "./lib.mjs";
import { MEASUREMENT_ROOT, resolveWorkSource } from "./sources.mjs";
import {
  assertSheetHidesMarks,
  chunkPair,
  diffRosters,
  finalizeUnreviewed,
  ingestReview,
  renderChunkText,
  renderReviewHtml,
  selectReviewRows,
} from "./roster-tools.mjs";

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = { root: MEASUREMENT_ROOT };
  for (let i = 0; i < rest.length; i += 2) {
    assert.ok(
      rest[i].startsWith("--") && rest[i + 1] !== undefined,
      "[precheck] use --name value arguments",
    );
    options[rest[i].slice(2)] = rest[i + 1];
  }
  assert.ok(options.work in WORKS, "[precheck] unknown work");
  return { command, options };
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
function writePrivate(file, content) {
  ensurePrivateDir(path.dirname(file));
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}
const writePrivateJson = (file, value) =>
  writePrivate(file, JSON.stringify(value, null, 2));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function loadScenes(options) {
  const work = readJson(
    resolveWorkSource(options.work, options["data-dir"] || null),
  );
  const scenes = scenesFromWork(work);
  assert.equal(
    scenes.length,
    WORKS[options.work],
    "[precheck] SCENE_COUNT_DIFFERS",
  );
  return scenes;
}

/** 標準出力に出す前に、原稿の混入を検査する。 */
function printClean(summary, scenes) {
  assertOutputClean(
    summary,
    scenes.map((s) => expectedSceneText(s.paragraphs)),
  );
  console.log(JSON.stringify(summary));
}

export function runCommand(command, options) {
  const scenes = loadScenes(options);
  const workDir = path.join(options.root, "roster", options.work);
  if (command === "chunks") {
    const { A, B, firstCapB } = chunkPair(scenes);
    const summary = { work: options.work, chunks: {}, firstCapB };
    for (const [label, chunks] of [
      ["A", A],
      ["B", B],
    ]) {
      const dir = path.join(workDir, `chunks-${label}`);
      ensurePrivateDir(dir);
      for (const chunk of chunks)
        writePrivate(
          path.join(dir, `chunk-${String(chunk.index).padStart(2, "0")}.txt`),
          renderChunkText(scenes, chunk),
        );
      writePrivateJson(path.join(dir, "index.json"), {
        work: options.work,
        label,
        chunks,
      });
      summary.chunks[label] = chunks.map(
        ({ index, sceneFrom, sceneTo, chars, oversize }) => ({
          index,
          sceneFrom,
          sceneTo,
          chars,
          oversize,
        }),
      );
    }
    return summary;
  }
  if (command === "check") {
    const roster = readJson(options.roster);
    const validation = validateRoster(roster, {
      paragraphCounts: scenes.map((s) => s.paragraphs.length),
    });
    const collisions = findCollisions(roster).map(
      ({ kind, entityIds, declared }) => ({ kind, entityIds, declared }),
    );
    return {
      work: options.work,
      entityCount: roster.entities?.length ?? 0,
      ok: validation.ok,
      errorCount: validation.errors.length,
      errors: validation.errors.slice(0, 100),
      collisionCount: collisions.length,
      collisions,
    };
  }
  if (command === "reconcile") {
    const rosterA = readJson(path.join(workDir, "roster-A.json"));
    const rosterB = readJson(path.join(workDir, "roster-B.json"));
    const counts = scenes.map((s) => s.paragraphs.length);
    for (const roster of [rosterA, rosterB])
      assert.ok(
        validateRoster(roster, { paragraphCounts: counts }).ok,
        "[precheck] ROSTER_INVALID run check first",
      );
    const { packets, summary } = diffRosters(rosterA, rosterB);
    writePrivateJson(path.join(workDir, "packets.json"), {
      work: options.work,
      packets,
    });
    return { ...summary, packets: path.join(workDir, "packets.json") };
  }
  if (command === "sheet") {
    assert.ok(
      REVIEWED_WORKS.includes(options.work),
      "[precheck] WORK_NOT_REVIEWED this work has no author review",
    );
    assert.ok(options.seed, "[precheck] --seed is required");
    const roster = readJson(options.roster);
    assert.ok(
      validateRoster(roster, {
        paragraphCounts: scenes.map((s) => s.paragraphs.length),
      }).ok,
      "[precheck] ROSTER_INVALID",
    );
    const selection = selectReviewRows(roster, { seed: options.seed });
    const sheetId = `sheet-${options.work}`;
    const html = renderReviewHtml({
      roster,
      scenes,
      rows: selection.rows,
      sheetId,
    });
    assertSheetHidesMarks(html, { roster, rows: selection.rows });
    const dir = path.join(workDir, "review");
    writePrivate(path.join(dir, "sheet.html"), html);
    writePrivateJson(path.join(dir, "review-key.json"), {
      schemaVersion: "identity-review-key/1",
      work: options.work,
      sheetId,
      seed: options.seed,
      mode: selection.mode,
      rows: selection.rows,
    });
    return {
      ...selection.summary,
      sheet: path.join(dir, "sheet.html"),
      key: path.join(dir, "review-key.json"),
    };
  }
  if (command === "ingest") {
    const roster = readJson(options.roster);
    const dir = path.join(workDir, "review");
    const key = readJson(options.key ?? path.join(dir, "review-key.json"));
    const responses = readJson(options.responses);
    const {
      roster: finalRoster,
      summary,
      validation,
    } = ingestReview({ roster, key, responses });
    const out = path.join(
      workDir,
      validation.ok ? "roster-final.json" : "roster-final.invalid.json",
    );
    writePrivateJson(out, finalRoster);
    return {
      ...summary,
      validationOk: validation.ok,
      validationErrors: validation.errors.slice(0, 50),
      roster: out,
    };
  }
  if (command === "finalize-unreviewed") {
    const roster = readJson(options.roster);
    const { roster: finalRoster, validation } = finalizeUnreviewed(roster);
    const out = path.join(
      workDir,
      validation.ok ? "roster-final.json" : "roster-final.invalid.json",
    );
    writePrivateJson(out, finalRoster);
    return {
      work: options.work,
      entityCount: finalRoster.entities.length,
      validationOk: validation.ok,
      validationErrors: validation.errors.slice(0, 50),
      roster: out,
    };
  }
  throw new Error("[precheck] UNKNOWN_COMMAND");
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    const summary = runCommand(command, options);
    printClean(summary, loadScenes(options));
    if (summary.ok === false || summary.validationOk === false)
      process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify({ status: "cli-failed", ...safeErrorSummary(error) }),
    );
    process.exitCode = 1;
  }
}
