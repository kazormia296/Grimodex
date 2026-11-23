/* global window */
// 測定 A（構造抽出）の駆動（事前登録 §5）。AI は呼ばない（startCodexStructureExtraction は useAi:false）。
// 作品×段ごとに別 process・別 workspace で、名簿を登録（rosterAtLevel → createCodexEntry）し、
// 構造抽出を AI なしで流して live の projection を読む。
//
// 組（作品ごと）：行列 L0／L1／L2／L3／L2-1char（F100）・基準 empty（F100）・決定性 L2（F100）・
// 累積の列 L2 で F25→F50→F75→F100（同じ workspace、決定なし）。単独（--solo-works。既定 m-ja-2）：
// L2 で F25・F50・F75 を新しい workspace で単独に。
//
// 保存の経路：--persist skip（既定。skipNativePersist の seam で live の projection だけ読む）／
// --persist try（保存を試み、失敗したら理由の code だけ記録して skip に落とす。製品の不具合が直ったら使う。PR #888）。
// 保存つきの段（persistAttempt が ok）の後に、保存済みの未 review の提案の件数を DB から件数だけ読む
// （run.storedUnreviewed。事前登録の問い 4。製品の read-only の読み＝list_resumable_runs と get_run_review_bundle）。
// 保存しない段・保存に失敗した段は 0 ではなく「未計測」（status: not-measured と reason）。
//
// 起動例（隔離。unshare -n は使わない）：
//   env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u XDG_SESSION_TYPE -u DBUS_SESSION_BUS_ADDRESS \
//     ELECTRON_OZONE_PLATFORM_HINT=x11 TMPDIR=<out>/tmp dbus-run-session -- \
//     node scripts/local-ci-xvfb.mjs node scripts/quality/identity-review-load/run-measure-a.mjs \
//       --works g-ja-2 [--cells matrix-L2,empty] [--persist skip|try]
//
// 出力（repo 外の 0700／0600）：<out>/measure-a/<cellId>.json（件数だけ）と <cellId>.rows.json（hash の行）。
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ROSTER_LEVELS,
  WORKS,
  assertOutputClean,
  compareStoredWithProjection,
  findAiCommands,
  hashSurface,
  planStoredRead,
  rosterAtLevel,
  safeErrorSummary,
  storedNotMeasured,
  validateRoster,
} from "./lib.mjs";
import {
  buildRosterIndex,
  codexTypeOf,
  computeMeasureA,
} from "./measure-a-metrics.mjs";
import {
  DEFAULT_OUTPUT,
  ensurePrivateDir,
  runCell,
  withVite,
  writeJson0600,
} from "./launcher-common.mjs";
import { resolveWorkSource, sha256Text } from "./sources.mjs";

export const FOLDER_STEPS = Object.freeze([25, 50, 75, 100]);
export const DEFAULT_SOLO_WORKS = Object.freeze(["m-ja-2"]);

/**
 * 実行する cell の一覧（純関数）。cell：{ id, work, kind, level, steps }。
 * level：null は Codex を空にする基準。steps は構造抽出を流す folder の列（同じ workspace で順に）。
 */
export function planCells(
  works,
  { soloWorks = DEFAULT_SOLO_WORKS, only = null } = {},
) {
  const cells = [];
  for (const work of works) {
    for (const level of ROSTER_LEVELS)
      cells.push({
        id: `${work}-matrix-${level}`,
        work,
        kind: "matrix",
        level,
        steps: [100],
      });
    cells.push({
      id: `${work}-empty`,
      work,
      kind: "baseline",
      level: null,
      steps: [100],
    });
    cells.push({
      id: `${work}-determinism-L2`,
      work,
      kind: "determinism",
      level: "L2",
      steps: [100],
    });
    cells.push({
      id: `${work}-cumulative-L2`,
      work,
      kind: "cumulative",
      level: "L2",
      steps: [...FOLDER_STEPS],
    });
    if (soloWorks.includes(work))
      for (const percent of [25, 50, 75])
        cells.push({
          id: `${work}-solo-L2-F${percent}`,
          work,
          kind: "solo",
          level: "L2",
          steps: [percent],
        });
  }
  return only
    ? cells.filter(
        (c) =>
          only.includes(c.id) || only.includes(c.id.slice(c.work.length + 1)),
      )
    : cells;
}

/** 名簿の登録用の実体（rosterAtLevel の型を Codex の型にする）。 */
export function registrationEntries(roster, level) {
  if (level === null) return [];
  return rosterAtLevel(roster, level).map((entity) => ({
    ...entity,
    type: codexTypeOf(entity.type),
  }));
}

/**
 * 候補画面の候補（run-inventory が repo 外に書く ${output}/surfaces/<作品>.json の candidate 配列〔文字列〕）を、host 側で
 * 表記そのままの hash（hashSurface）にする。file が無い・読めない・candidate が配列でない・空のときは null（0 でなく未計測。
 * inventory の候補の取得が失敗すると空の配列が書かれるので、空は「候補が 0 件」と区別できず未計測に倒す）。表記は返さない。
 */
export async function loadCandidateHashes(file, hash = hashSurface) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const list = parsed?.candidate;
  if (!Array.isArray(list) || list.length === 0) return null;
  if (!list.every((item) => typeof item === "string")) return null;
  return [...new Set(await Promise.all(list.map((item) => hash(item))))];
}

/**
 * 候補の file の出所（DR-ILM-41）：absent＝無い・壊れている・空（候補は未計測）／unverified＝照合用の scenesSha256 が無い古い file
 * （使うが、今の scenes と照合できていない）／verified＝inventory が使った scenes と今の scenes が同じ／stale＝食い違う
 * （使わず、候補は未計測）。scenes が読めないときも stale（照合できないものを verified にしない）。
 */
export function candidateFileState(file, scenesFile) {
  if (!existsSync(file)) return "absent";
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return "absent";
  }
  const list = parsed?.candidate;
  if (!Array.isArray(list) || list.length === 0) return "absent";
  if (!list.every((item) => typeof item === "string")) return "absent";
  if (typeof parsed.scenesSha256 !== "string") return "unverified";
  let current;
  try {
    current = sha256Text(readFileSync(scenesFile, "utf8"));
  } catch {
    return "stale";
  }
  return parsed.scenesSha256 === current ? "verified" : "stale";
}

/**
 * 候補の file を出所の照合つきで読む。stale（scenes と食い違う）・absent なら hashes は null（未計測）。unverified は使う。
 */
export async function loadCandidates(file, scenesFile, hash = hashSurface) {
  const state = candidateFileState(file, scenesFile);
  const hashes =
    state === "stale" ? null : await loadCandidateHashes(file, hash);
  return { state, hashes };
}

/** cell の run の完了条件（§8-2）：prepass complete・提案あり・AI なし。 */
export function runCompleted(extract) {
  return (
    extract.observed?.prepass?.status === "complete" &&
    extract.entityProposalCount > 0
  );
}

/**
 * cell の中身。page は window.identityLoad を持つ（試験では fake）。
 * 戻り値：{ runs, registration }。runs[].rows は repo 外の rows file に書く（hash の行）。
 */
export async function measureABody({
  page,
  projectId,
  roster,
  index,
  cell,
  persist = "skip",
  candidateHashes = null,
}) {
  // renderer へ渡す S5-roster の hash（名簿の全体から。水準で削らない）と、そのうち候補画面の候補に出るもの。
  // renderer は件数だけを返す（候補の一覧・seed の集合は host へ戻さない）。候補が未計測なら null。
  const s5Hashes = [...(index.s5Hashes ?? [])].sort();
  const s5Set = new Set(s5Hashes);
  const s5CandidateHashes = candidateHashes
    ? candidateHashes.filter((hash) => s5Set.has(hash))
    : null;
  const entries = registrationEntries(roster, cell.level);
  let registration = { created: 0 };
  if (entries.length > 0)
    registration = await page.evaluate(
      (input) => window.identityLoad.registerRoster(input),
      { projectId, entries },
    );
  assert.equal(
    registration.created,
    entries.length,
    "[artifact] REGISTRATION_COUNT_DIFFERS",
  );
  const runs = [];
  for (const percent of cell.steps) {
    let persisted;
    let persistAttempt = { status: "not-attempted" };
    if (persist === "try") {
      try {
        persisted = await page.evaluate(
          (input) => window.identityLoad.extractStructure(input),
          {
            folderPercent: percent,
            persist: true,
            s5Hashes,
            s5CandidateHashes,
          },
        );
        persistAttempt = { status: "ok" };
      } catch (error) {
        persistAttempt = { status: "failed", ...safeErrorSummary(error) };
      }
    }
    const extract =
      persisted ??
      (await page.evaluate(
        (input) => window.identityLoad.extractStructure(input),
        { folderPercent: percent, persist: false, s5Hashes, s5CandidateHashes },
      ));
    const rows = extract.rows;
    const metrics = computeMeasureA({
      index,
      rows,
      seedDrops: extract.seedDrops ?? null,
      s5Breakdown: extract.s5Breakdown ?? null,
    });
    // 一括承認可の数は、renderer（製品の旗を全行で数えたもの）と metrics（分類の内訳の合計）が同じ run で一致する。
    // 一致しないのは、分類が製品の一括承認の対象を取りこぼしているか、行の旗が欠けている。
    // renderer の数が無い（undefined・非整数）なら、照合できないので止める（黙って飛ばさない。fail-closed）。
    assert.ok(
      Number.isInteger(extract.counts?.bulkApprovable),
      "[artifact] BULK_APPROVABLE_COUNT_MISSING renderer did not report counts.bulkApprovable",
    );
    assert.equal(
      metrics.bulkApprovable.total,
      extract.counts.bulkApprovable,
      `[artifact] BULK_APPROVABLE_COUNT_DIFFERS renderer=${extract.counts.bulkApprovable} metrics=${metrics.bulkApprovable.total}`,
    );
    assert.equal(
      metrics.bulkApprovable.unexpectedBinding +
        metrics.bulkApprovable.outsideBulkCategories,
      0,
      "[artifact] BULK_APPROVABLE_MISCLASSIFIED",
    );
    // 保存済みの未 review の提案の件数（問い 4）。保存つきの段だけ DB から読む（製品の read-only の読み）。
    // 保存しない段・保存に失敗した段は 0 ではなく「未計測」。読みの失敗は cell の採用可否に入れず、理由だけ記録する。
    let storedUnreviewed;
    const plan = planStoredRead(persistAttempt);
    if (!plan.read) storedUnreviewed = plan.result;
    else {
      try {
        const stored = await page.evaluate(() =>
          window.identityLoad.readStoredProposals(),
        );
        storedUnreviewed = {
          ...stored,
          // この段の run の保存済みの件数が、同じ段の projection の件数と合うか（道具の読みの検査）。
          projectionCheck: compareStoredWithProjection(stored, extract),
        };
      } catch (error) {
        storedUnreviewed = storedNotMeasured(
          "read-failed",
          safeErrorSummary(error),
        );
      }
    }
    const summary = { ...extract };
    delete summary.rows;
    runs.push({
      label: `F${percent}`,
      folderPercent: percent,
      persistAttempt,
      storedUnreviewed,
      completed: runCompleted(extract),
      extract: summary,
      metrics,
      rows,
    });
  }
  return {
    runs,
    registration: { created: registration.created, entryCount: entries.length },
  };
}

/** cell の status を決める（run-inventory と同じ順で、採用できないものを落とす）。 */
export function cellStatus(cell, value) {
  const names = cell.ipc?.commandNames ?? [];
  const persistAllowed = value?.runs?.some(
    (r) => r.persistAttempt?.status !== "not-attempted",
  )
    ? ["narrative_extraction_claim_task"]
    : [];
  const ai = findAiCommands(names).filter((n) => !persistAllowed.includes(n));
  if (ai.length > 0) return "ai-detected";
  if (!cell.aiRows?.verified) return "ai-unverified";
  if (Object.values(cell.aiRows.tables ?? {}).some((n) => n !== 0))
    return "ai-detected";
  if ((cell.egress?.nonLoopbackDestinationCount ?? 0) > 0)
    return "egress-detected";
  if ((cell.egress?.sampleCount ?? 0) === 0) return "egress-unverified";
  if (!value?.runs?.every((r) => r.completed)) return "extract-unverified";
  return "ok";
}

function parseArgs(args) {
  const options = {
    works: Object.keys(WORKS).join(","),
    cells: "",
    "solo-works": DEFAULT_SOLO_WORKS.join(","),
    output: DEFAULT_OUTPUT,
    "roster-dir": "",
    "roster-name": "roster-final.json",
    "data-dir": "",
    persist: "skip",
    keep: "false",
  };
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(
      args[i].startsWith("--") && args[i + 1] !== undefined,
      "use --name value arguments",
    );
    options[args[i].slice(2)] = args[i + 1];
  }
  assert.ok(
    ["skip", "try"].includes(options.persist),
    "[precheck] --persist must be skip or try",
  );
  for (const work of options.works.split(","))
    assert.ok(work in WORKS, `[precheck] unknown work ${work}`);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = path.resolve(options.output);
  const rosterDir = options["roster-dir"] || path.join(output, "roster");
  const works = options.works.split(",");
  const only = options.cells ? options.cells.split(",") : null;
  const cells = planCells(works, {
    soloWorks: options["solo-works"].split(",").filter(Boolean),
    only,
  });
  const outDir = path.join(output, "measure-a");
  ensurePrivateDir(outDir);
  const rosters = new Map();
  for (const work of works) {
    const file = path.join(rosterDir, work, options["roster-name"]);
    const roster = JSON.parse(readFileSync(file, "utf8"));
    const check = validateRoster(roster, {});
    assert.ok(
      check.ok,
      `[precheck] ROSTER_INVALID ${work} errors=${check.errors.length}`,
    );
    // 候補画面の候補（作品単位。水準に依らない）。inventory が書いた file が無い・scenes と食い違う（stale）なら null（未計測）。
    const { state: candidateFile, hashes: candidateHashes } =
      await loadCandidates(
        path.join(output, "surfaces", `${work}.json`),
        resolveWorkSource(work, options["data-dir"] || null),
      );
    rosters.set(work, {
      roster,
      index: await buildRosterIndex(roster),
      candidateFile,
      candidateHashes,
    });
  }
  const summary = [];
  await withVite(output, async ({ vite, busAddress }) => {
    for (const cell of cells) {
      const { roster, index, candidateHashes, candidateFile } = rosters.get(
        cell.work,
      );
      const {
        cell: observed,
        value,
        scenesTexts,
      } = await runCell({
        output,
        vite,
        busAddress,
        cellId: `A-${cell.id}`,
        workKey: cell.work,
        dataDir: options["data-dir"],
        keep: options.keep === "true",
        body: (ctx) =>
          measureABody({
            ...ctx,
            roster,
            index,
            cell,
            persist: options.persist,
            candidateHashes,
          }),
      });
      const status =
        observed.status === "failed" ? "failed" : cellStatus(observed, value);
      observed.status = status; // 初期値の "blocked" を最終の採用の可否に書き換える。
      const result = {
        schemaVersion: "identity-load-measure-a/1",
        cell: cell.id,
        kind: cell.kind,
        level: cell.level,
        steps: cell.steps,
        status,
        observed,
        candidateFile,
        registration: value?.registration ?? null,
      };
      let rowsFile = null;
      if (value) {
        result.runs = value.runs.map((run) => {
          const { rows: _rows, ...rest } = run;
          return rest;
        });
        rowsFile = value.runs.map((run) => ({
          label: run.label,
          rows: run.rows,
        }));
      }
      try {
        assertOutputClean(result, scenesTexts);
        if (rowsFile) assertOutputClean(rowsFile, scenesTexts);
        if (status === "ok") {
          writeJson0600(path.join(outDir, `${cell.id}.json`), result);
          writeJson0600(path.join(outDir, `${cell.id}.rows.json`), rowsFile);
        } else {
          writeJson0600(path.join(outDir, `${cell.id}.rejected.json`), {
            cell: cell.id,
            status,
            errors: observed.errors ?? [],
          });
        }
      } catch (error) {
        writeJson0600(path.join(outDir, `${cell.id}.failed.json`), {
          cell: cell.id,
          status: "output-withheld",
          errors: [safeErrorSummary(error)],
        });
      }
      summary.push({ cell: cell.id, status });
      console.log(JSON.stringify(summary.at(-1)));
    }
  });
  if (summary.some((s) => s.status !== "ok")) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    console.log(
      JSON.stringify({ status: "launcher-failed", ...safeErrorSummary(error) }),
    );
    process.exitCode = 1;
  }
}
