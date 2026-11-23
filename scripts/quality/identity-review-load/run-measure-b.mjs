/* global window */
// 測定 B（候補画面の AI 判定）の駆動（事前登録 §6・§9）。
//
// モード：
//   --mode dry-run  乾いた実行。送信の直前まで進め（候補・visible・entries を作り、要求の本文を製品と同じ式で
//                   組んで文字数から token を見積もる）、作品×段ごとの要求数と見積りの費用だけを出す。
//                   key・要求は一切しない（main の入口で AI の外向きの命令を拒否する層〔dispatch-block.mjs〕を入れて動かす）。
//                   名簿が無いので、空の名簿と合成の名簿（候補の表記から作る）で行う。最後に探針（page の bProbeJudge）で、
//                   送信の直前の経路が測定ページで最後まで通るかを、AI の設定（provider・model。key なし）だけを入れて調べる。
//   --mode trial|b1|b2  本測定（Anthropic へ送る）。--confirm-send yes-send-to-anthropic が無ければ始めない。
//                   この作業（道具づくり）では実行しない。
//
// 本測定は外側の script（launch-measure-b.mjs）から起動する。外側の script が本物の session の env を控え、隔離した
// launcher（dbus-run-session・local-ci-xvfb・TMPDIR）へ FIFO で 1 回渡す（--real-env-fifo。key の復号の helper にだけ使う。§17.6）。
// 隔離は run-measure-a.mjs と同じ（dbus-run-session・local-ci-xvfb・TMPDIR）。出力は件数・ID・path だけ
// （repo 外の 0700／0600）。偽 AI の env（GRIMODEX_PRODUCT_JOURNEY*）は node・main のどちらにも立てない
// （launcher-common の assertNoFakeAiEnv。試験では使ってよいが本測定の経路とは分ける）。
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import {
  ROSTER_LEVELS,
  WORKS,
  assertOutputClean,
  candidateKey,
  findAiCommands,
  hashSurface,
  rosterAtLevel,
  safeErrorSummary,
  validateRoster,
} from "./lib.mjs";
import { readAiUsageRows, readAuditPathIds } from "./ai-usage-db.mjs";
import {
  BudgetStop,
  createGate,
  readModelPricing,
  STAGE_CAPS_USD,
  TOTAL_CAP_USD,
} from "./ledger.mjs";
import { buildRosterIndex, codexTypeOf } from "./measure-a-metrics.mjs";
import {
  buildDryRunPlan,
  buildProjectedPlan,
  checkOnlyCodexJudgment,
  checkUsageCoversSuccesses,
  assertRoleOverridesDefault,
  assertRosterNotHidden,
  B_METRIC_DEFINITION_VERSION,
  dryMeasure,
  evaluateSendPreconditions,
  remainingRequestsAfterCell,
  runB1,
  runB2,
  truncateRosterForB,
} from "./measure-b-core.mjs";
import { assertBuildProvenance } from "./build-provenance.mjs";
import { DISPATCH_BLOCK_EXEMPT } from "./dispatch-block.mjs";
import { buildEgressPolicy, splitList } from "./egress-policy.mjs";
import {
  DEFAULT_OUTPUT,
  ROOT,
  assertNoFakeAiEnv,
  assertNoOverlappingJobs,
  ensurePrivateDir,
  evaluateMain,
  runCell,
  withVite,
  withWatchdog,
  writeJson0600,
} from "./launcher-common.mjs";
// 期限つきの待ち（定義は launcher-common.mjs。cell の app.close の期限と共用。試験はここから import する）。
export { withWatchdog };
import { findKeyResidue } from "./cleanup.mjs";
import { assertRealBusEnv, receiveRealEnv } from "./real-env.mjs";
import {
  hashKeyStore,
  installKey,
  makeKeyGetter,
  removeKey,
} from "./key-supply.mjs";

export const MODEL = "claude-sonnet-5-5";
export const PROVIDER = "anthropic";
export const CONFIRM_SEND = "yes-send-to-anthropic";
export const B1_LEVELS = Object.freeze(["L0", "L1", "L2", "L3"]);
/**
 * 乾いた実行の合成の名簿：空の名簿の候補数 N0 に対する割合で、実体数と段ごとの別名の累計を決める
 * （候補の表記から作る。名簿の無い今、候補が名簿に吸われる影響と Entry の内訳の測定にだけ使う）。
 */
export const DEFAULT_SYNTH = Object.freeze({
  entityFraction: 0.3,
  aliasFractions: Object.freeze({ L0: 0, L1: 0.1, L2: 0.2, L3: 0.3 }),
});
/** 名簿の規模の仮定（上限側の外挿。本物の名簿の実体数・別名数はまだ無い）。 */
export const PROJECTION_SCENARIOS = Object.freeze({
  entities100: {
    entities: 100,
    aliasesPerEntityByLevel: { L0: 0, L1: 1, L2: 2, L3: 4 },
  },
  entities200: {
    entities: 200,
    aliasesPerEntityByLevel: { L0: 0, L1: 1, L2: 2, L3: 4 },
  },
});
/** 本測定で許す AI の command。それ以外の AI 経路を検知したら cell を採用しない。 */
export const ALLOWED_REAL_AI_COMMANDS = Object.freeze([
  "get_ai_settings",
  "save_ai_settings",
  "send_chat_message",
  // 製品の AI 送信が、begin・dispatched・終端の事象を局所の監査の DB に書く命令（外へ出ない）。試走の 1 回目の調べで、
  // 許可の一覧に無かったと分かった（本測定の cell が unexpected-ai-command で不採用になるはずだった）。
  "ai_audit_append_batch",
]);

/**
 * 1 要求（page の bJudge）を待つ上限（ms）。send_chat_message には caller の timeout が無く（src/lib/tauri.ts）、止まると
 * key が disk にあるまま待ち続けるので、道具の側で切る。IPC の AI 用の上限（electron/shared/ipcCallerTimeouts.ts の
 * AI_IPC_TIMEOUT_MS＝5 分）に合わせる（試験が値の一致を確かめる）。
 */
export const JUDGE_WATCHDOG_MS = 300_000;
/** key を消す呼び出し（page の bDeleteKey）を待つ上限（ms）。超えたら諦めて cell の後始末（workRoot の削除と key の残りの検査）へ進む。 */
export const KEY_REMOVAL_TIMEOUT_MS = 60_000;

/** 本測定に進んでよいか（明示の許可が無ければ始めない）。 */
export function assertSendAllowed(options) {
  assert.ok(
    ["trial", "b1", "b2"].includes(options.mode),
    "[precheck] SEND_MODE only trial, b1 and b2 send",
  );
  assert.equal(
    options["confirm-send"],
    CONFIRM_SEND,
    "[precheck] SEND_NOT_CONFIRMED real mode needs --confirm-send yes-send-to-anthropic",
  );
}

/**
 * 隔離した profile の safeStorage の backend の条件（事前登録 §17.6。本測定の前、cell ごと）。
 * 測定の Electron は隔離した bus で動くので backend は basic_text になる。作者の決定により、次の条件を満たすときに限り
 * basic_text を認める（満たさなければ止める）：userData が自分の所有の 0700 で、launcher の一時 root（<output>/run）の下にあり、
 * cell の終わりに消されること（--keep true でないこと）。backend が unknown・空なら（判定できないので）止める。
 * basic_text のときは、製品の拒否を通す上書き（electron-observer-b.mjs）が有効であることも要る。
 * 返り値は records に残す（backend の名前と条件の充足。パス・値は含めない）。
 */
export function assertSafeStorageCondition({
  backend,
  overridden = false,
  userData,
  runRoot,
  keep = false,
}) {
  const name = String(backend).replace(/[^A-Za-z0-9_]/gu, "_");
  assert.ok(
    typeof backend === "string" && !["unknown", ""].includes(backend),
    `[precheck] SAFE_STORAGE_BACKEND backend=${name}`,
  );
  const fail = (code) =>
    assert.fail(`[precheck] SAFE_STORAGE_CONDITION ${code} backend=${name}`);
  if (keep !== false) fail("KEEP_FORBIDDEN");
  let rel = "..";
  try {
    for (const dir of [userData, path.dirname(userData)]) {
      const info = statSync(dir);
      if (
        !info.isDirectory() ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0
      )
        fail("USERDATA_MODE");
    }
    rel = path.relative(realpathSync(runRoot), realpathSync(userData));
  } catch (error) {
    if (error?.message?.includes("SAFE_STORAGE_CONDITION")) throw error;
    fail("USERDATA_NOT_FOUND");
  }
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
    fail("USERDATA_ROOT");
  if (backend === "basic_text" && overridden !== true)
    fail("PLAIN_TEXT_OVERRIDE_INACTIVE");
  return {
    backend: name,
    plainTextAllowed: backend === "basic_text",
    userDataPrivate: true,
    underRunRoot: true,
    deletedAtCellEnd: true,
  };
}

/**
 * page に束縛した api（measure-b-core が使う層）。ai_usage は DB から読む（fail-closed）。
 * allowSend が false（乾いた実行）の api は judge・apply を持たない（送信の関数を渡さないので、
 * dry の経路から呼ばれても TypeError で止まり、送信にならない）。
 */
export function bindPageApi({
  page,
  workspaceDir,
  readUsage = readAiUsageRows,
  sleep,
  allowSend = true,
  beforeSend = null,
  judgeWatchdogMs = JUDGE_WATCHDOG_MS,
  timers = {},
}) {
  const rows = () => {
    const r = readUsage(workspaceDir);
    if (r.readable === 0)
      throw new Error(
        "[artifact] USAGE_DB_UNREADABLE no readable database for ai_usage",
      );
    return r.rows;
  };
  const base = {
    gate: () => page.evaluate(() => window.identityLoad.bAiGate()),
    prepare: (arg) =>
      page.evaluate((a) => window.identityLoad.bPrepare(a), arg),
    estimate: () => page.evaluate(() => window.identityLoad.bEstimate()),
    usageRowCount: async () => rows().length,
    usageRowsSince: async (n) => rows().slice(n),
    sleep: sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  if (!allowSend) return base;
  return {
    ...base,
    // 送信の直前の guard（宛先・役割の上書き・名簿の hidden。F2）。投げれば要求は出ない。
    // page の bJudge が judgeWatchdogMs を超えて返らなければ、届いたか分からない失敗（watchdog-timeout）として返す
    // （台帳が最大の見積りで課金し、停止線を立てる。cell は key の後始末へ進む。F3a の m2）。
    judge: async () => {
      if (beforeSend) await beforeSend();
      const started = Date.now();
      return withWatchdog(
        page.evaluate(() => window.identityLoad.bJudge()),
        judgeWatchdogMs,
        () => ({
          ok: false,
          kind: "watchdog-timeout",
          httpStatus: null,
          durationMs: Date.now() - started,
        }),
        timers,
      );
    },
    apply: (decisions) =>
      page.evaluate(
        (d) => window.identityLoad.bApply({ decisions: d }),
        decisions,
      ),
  };
}

/** 名簿の実体を、registeredKeyHashesOf の形（name と aliases の文字列）にする。 */
function entryNamesOf(entity) {
  return {
    name: entity.name,
    aliases: (entity.aliases ?? []).map((a) =>
      typeof a === "string" ? a : a.surface,
    ),
  };
}

/** 登録した表記の hash（名前・別名。候補に出ない既存名の数え方に使う）。 */
export async function registeredKeyHashesOf(entries) {
  const out = [];
  for (const entry of entries) {
    out.push(await hashSurface(candidateKey(entry.name)));
    for (const alias of entry.aliases ?? [])
      out.push(await hashSurface(candidateKey(alias)));
  }
  return out;
}

/** 乾いた実行の summary の前提の文（出力の混入検査を通る ASCII の識別子の形に限る。試験が検査する）。 */
export const DRY_RUN_ASSUMPTIONS = Object.freeze({
  tokenEstimate:
    "ascii 0.3 token per char and non-ascii 1.0 token per char as a provisional ratio without a tokenizer. It is not called conservative until the trial measured tokens_in including ids calibrates it",
  entryOrderAndIds:
    "entries are in database order while the product screen uses store order newest first. ids are short rt- or synth- strings while the product uses UUIDs so an id heavy prompt is under estimated here. The window is the same when entries are at most 200",
  outputEstimate: "120 token per judged candidate with a floor of 800",
  b2Requests:
    "ceil of initial N over 50 at L2 and each request sized like the first",
  trialRequests: "3 requests sized like the largest B1 request",
  roster:
    "empty and synthetic small rosters built from the candidate list for sizing only",
  projection:
    "candidate part from the empty roster as an upper bound and entry part scaled from the synthetic per entity and per alias cost",
});

// ---- 乾いた実行 -----------------------------------------------------------------

/**
 * 1 作品の乾いた実行：空の名簿→合成の名簿の段ごとに、送信の直前まで進めて件数を測る。
 * 送らない（api.judge は呼ばない）。page は window.identityLoad を持つ（試験では fake）。
 */
export async function dryCellBody(args) {
  // 本体のどの段で落ちたかを、定型の token だけで残す（試走の 1 回目の調べでは、plain な Error だけでは段を特定できなかった）。
  // [precheck]／[artifact] の印のある失敗（意図した検査の失敗）は、そのまま通す。
  const stage = { name: "setup" };
  try {
    return await dryCellBodyStages(args, stage);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/\[(precheck|artifact)\]/u.test(message)) throw error;
    const name = (error instanceof Error ? error.name : "NonError")
      .toUpperCase()
      .replace(/[^A-Z0-9]/gu, "_")
      .slice(0, 40);
    throw new Error(
      `[artifact] DRY_BODY_FAILED_AT_${stage.name.toUpperCase().replace(/[^A-Z0-9]/gu, "_")} ERR_${name}`,
      { cause: error },
    );
  }
}

async function dryCellBodyStages(
  {
    page,
    app = null,
    workspaceDir = "",
    probeJudge = false,
    synth = DEFAULT_SYNTH,
    levels = B1_LEVELS,
  },
  stage,
) {
  const api = bindPageApi({
    page,
    workspaceDir: "unused",
    readUsage: () => ({ rows: [], readable: 1 }),
    allowSend: false,
  });
  const out = [];
  stage.name = "measure-empty";
  const empty = await dryMeasure({ api });
  out.push({ level: "empty", ...empty });
  const n0 = empty.candidates.visibleCount;
  const entityCount = Math.max(1, Math.floor(synth.entityFraction * n0));
  const aliasTotals = {};
  for (const level of levels) {
    stage.name = `synth-roster-${level}`;
    aliasTotals[level] = Math.floor(synth.aliasFractions[level] * n0);
    await page.evaluate((input) => window.identityLoad.bSynthRoster(input), {
      entityCount,
      aliasTotal: aliasTotals[level],
    });
    stage.name = `measure-${level}`;
    out.push({ level, ...(await dryMeasure({ api })) });
  }
  // 送らずに、本測定の guard（役割の上書き・名簿の hidden。F2）を合成の名簿に対して読み取りだけで確かめる。
  // 本測定の cell の頭と同じ page 関数を呼ぶので、課金の前に、設定・DB の読みが測定ページで動くかが分かる。
  stage.name = "guards";
  const role = assertRoleOverridesDefault(
    await page.evaluate(() => window.identityLoad.bAssertRoleDefaults()),
  );
  const hidden = assertRosterNotHidden(
    await page.evaluate(() => window.identityLoad.bAssertRosterNotHidden()),
  );
  stage.name = "probe";
  const judgePath = probeJudge
    ? await probeJudgePath({ page, app, workspaceDir })
    : null;
  // B2 が使う bApply は、実機で一度も動かしていなかった（乾いた実行も試走も呼ばない）。送信なしで、合成の名簿に決定を当てて確かめる。
  stage.name = "apply-rehearsal";
  const applyRehearsal = probeJudge ? await rehearseApply({ page }) : null;
  return {
    levels: out,
    synthetic: { entityCount, aliasTotals, candidateCountN0: n0 },
    preconditions: { role, hidden },
    ...(judgePath ? { judgePath } : {}),
    ...(applyRehearsal ? { applyRehearsal } : {}),
  };
}

/** リハーサルで別名を足す先の Entry（bSynthRoster が作る合成の名簿の 1 件目。乾いた実行の段で必ず在る）。 */
export const APPLY_REHEARSAL_TARGET_ID = "synth-001";

/**
 * bApply のリハーサル（送信なし。B2 が頼る反映の経路）：呼び名でない候補を 2 件選び、1 件を却下・1 件を合成の Entry への別名として
 * 当て、反映の件数と、候補が減ること（B2 の「進んだか」の判定と同じ）を確かめる。却下は設定の保存（saveDismissedCandidateKeys）、
 * 別名は Codex の更新（updateCodexEntry）を通る。**失敗は例外にせず**、ok:false と定型の要約で返す（乾いた実行の他の結果を残す）。
 * 返すのは件数と真偽だけ（候補の表記・hash は載せない）。
 */
export async function rehearseApply({ page }) {
  try {
    const before = await page.evaluate(() =>
      window.identityLoad.bPrepare({ rescan: false }),
    );
    const usable = (before.candidates ?? []).filter(
      (candidate) => candidate.relationalTerm !== true,
    );
    if (usable.length < 2)
      return {
        ok: false,
        reason: "too-few-candidates",
        visibleBefore: before.visibleCount,
        usableCount: usable.length,
      };
    const decisions = [
      { keyHash: usable[0].keyHash, action: "dismiss" },
      {
        keyHash: usable[1].keyHash,
        action: "alias",
        targetId: APPLY_REHEARSAL_TARGET_ID,
      },
    ];
    const applied = await page.evaluate(
      (input) => window.identityLoad.bApply({ decisions: input }),
      decisions,
    );
    const counts = applied.counts ?? {};
    const drop = before.visibleCount - applied.visibleCount;
    const expected =
      counts.dismiss === 1 &&
      counts.alias === 1 &&
      counts.accept === 0 &&
      counts.missing === 0;
    return {
      ok: expected && drop >= 2,
      reason: expected ? (drop >= 2 ? "ok" : "no-progress") : "counts-differ",
      requested: decisions.length,
      counts: {
        accept: counts.accept ?? null,
        alias: counts.alias ?? null,
        dismiss: counts.dismiss ?? null,
        missing: counts.missing ?? null,
      },
      visibleBefore: before.visibleCount,
      visibleAfter: applied.visibleCount,
      drop,
    };
  } catch (error) {
    return { ok: false, reason: "threw", diag: safeErrorSummary(error) };
  }
}

/**
 * 乾いた実行の cell の最終の status：cell の採否（dryCellStatus）が ok でも、bApply のリハーサルが通らなければ不採用にする
 * （リハーサルがあった cell だけ。無い cell は従来どおり）。
 */
export function finalDryStatus({ cellStatus, value }) {
  if (cellStatus !== "ok") return cellStatus;
  if (value?.applyRehearsal && value.applyRehearsal.ok !== true)
    return "apply-rehearsal-failed";
  return "ok";
}

/**
 * 探針：送信の直前の経路（製品の judgeCandidates）が測定ページで最後まで通るかを、外へ出さずに調べる。
 * 外へ出ない保証は、main の入口で AI の外向きの命令を拒否する層（dispatch-block.mjs）が有効なこと（無ければ止まる）と、
 * page の bProbeJudge が key の無いことを確かめて始めること。AI の設定（provider・model）は入れるが key は入れない。
 * 返すのは真偽・件数・定型の要約・命令の名前の並びだけ（自由文なし）。
 */
export async function probeJudgePath({ page, app, workspaceDir = "" }) {
  assert.ok(
    app !== null && typeof app.evaluate === "function",
    "[precheck] PROBE_NEEDS_APP the probe needs the Electron app to verify the dispatch block",
  );
  const active = await evaluateMain(app, 
    () => globalThis.idlDispatchBlock?.active === true,
  );
  assert.equal(
    active,
    true,
    "[precheck] DISPATCH_BLOCK_NOT_ACTIVE the probe does not run without the dispatch block",
  );
  const configured = await page.evaluate(
    (input) => window.identityLoad.bConfigureAi(input),
    { provider: PROVIDER, model: MODEL, key: null },
  );
  assert.equal(
    configured.keyPresent,
    false,
    "[precheck] PROBE_KEY_PRESENT the probe runs only without a key",
  );
  const probe = await page.evaluate(() => window.identityLoad.bProbeJudge());
  // 探針の後に、止めた命令・リハーサルで答えた件数・命令の並び（最後の 12 件）を main から読む。
  const after = await evaluateMain(app, () => ({
    blocked: { ...(globalThis.idlDispatchBlock?.blocked ?? {}) },
    rehearsed: globalThis.idlDispatchBlock?.rehearsed ?? 0,
    tail: (globalThis.nir1IpcTrace?.calls ?? []).slice(-12).map((call) => ({
      command: call.command,
      ok: call.completed === true && call.ok === true,
    })),
  }));
  // リハーサルの応答に対し、製品の経路が局所の DB に残した行（本測定の cell が終わりに読むものと同じ関数）を読む。
  // usage の記録は送信の後に非同期で書かれるので、リハーサルの件数に届くまで少し待つ。
  let surfaces = null;
  if (workspaceDir) {
    let usage = readAiUsageRows(workspaceDir);
    for (let i = 0; i < 20 && usage.rows.length < after.rehearsed; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      usage = readAiUsageRows(workspaceDir);
    }
    const audit = readAuditPathIds(workspaceDir);
    surfaces = {
      readable: usage.readable > 0 && audit.readable > 0,
      usageRows: usage.rows.length,
      usageTokens: usage.rows.map((row) => ({
        in: row.tokens_in,
        out: row.tokens_out,
      })),
      auditPathIds: audit.pathIds,
      surfaceCheck: checkOnlyCodexJudgment({
        usageSurfaces: usage.rows.map((row) => row.surface),
        auditPathIds: audit.pathIds,
        requestsSent: after.rehearsed,
      }),
    };
  }
  return {
    ...probe,
    configured: { provider: configured.provider },
    ...after,
    surfaces,
  };
}

/** 乾いた実行の cell の採用条件：AI の command・AI の行・要求の送信が 0。 */
export function dryCellStatus(cell) {
  const names = cell.ipc?.commandNames ?? [];
  // 探針つきの cell（拒否する層が有効だった cell。cell.dispatchBlock がある）だけ、次を許す：
  //   - 局所の AI の命令（設定の読み書き・監査の DB への追記。DISPATCH_BLOCK_EXEMPT。外向きでない）
  //   - 監査の行（送信の直前の経路が、begin・dispatched・終端の事象を局所の DB に書く）
  //   - ai_usage の行は、main がリハーサルの応答で答えた件数まで（製品が応答の token を記録する。超える行は許さない）
  // 外向きの命令は main の入口で止まり、本物の handler に届かないので、ipc に出る send_chat_message は 0 のまま。
  const probed = cell.dispatchBlock !== undefined;
  const allowedAi = probed ? DISPATCH_BLOCK_EXEMPT : [];
  const rehearsed = probed ? (cell.dispatchBlock.rehearsed ?? 0) : 0;
  if (
    findAiCommands(names).filter((name) => !allowedAi.includes(name)).length >
      0 ||
    (cell.ipc?.commandCounts?.send_chat_message ?? 0) > 0
  )
    return "ai-detected";
  if (!cell.aiRows?.verified) return "ai-unverified";
  for (const [table, n] of Object.entries(cell.aiRows.tables ?? {})) {
    if (probed && table === "ai_audit_events") continue;
    if (probed && table === "ai_usage" && n <= rehearsed) continue;
    if (n !== 0) return "ai-detected";
  }
  if ((cell.egress?.nonLoopbackDestinationCount ?? 0) > 0)
    return "egress-detected";
  // 標本が成り立たない・socket を 1 つも見ていない標本は、何も見ていないのと同じ（実測定の realCellStatus と同じ基準。
  // 乾いた実行が、本測定の観測の無料の事前確認になる。F3a の B1）。
  if (
    (cell.egress?.sampleCount ?? 0) === 0 ||
    (cell.egress?.socketCountMax ?? 0) === 0 ||
    (cell.egress?.tcpSocketCountMax ?? 0) === 0
  )
    return "egress-unverified";
  return "ok";
}

// ---- 本測定の cell ----------------------------------------------------------------

/**
 * 本測定の cell の中身（送信する）。key は installKey で入れ、終わりに必ず消す。
 * mode：trial（B1 を 1 要求）／b1（3 回）／b2（L2 の模擬作者）。
 */
export async function measureBBody({
  page,
  app,
  projectId,
  workspaceDir,
  roster,
  level,
  mode,
  gate,
  key,
  getKey,
  remainingAfter = 0,
  expectedSafeStorageCheck = true,
  usagePoll,
  userData,
  runRoot,
  keep = false,
  egressObservation,
  judgeWatchdogMs = JUDGE_WATCHDOG_MS,
  keyRemovalTimeoutMs = KEY_REMOVAL_TIMEOUT_MS,
  timers = {},
}) {
  // 宛先の観測の関数は必須（無ければ送らない。fail-closed）。返り値は createEgressSampler の observation()：
  // 違反が無いだけでなく、観測が成り立っている証拠（成功した標本・直近の tick・socket の数・古さ）も要る（F3a の B1）。
  assert.equal(
    typeof egressObservation,
    "function",
    "[precheck] EGRESS_GUARD_MISSING measureBBody needs the egress observation",
  );
  const { roster: used, cut, cutEntities } = truncateRosterForB(roster);
  const index = await buildRosterIndex(used);
  // 切った実体の表記（名前・別名）の hash。未登録（unlisted）と分けて数える。
  index.cutKeys = new Set(
    (await registeredKeyHashesOf(cutEntities.map(entryNamesOf))).filter(
      Boolean,
    ),
  );
  const entries = rosterAtLevel(used, level).map((entity) => ({
    ...entity,
    type: codexTypeOf(entity.type),
  }));
  const registered = await page.evaluate(
    (input) => window.identityLoad.registerRoster(input),
    { projectId, entries },
  );
  assert.equal(
    registered.created,
    entries.length,
    "[artifact] REGISTRATION_COUNT_DIFFERS",
  );
  let safeStorageRecord = null;
  if (expectedSafeStorageCheck) {
    // 上書きが有効なら本物の backend（idlRealStorageBackend）を読む。上書きの無い経路では safeStorage の値を読む。
    const seen = await evaluateMain(app, ({ safeStorage }) => ({
      backend:
        globalThis.idlRealStorageBackend?.() ??
        safeStorage.getSelectedStorageBackend?.() ??
        "unknown",
      overridden: typeof globalThis.idlRealStorageBackend === "function",
    }));
    safeStorageRecord = assertSafeStorageCondition({
      ...seen,
      userData,
      runRoot,
      keep,
    });
  }
  // 送る前の条件（F2：役割の上書きが空・既定／名簿に hidden が 0 件／許可リスト以外の宛先が無い）。
  // 判定できなければ止める。key はこの後に読むので、止まれば key に触れない。
  const preconditions = (expectedEntryCount) =>
    evaluateSendPreconditions({
      roleDefaults: () =>
        page.evaluate(() => window.identityLoad.bAssertRoleDefaults()),
      rosterHidden: () =>
        page.evaluate(() => window.identityLoad.bAssertRosterNotHidden()),
      egressObservation,
      expectedEntryCount,
    });
  const head = await preconditions(entries.length);
  if (!head.ok)
    assert.fail(`[precheck] ${head.code} the send preconditions are not met`);
  // 各送信の直前にも確かめる（B2 は要求の間に名簿を変え、宛先は cell の間に変わりうる）。満たさなければ停止線を立てて止める。
  let sendGuardChecks = 0;
  const beforeSend = async () => {
    sendGuardChecks++;
    const now = await preconditions(null);
    if (now.ok) return;
    gate.halt(now.code, {});
    throw new BudgetStop(now.code, {});
  };
  // key は検査・登録・backend の確認がすべて通った後、送信の直前に読む（getKey）。
  const secret = key ?? (await getKey());
  // 入れた後に失敗しても（bConfigureAi が key を保存した後に throw するなど）、finally の removeKey を通す（F3a の m7）。
  let primaryError = null;
  try {
    const configured = await installKey(page, {
      provider: PROVIDER,
      model: MODEL,
      key: secret,
    });
    assert.equal(
      configured.provider,
      PROVIDER,
      "[precheck] PROVIDER_NOT_APPLIED",
    );
    assert.equal(configured.model, MODEL, "[precheck] MODEL_NOT_APPLIED");
    assert.equal(configured.keyPresent, true, "[precheck] KEY_NOT_PRESENT");
    const api = bindPageApi({
      page,
      workspaceDir,
      beforeSend,
      judgeWatchdogMs,
      timers,
    });
    const registeredKeyHashes = await registeredKeyHashesOf(entries);
    let result;
    if (mode === "b2") {
      result = await runB2({
        api,
        gate,
        index,
        rosterTypeOf: (id) => index.entities.get(id)?.type,
        registeredIds: new Set(entries.map((e) => e.id)),
        registeredKeyHashes,
        remainingAfter,
        usagePoll,
      });
    } else {
      result = await runB1({
        api,
        gate,
        index,
        registeredKeyHashes,
        stage: mode === "trial" ? "trial" : "B1",
        repeats: mode === "trial" ? 1 : 3,
        remainingAfter,
        usagePoll,
      });
    }
    const requestsSent = (result.requests ?? result.iterations ?? []).reduce(
      (n, r) => n + (r.attempts ?? 1),
      0,
    );
    // 終了時：ai_usage と audit の surface・pathId の集合が空か codex_judgment だけ。検査の失敗は例外にせず、
    // 結果（surfaces.ok）に残して cell を不採用にする（realCellStatus）。
    const usage = readAiUsageRows(workspaceDir);
    const audit = readAuditPathIds(workspaceDir);
    const readable = usage.readable > 0 && audit.readable > 0;
    const successfulRequests = (
      result.requests ??
      result.iterations ??
      []
    ).filter((r) => r.ok).length;
    const surfaceCheck = readable
      ? checkOnlyCodexJudgment({
          usageSurfaces: usage.rows.map((r) => r.surface),
          auditPathIds: audit.pathIds,
          requestsSent,
        })
      : { ok: false, usageSurfaceCount: 0, auditPathCount: 0 };
    const surfaces = {
      ok: surfaceCheck.ok,
      readable,
      usageSurfaceCount: surfaceCheck.usageSurfaceCount,
      auditPathCount: surfaceCheck.auditPathCount,
      usageRows: usage.rows.length,
      successfulRequests,
      usageCoversSuccesses: checkUsageCoversSuccesses({
        usageRows: usage.rows.length,
        successfulRequests,
      }),
    };
    const models = {};
    for (const row of usage.rows)
      models[row.model ?? "null"] = (models[row.model ?? "null"] ?? 0) + 1;
    return {
      mode,
      level,
      roster: {
        entityCount: used.entities.length,
        cut,
        registeredEntries: entries.length,
      },
      safeStorage: safeStorageRecord,
      preconditions: { ...head.record, sendGuardChecks },
      settings: {
        provider: configured.provider,
        model: configured.model,
        thinkingEnabled: configured.thinkingEnabled,
      },
      result,
      requestsSent,
      surfaces,
      usageModels: models,
      resolvedModel: "not-available-from-ai-usage",
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // key を消す。page が止まっていても期限で諦め（cell の後始末が userData を消し、key の残りを検査する）、
    // 元の例外があればそれを隠さない。
    try {
      await withWatchdog(
        removeKey(page, { provider: PROVIDER }),
        keyRemovalTimeoutMs,
        () => {
          throw new Error(
            "[artifact] KEY_REMOVAL_TIMEOUT the key removal did not return in time",
          );
        },
        timers,
      );
    } catch (removalError) {
      if (primaryError === null) throw removalError;
    }
  }
}

/** 本測定の cell の採用条件：許した AI command だけ。送信回数は IPC の send_chat_message と一致。 */
export function realCellStatus(cell, value) {
  // 宛先：許可リストが適用され、標本が 1 回以上成り立ち、許可リスト以外の宛先が無いこと（F2 の R3。乾いた実行と同じ基準）。
  const egress = cell.egress;
  // socket を 1 つも見ていない標本（子孫の fd を読めない・root の違い）は、何も見ていないのと同じ（F3a の B1）。
  if (
    egress?.policyApplied !== true ||
    (egress.sampleCount ?? 0) === 0 ||
    (egress.socketCountMax ?? 0) === 0 ||
    (egress.tcpSocketCountMax ?? 0) === 0
  )
    return "egress-unverified";
  if ((egress.disallowedDestinations ?? []).length > 0)
    return "egress-detected";
  // build 物の出所が cell の records に残っていること（F2 の R2。照合は runCell の頭と起動の直前）。
  // cell の後の照合（runCell。build 物・guard の file が cell の間に変わっていない）も要る。
  if (
    !/^[0-9a-f]{40}$/u.test(String(cell.buildProvenance?.head)) ||
    cell.buildProvenance?.stableAfterCell !== true
  )
    return "build-unverified";
  const names = cell.ipc?.commandNames ?? [];
  const unexpected = findAiCommands(names).filter(
    (name) => !ALLOWED_REAL_AI_COMMANDS.includes(name),
  );
  if (unexpected.length > 0) return "unexpected-ai-command";
  const sent = cell.ipc?.commandCounts?.send_chat_message ?? 0;
  if (value && sent !== value.requestsSent) return "send-count-mismatch";
  if (value?.surfaces?.ok === false) return "ai-surface-set";
  if (value?.surfaces?.usageCoversSuccesses === false)
    return "usage-rows-short";
  const stopped = value?.result?.stopped;
  if (stopped) return "budget-stopped";
  return "ok";
}

// ---- 引数・main ------------------------------------------------------------------

function parseArgs(args) {
  const options = {
    mode: "dry-run",
    works: Object.keys(WORKS).join(","),
    output: DEFAULT_OUTPUT,
    "data-dir": "",
    "roster-dir": "",
    "roster-name": "roster-final.json",
    "confirm-send": "",
    "synth-entity-fraction": String(DEFAULT_SYNTH.entityFraction),
    "synth-alias-fractions": B1_LEVELS.map(
      (l) => DEFAULT_SYNTH.aliasFractions[l],
    ).join(","),
    "trial-work": "",
    "real-env-fifo": "",
    "egress-allow": "",
    "egress-resolver": "",
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
    ["dry-run", "trial", "b1", "b2"].includes(options.mode),
    "[precheck] unknown --mode",
  );
  for (const work of options.works.split(","))
    assert.ok(work in WORKS, `[precheck] unknown work ${work}`);
  return options;
}

async function mainDry(options) {
  const output = path.resolve(options.output);
  const outDir = path.join(output, "dry-run");
  ensurePrivateDir(outDir);
  const aliasList = options["synth-alias-fractions"].split(",").map(Number);
  const synth = {
    entityFraction: Number(options["synth-entity-fraction"]),
    aliasFractions: Object.fromEntries(
      B1_LEVELS.map((level, i) => [level, aliasList[i] ?? 0]),
    ),
  };
  const pricing = readModelPricing(MODEL);
  const rows = [];
  const summary = [];
  await withVite(output, async ({ vite, busAddress }) => {
    for (const work of options.works.split(",")) {
      const { cell, value, scenesTexts } = await runCell({
        output,
        vite,
        busAddress,
        cellId: `B-dry-${work}`,
        workKey: work,
        dataDir: options["data-dir"],
        keep: options.keep === "true",
        // 乾いた実行は、main の入口で AI の外向きの命令を拒否する層を入れて動かし、探針で送信の直前の経路を通す。
        blockDispatch: true,
        body: (ctx) =>
          dryCellBody({
            page: ctx.page,
            app: ctx.app,
            workspaceDir: ctx.workspaceDir,
            probeJudge: true,
            synth,
          }),
      });
      const status =
        cell.status === "failed"
          ? "failed"
          : finalDryStatus({ cellStatus: dryCellStatus(cell), value });
      cell.status = status;
      const result = {
        schemaVersion: "identity-load-measure-b-dry/1",
        work,
        status,
        observed: cell,
        ...(value ?? {}),
      };
      try {
        assertOutputClean(result, scenesTexts);
        writeJson0600(path.join(outDir, `${work}.json`), result);
      } catch (error) {
        writeJson0600(path.join(outDir, `${work}.failed.json`), {
          work,
          status: "output-withheld",
          errors: [safeErrorSummary(error)],
        });
      }
      for (const level of value?.levels ?? [])
        rows.push({
          work,
          level: level.level,
          candidates: level.candidates,
          request: level.request,
          b1Requests: level.b1Requests,
          b2Requests: level.b2Requests,
        });
      summary.push({ work, status });
      console.log(JSON.stringify(summary.at(-1)));
    }
  });
  const rowsByWork = {};
  for (const row of rows) (rowsByWork[row.work] ??= []).push(row);
  // 合成の小さな名簿で測った値（測定値）と、名簿の規模を仮定した上限側の外挿。
  const measured = buildDryRunPlan(rows, { pricing });
  const projections = {};
  for (const [name, scenario] of Object.entries(PROJECTION_SCENARIOS)) {
    const p = buildProjectedPlan(rowsByWork, scenario, { pricing });
    projections[name] = { scenario, perWork: p.perWork, cost: p.cost };
  }
  const report = {
    schemaVersion: "identity-load-measure-b-dry-summary/1",
    model: MODEL,
    pricingPerMillion: pricing,
    caps: { totalUsd: TOTAL_CAP_USD, stagesUsd: STAGE_CAPS_USD },
    assumptions: DRY_RUN_ASSUMPTIONS,
    synthetic: synth,
    works: summary,
    rows,
    measuredSynthetic: measured.cost,
    projections,
  };
  assertOutputClean(report, []);
  writeJson0600(path.join(outDir, "summary.json"), report);
  if (summary.some((s) => s.status !== "ok")) process.exitCode = 1;
  return report;
}

/** 乾いた実行の結果から、作品ごとの B2 の要求数の上限（空の名簿の N から ceil(N/50)）を読む。無ければ空。 */
function readB2UpperByWork(outDirDry) {
  try {
    const summary = JSON.parse(
      readFileSync(path.join(outDirDry, "summary.json"), "utf8"),
    );
    const out = {};
    for (const row of summary.rows ?? [])
      if (row.level === "empty") out[row.work] = row.b2Requests;
    return out;
  } catch {
    return {};
  }
}

/**
 * 台帳が本測定を始められる状態か（cell・key を使う前の前検査。止まれば STOP 行も書かない）。
 * - STOP 行があれば、解除（人が STOP 行を消す）まで始めない。
 * - 未精算の予約が 1 件でもあれば始めない（落ちた process の、届いたか分からない送信を、人が確かめないまま次の起動が進まない。
 *   人が確かめて `<台帳>.reservations` の該当行の後ろに RELEASE 行を足す。予約した process が動いているかは見ない。F5 の m-b）。
 * - b1／b2 は試走の実測の行が無ければ始めない。
 */
export function assertLedgerReady(gate, mode) {
  assert.ok(
    !gate.state.stopped,
    `[precheck] LEDGER_STOPPED code=${String(gate.state.stopped?.code).replace(/[^A-Za-z0-9_]/gu, "_")}`,
  );
  const unsettled = gate.unsettledReservations();
  assert.equal(
    unsettled.length,
    0,
    `[precheck] LEDGER_UNSETTLED_RESERVATIONS ${unsettled.length} unsettled reservations remain from an earlier run. A person checks the sends and adds a RELEASE row for each`,
  );
  assert.ok(
    mode === "trial" || gate.state.trial,
    "[precheck] TRIAL_REQUIRED run --mode trial first and keep its ledger rows",
  );
}

async function mainReal(options) {
  assertSendAllowed(options);
  const output = path.resolve(options.output);
  const works = options["trial-work"]
    ? [options["trial-work"]]
    : options.works.split(",");
  const outDir = path.join(output, `measure-b-${options.mode}`);
  ensurePrivateDir(outDir);
  assertNoFakeAiEnv(process.env);
  // 安い前検査を先に行う（key は最後、各 cell の送信の直前に読む）。
  // key が disk に残りうる cell（basic_text の userData。§17.6）は、終わりに消す前提なので --keep true は使えない。
  assert.ok(
    options.keep !== "true",
    "[precheck] KEEP_FORBIDDEN a real run deletes each cell userData at its end",
  );
  // 宛先の許可リストが明示されていること（F2 の R3）。cell も key も使わず STOP 行も書かない位置で止める。
  const egressPolicy = buildEgressPolicy({
    allowCidrs: splitList(options["egress-allow"]),
    resolverIps: splitList(options["egress-resolver"]),
  });
  // key の復号の helper に渡す本物の session の env は、外側の script（launch-measure-b.mjs）が FIFO で 1 回渡す。
  // 無い・本物の bus を指さない（隔離 bus と同じ・socket が無い）なら、cell も key も使わずに止まる。
  const realEnv = assertRealBusEnv(
    await receiveRealEnv(options["real-env-fifo"]),
    { isolatedAddresses: [process.env.DBUS_SESSION_BUS_ADDRESS] },
  );
  // build 物の出所が今の HEAD の source と一致すること（F2 の R2）。sha256 の計算に数秒かかるので、
  // 外側の script の FIFO の受け渡しの期限（receiveRealEnv）の後に置く。ここでも cell・key・STOP 行より前。
  assertBuildProvenance({ root: ROOT });
  const residue = findKeyResidue(output);
  assert.equal(
    residue.length,
    0,
    `[precheck] KEY_RESIDUE ${residue.length} leftover key-fifo or B cell directories from an interrupted run`,
  );
  const rosterDir = options["roster-dir"] || path.join(output, "roster");
  const rosters = new Map();
  for (const work of works) {
    const roster = JSON.parse(
      readFileSync(path.join(rosterDir, work, options["roster-name"]), "utf8"),
    );
    assert.ok(
      validateRoster(roster, {}).ok,
      `[precheck] ROSTER_INVALID ${work}`,
    );
    rosters.set(work, roster);
  }
  const gate = createGate({
    file: path.join(output, "ledger", "spend-ledger.jsonl"),
    model: MODEL,
  });
  // 台帳の STOP 行・落ちた process の未精算の予約・試走の行を、cell も key も使う前に確かめる。
  assertLedgerReady(gate, options.mode);
  const levels =
    options.mode === "b2"
      ? ["L2"]
      : options.mode === "trial"
        ? ["L2"]
        : B1_LEVELS;
  const cells = works.flatMap((work) =>
    levels.map((level) => ({ work, level })),
  );
  const b2Upper = readB2UpperByWork(path.join(output, "dry-run"));
  const keyStoreBefore = hashKeyStore();
  const summary = [];
  try {
    await withVite(output, async ({ vite, busAddress }) => {
      // key は復号の helper で FIFO から cell の中で 1 回ずつ受ける。helper の env は控えた本物の session の env
      // （測定の Electron・A・名簿・目録には渡さない。§17.6）。本物の bus を指さなければ FIFO も作らずに止まる。
      const isolatedAddresses = [
        busAddress,
        process.env.DBUS_SESSION_BUS_ADDRESS,
      ];
      const getKey = makeKeyGetter({
        realEnv,
        isolatedAddresses,
        parent: output,
        tmpDir: process.env.TMPDIR,
      });
      for (const [cellIndex, { work, level }] of cells.entries()) {
        if (gate.state.stopped) break;
        assert.ok(ROSTER_LEVELS.includes(level));
        assertNoOverlappingJobs();
        const roster = rosters.get(work);
        const { cell, value, scenesTexts } = await runCell({
          output,
          vite,
          busAddress,
          cellId: `B-${options.mode}-${work}-${level}`,
          workKey: work,
          dataDir: options["data-dir"],
          plainTextKeyStore: true,
          egressPolicy,
          keep: false,
          body: (ctx) =>
            measureBBody({
              ...ctx,
              roster,
              level,
              mode: options.mode,
              gate,
              getKey,
              remainingAfter: remainingRequestsAfterCell({
                mode: options.mode,
                cells,
                cellIndex,
                allWorks: options.works.split(","),
                levels: B1_LEVELS,
                b2Upper,
              }),
            }),
        });
        const status =
          cell.status === "failed" ? "failed" : realCellStatus(cell, value);
        cell.status = status;
        const result = {
          schemaVersion: "identity-load-measure-b/1",
          // 指標の定義の版（aggregate が版の混在を止める）。
          metricDefinitionVersion: B_METRIC_DEFINITION_VERSION,
          work,
          level,
          status,
          observed: cell,
          value,
          ledger: {
            total: Number(gate.state.total.toFixed(4)),
            stopped: gate.state.stopped?.code ?? null,
          },
        };
        try {
          assertOutputClean(result, scenesTexts);
          writeJson0600(path.join(outDir, `${work}-${level}.json`), result);
        } catch (error) {
          writeJson0600(path.join(outDir, `${work}-${level}.failed.json`), {
            work,
            level,
            status: "output-withheld",
            errors: [safeErrorSummary(error)],
          });
          // 出力を出せない cell は、以後の送信を止める（key を入れた次の cell を走らせない）。
          gate.halt("OUTPUT_WITHHELD", { work, level });
        }
        summary.push({ work, level, status });
        console.log(JSON.stringify(summary.at(-1)));
        // 送信の後の異常（cell が ok でない・予算の停止）は fail-closed：以後の cell を送らない。
        // STOP 行は台帳に残り、launcher を再起動しても停止のまま（解除は人）。
        if (status !== "ok") gate.halt("CELL_NOT_OK", { status, work, level });
      }
    });
  } finally {
    const keyStoreAfter = hashKeyStore();
    writeJson0600(path.join(outDir, "key-store-check.json"), {
      productKeyStoreUnchanged: keyStoreBefore === keyStoreAfter,
    });
    if (keyStoreBefore !== keyStoreAfter) process.exitCode = 1;
  }
  if (summary.some((s) => s.status !== "ok")) process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "dry-run") await mainDry(options);
  else await mainReal(options);
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
