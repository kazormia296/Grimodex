// 同定の review の負荷の測定：名簿づくりの道具の command line。AI は呼ばない。
// 標準出力は件数・ID・path・列名だけ（assertOutputClean で原稿の混入を検査してから出す）。
// 原稿の本文・表記を含む file（chunk・packet・作者向けの表）は repo 外の 0700 dir・0600 file にだけ書く。
//
//   node roster-cli.mjs chunks --work g-ja-2
//   node roster-cli.mjs check --work g-ja-2 --roster <file>
//   node roster-cli.mjs reconcile --work g-ja-2            （roster-A.json と roster-B.json を突き合わせる）
//   node roster-cli.mjs sheet --work g-ja-2 --roster <file> --seed <種>
//   node roster-cli.mjs ingest --work g-ja-2 --roster <file> --responses <file>
//     （作者に渡すのは review-sheet/ だけ。review-key/ は渡さない。root の外の応答 file は
//       review-responses/ に 0600 で取り込み、元の file を消すよう summary で知らせる）
//   node roster-cli.mjs finalize-unreviewed --work m-ja-2 --roster <file>
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  REVIEWED_WORKS,
  WORKS,
  assertOutputClean,
  checkRosterAgainstScenes,
  findCollisions,
  safeErrorSummary,
  scenesFromWork,
  scenesTextsForScan,
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

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * 出力 root の検査：repo の内側なら停止、root が自分の所有で 0700 でなければ停止（無ければ 0700 で作る）。
 * 原稿由来の file を repo 内や他人に読める場所へ書かないための強制。
 */
export function assertSafeRoot(root) {
  // 作る前に、最も近い既存の親の realpath に残りを足して repo の内側かを判定する（拒む場合は何も作らない）。
  const repo = realpathSync(REPO_ROOT);
  let probe = path.resolve(root);
  const rest = [];
  while (!existsSync(probe)) {
    rest.unshift(path.basename(probe));
    probe = path.dirname(probe);
  }
  const planned = path.join(realpathSync(probe), ...rest);
  if (planned === repo || planned.startsWith(`${repo}${path.sep}`))
    throw new Error("[precheck] ROOT_INSIDE_REPO");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const real = realpathSync(root);
  const stat = statSync(real);
  if (stat.uid !== process.getuid?.())
    throw new Error("[precheck] ROOT_NOT_OWNED");
  if ((stat.mode & 0o077) !== 0)
    throw new Error("[precheck] ROOT_MODE_NOT_0700");
  return real;
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
  assertOutputClean(summary, scenesTextsForScan(scenes));
  console.log(JSON.stringify(summary));
}

/**
 * 作者の応答 file を、root 配下の review-responses/ に 0600 で取り込む（root の外の file はコピーし、
 * 元の file は消さずに originalToDelete で知らせる）。root の内側の file は 0600 に直す。
 */
function importResponsesFile(source, workDir, root) {
  assert.ok(source, "[precheck] --responses is required");
  const real = realpathSync(source);
  if (real.startsWith(`${root}${path.sep}`)) {
    const stat = statSync(real);
    const modeFixed = (stat.mode & 0o077) !== 0;
    if (modeFixed) chmodSync(real, 0o600);
    return { file: real, imported: false, modeFixed };
  }
  const destination = path.join(
    workDir,
    "review-responses",
    path.basename(real),
  );
  ensurePrivateDir(path.dirname(destination));
  copyFileSync(real, destination);
  chmodSync(destination, 0o600);
  return {
    file: destination,
    imported: true,
    modeFixed: false,
    originalToDelete: real,
  };
}

/** 名簿が形式の検査と初出場面の検査を通ることを要求する（通らなければ止まる）。 */
function assertRosterOk(roster, scenes) {
  assert.ok(
    validateRoster(roster, {
      paragraphCounts: scenes.map((s) => s.paragraphs.length),
    }).ok,
    "[precheck] ROSTER_INVALID run check first",
  );
  assert.equal(
    checkRosterAgainstScenes(roster, scenes).length,
    0,
    "[precheck] ROSTER_FIRST_SCENE_INVALID run check first",
  );
}

export function runCommand(command, options) {
  const scenes = loadScenes(options);
  const root = assertSafeRoot(options.root);
  const workDir = path.join(root, "roster", options.work);
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
    // 初出場面の機械検査（形式が正しいときだけ。表記は返さず code・ID・件数だけ）。
    const sceneErrors = validation.errors.some(
      (e) => e.code === "ENTITIES_NOT_ARRAY" || e.code === "ROSTER_NOT_OBJECT",
    )
      ? []
      : checkRosterAgainstScenes(roster, scenes);
    return {
      work: options.work,
      entityCount: roster.entities?.length ?? 0,
      ok: validation.ok && sceneErrors.length === 0,
      errorCount: validation.errors.length + sceneErrors.length,
      errors: [...validation.errors, ...sceneErrors].slice(0, 100),
      collisionCount: collisions.length,
      collisions,
    };
  }
  if (command === "reconcile") {
    const rosterA = readJson(path.join(workDir, "roster-A.json"));
    const rosterB = readJson(path.join(workDir, "roster-B.json"));
    for (const roster of [rosterA, rosterB]) assertRosterOk(roster, scenes);
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
    assertRosterOk(roster, scenes);
    const selection = selectReviewRows(roster, { seed: options.seed });
    const sheetId = `sheet-${options.work}`;
    const html = renderReviewHtml({
      roster,
      scenes,
      rows: selection.rows,
      sheetId,
    });
    assertSheetHidesMarks(html, { roster, rows: selection.rows });
    // 作者に渡すのは review-sheet/ だけ。層・一致の印を持つ key は別の dir（review-key/）に置く。
    const sheetDir = path.join(workDir, "review-sheet");
    const keyDir = path.join(workDir, "review-key");
    writePrivate(path.join(sheetDir, "sheet.html"), html);
    writePrivateJson(path.join(keyDir, "review-key.json"), {
      schemaVersion: "identity-review-key/1",
      work: options.work,
      sheetId,
      seed: options.seed,
      mode: selection.mode,
      rows: selection.rows,
    });
    return {
      ...selection.summary,
      sheet: path.join(sheetDir, "sheet.html"),
      key: path.join(keyDir, "review-key.json"),
    };
  }
  if (command === "ingest") {
    const roster = readJson(options.roster);
    const key = readJson(
      options.key ?? path.join(workDir, "review-key", "review-key.json"),
    );
    const imported = importResponsesFile(options.responses, workDir, root);
    const responses = readJson(imported.file);
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
      responsesFile: imported.file,
      responsesImported: imported.imported,
      // 元の file が root の外にある（ダウンロード先など）。取り込んだ後は利用者が消す。
      ...(imported.originalToDelete
        ? { originalToDelete: imported.originalToDelete }
        : {}),
      ...(imported.modeFixed ? { responsesModeFixed: true } : {}),
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
