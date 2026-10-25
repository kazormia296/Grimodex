/**
 * CP-2b P2 の packaged smoke の OS ごとの判定（K3/3 `nir1-d2a-activation-proposal/3` の Negative (34)。G-pub）。
 *
 *   node electron/scripts/packaged-smoke/verdict.mjs <os の記録の dir>
 *
 * 合否の述語は K3/3 の RJ と NL だけで、ここでは定義しない: 行ごとの合否は `webrtc-block-probe-verdict.mjs` の `judgeRecord`
 * （対照つき）、名前は `webrtc-block-probe-nc1.mjs` の `judgeNl`、その正の対照は `judgeNlPositiveControl`、`.local` は
 * `judgeLocalRule`（すべて read-only で import する。DR-NC1-40 (a)）。この file が足すのは、それらを (34) の形に組み立てることと、
 * 不合格だけを足す確認（cp2b-decisions DR-CP2B-P2-4）:
 *   (a) 道具: 3 構成の起動と終了の証拠、CDP の注入、net log、LS-1 の port が 1 つ、DoH の canary（baseline）
 *   (b) 道具の対照（toolcheck）: Main の listener の実数と net log の接続数が TCP の行ごとに一致し、port が一致する
 *   (c) 正の対照（baseline）: IP literal の行が canary に届き、net log と DoH の canary に攻撃者の名前が現れる
 *   (d) 行列: packaged の renderer の行 id の集合が baseline と一致する（RJ は対照にある行の欠落を見ないため）
 *   (e) RJ、(f) NL、(g) `.local`（`unverified` は K3/3 の規則どおり記録に残し合否に含めない）
 * どれかが欠ければ合格にしない。道具の欠落は status `no-observation-tool`（その OS は (34) 不通過。解除は新しい draftRef。K3/3）。
 * 記録だけのもの（合否にしない）: NC-1 の所要の推定、辞書・更新の要求、H9 の順序、OS の確認ダイアログ、bind できない canary。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { judgeLocalRule, judgeNl, judgeNlPositiveControl } from "../webrtc-block-probe-nc1.mjs";
import { classify, judgeRecord } from "../webrtc-block-probe-verdict.mjs";

/** 攻撃 JS の flag（3 構成で同じ。DR-CP2B-P2-2）。名前は probe の main の `cm` の key */
export const MATRIX_FLAGS = Object.freeze({ dns: true, localhostRows: true, rs1: true, local: true });
/** 正の対照で canary への到達を要求する行（IP literal の loopback。対照が成立していなければ届く） */
export const BASELINE_ACTIVE_REQUIRED = Object.freeze(["main.turn-tcp.lo4", "main.stun.lo4"]);
/** 正の対照で DoH の canary に名前の観測を要求するカテゴリ（`NL_POSITIVE_CATEGORIES` の部分集合。FQDN の行は行列にない） */
export const DOH_POSITIVE_REQUIRE = Object.freeze(["stun", "turn-udp", "turn-tcp", "turns", "dns-prefetch"]);
/** bind できない canary の宛先を使う行（行 id の末尾の form） */
export const CANARY_ROW_FORMS = Object.freeze({ "r-127.0.0.2": /\.lo4b$/, "s-[::1]": /\.lo6$/, "t-lan": /\.lan$/ });
export const CONFIGS = Object.freeze(["baseline", "toolcheck", "packaged"]);
/** page の shim（run.mjs の pageShimIds）が実行を変える行（DR-CP2B-P2-5）。判定は変えず、出力に行単位で明示する */
export const SHIMMED_ROWS = Object.freeze({ "form-submit": Object.freeze(["dns.form-submit"]) });

/** shim の影響を受けた行と、その判定（開示の正確さのため。合否の数は変えない） */
export function shimmedRows(packaged, rj) {
  const ids = (packaged?.pageShimIds ?? []).flatMap((shim) => SHIMMED_ROWS[shim] ?? []);
  return ids.map((id) => {
    const row = rj?.results.find((entry) => entry.id === id);
    return { id, verdict: row?.verdict ?? "absent", kind: row?.kind ?? null };
  });
}

const sameFlags = (flags) => JSON.stringify(Object.keys(MATRIX_FLAGS).sort().map((key) => [key, flags?.[key] === true]))
  === JSON.stringify(Object.keys(MATRIX_FLAGS).sort().map((key) => [key, true]))
  && Object.keys(flags ?? {}).every((key) => key in MATRIX_FLAGS);

/** (a) 道具の欠落（構成ごと） */
export function toolGaps(record, config) {
  const gaps = [];
  if (!record) return [`${config}: 記録がない`];
  if (record.config !== config) gaps.push(`${config}: 記録の構成が ${record.config}`);
  if (record.fatal) gaps.push(`${config}: 実行が失敗した（${String(record.fatal).slice(0, 160)}）`);
  if (record.lifecycle?.ok !== true) gaps.push(`${config}: 子 process の終了の証拠がない（${JSON.stringify(record.lifecycle ?? null).slice(0, 200)}）`);
  if (!sameFlags(record.matrixFlags)) gaps.push(`${config}: 攻撃 JS の flag が既定と違う（${JSON.stringify(record.matrixFlags ?? null)}）`);
  if (!Array.isArray(record.rows) || record.rows.length === 0) gaps.push(`${config}: 行が 0`);
  if (!record.netLog || record.netLog.error) gaps.push(`${config}: net log が読めない（${record.netLog?.error ?? "なし"}）`);
  if (typeof record.totals?.unattributed !== "number") gaps.push(`${config}: totals.unattributed がない`);
  if (config === "packaged") {
    if (record.cdp?.injected !== true) gaps.push("packaged: CDP の注入ができていない");
  }
  if (config !== "baseline") {
    const ports = record.netLog?.ls1Ports ?? [];
    if (ports.length !== 1 || !Number.isInteger(record.netLog?.ls1Port)) gaps.push(`${config}: net log から LS-1 の port が 1 つに決まらない（${JSON.stringify(ports)}）`);
  }
  if (config === "baseline" && record.doh?.started !== true) gaps.push(`baseline: DoH の canary を起動できない（${record.doh?.error ?? "なし"}）`);
  return gaps;
}

/** (b) 道具の対照: toolcheck で Main の listener の実数と net log の接続数を行ごとに照合する */
export function judgeToolcheck(toolcheck) {
  const failures = [];
  if (!toolcheck) return { ok: false, failures: ["toolcheck の記録がない"], tcpRows: 0, mismatched: [] };
  if (toolcheck.nc1?.startOk !== true) failures.push(`toolcheck: 製品の NC-1 の start が成功していない（${JSON.stringify(toolcheck.nc1?.failures ?? null)}）`);
  if (!Number.isInteger(toolcheck.nc1?.listenerPort) || toolcheck.nc1.listenerPort !== toolcheck.netLog?.ls1Port) {
    failures.push(`toolcheck: net log の LS-1 の port（${toolcheck.netLog?.ls1Port}）が Main の listener の port（${toolcheck.nc1?.listenerPort}）と違う`);
  }
  const tcp = (toolcheck.rows ?? []).filter((row) => classify(row).kind === "tcp");
  const mismatched = tcp.filter((row) => (row.proxiedListener >= 1) !== (row.proxiedNetLog >= 1)).map((row) => row.id);
  if (mismatched.length) failures.push(`toolcheck: listener と net log の接続の有無が食い違う TCP の行 ${mismatched.length}: ${mismatched.slice(0, 5).join(", ")}`);
  const observed = tcp.filter((row) => row.proxiedListener >= 1).length;
  if (observed === 0) failures.push("toolcheck: listener への接続がある TCP の行が 0（照合が空）");
  return { ok: failures.length === 0, failures, tcpRows: tcp.length, observedRows: observed, mismatched };
}

/** (c) 正の対照: 閉じ込めなしの同じ行列で、到達と名前が観測できる */
export function judgePositiveControl(baseline) {
  const failures = [];
  const byId = new Map((baseline?.rows ?? []).map((row) => [row.id, row]));
  for (const id of BASELINE_ACTIVE_REQUIRED) {
    if (!(byId.get(id)?.leaked > 0)) failures.push(`正の対照: ${id} が canary に届いていない`);
  }
  const netLog = judgeNlPositiveControl(baseline, "netLog");
  if (!netLog.ok) failures.push(`正の対照（net log）: ${netLog.missing.join(", ")}`);
  const doh = judgeNlPositiveControl(baseline, "doh", { require: DOH_POSITIVE_REQUIRE });
  if (!doh.ok) failures.push(`正の対照（DoH の canary）: 名前が観測できないカテゴリ ${doh.missing.join(", ")}`);
  return { ok: failures.length === 0, failures, netLog, doh };
}

/** (d) 行列: renderer の行 id の集合が一致する */
export function judgeMatrix(packaged, baseline) {
  const ids = (record) => new Set(record?.rendererRowIds ?? []);
  const packagedIds = ids(packaged);
  const baselineIds = ids(baseline);
  const missing = [...baselineIds].filter((id) => !packagedIds.has(id));
  const extra = [...packagedIds].filter((id) => !baselineIds.has(id));
  const failures = [];
  if (baselineIds.size === 0) failures.push("行列: baseline の renderer の行が 0");
  if (missing.length) failures.push(`行列: packaged に無い行 ${missing.length}: ${missing.slice(0, 5).join(", ")}`);
  if (extra.length) failures.push(`行列: baseline に無い行 ${extra.length}: ${extra.slice(0, 5).join(", ")}`);
  return { ok: failures.length === 0, failures, rows: baselineIds.size, missing, extra };
}

/** bind できなかった canary と、その宛先の行の区分（記録だけ。H11 の趣旨で黙って落とさない） */
export function unboundCanaryRows(packaged, rj) {
  const unbound = (packaged?.canaries ?? []).filter((canary) => canary.bound === false);
  return unbound.map((canary) => {
    const pattern = CANARY_ROW_FORMS[canary.label];
    const rows = pattern ? rj.results.filter((row) => pattern.test(row.id)) : [];
    return {
      label: canary.label,
      error: canary.error,
      rows: rows.map((row) => ({ id: row.id, verdict: row.verdict, region: row.region ?? null })),
    };
  });
}

/** OS ごとの (34) の判定 */
export function judgeOs({ baseline, toolcheck, packaged, packageCheck }) {
  const gaps = [...toolGaps(baseline, "baseline"), ...toolGaps(toolcheck, "toolcheck"), ...toolGaps(packaged, "packaged")];
  const tool = judgeToolcheck(toolcheck);
  const positive = judgePositiveControl(baseline);
  // 道具の対照と正の対照が取れないことは「観測の道具なし」に数える（K3/3: 正の対照が取れない OS は (34) を通らない）
  gaps.push(...tool.failures, ...positive.failures);
  const failures = [];
  const matrix = judgeMatrix(packaged, baseline);
  failures.push(...matrix.failures);
  const rj = packaged?.rows ? judgeRecord(packaged, { baseline }) : null;
  if (rj) {
    for (const row of rj.failing) failures.push(`RJ: ${row.id} [${row.kind}] ${row.why}`);
    for (const failure of rj.recordFailures) failures.push(`RJ（記録全体）: ${failure}`);
  } else {
    failures.push("RJ: packaged の行がない");
  }
  const nl = packaged ? judgeNl(packaged) : { pass: false, outside: ["packaged の記録がない"], channels: {} };
  if (!nl.pass) failures.push(`NL: 許容集合の外 ${nl.outside.length}: ${nl.outside.slice(0, 5).join(", ")}`);
  if (nl.channels?.netLog == null) gaps.push("NL: packaged の net log の host resolver の観測がない");
  const local = judgeLocalRule(packaged, baseline);
  if (local.status === "fail") failures.push(`.local: ${local.reason}`);
  if (!packageCheck) failures.push("package: 検査の記録がない");
  else if (!packageCheck.ok) failures.push(...packageCheck.failures.map((failure) => `package: ${failure}`));
  const status = gaps.length > 0 ? "no-observation-tool" : failures.length > 0 ? "fail" : "pass";
  return {
    status,
    pass: status === "pass",
    gaps,
    failures,
    sections: {
      toolcheck: tool,
      positive,
      matrix,
      rj: rj && {
        rows: rj.rows, pass: rj.pass, fail: rj.fail, na: rj.na, byRegion: rj.byRegion, byKind: rj.byKind,
        inert: rj.inert.map((row) => ({ id: row.id, why: row.why })), recordFailures: rj.recordFailures,
      },
      nl,
      local,
      package: packageCheck ?? null,
    },
    recorded: {
      unboundCanaries: rj ? unboundCanaryRows(packaged, rj) : [],
      pageShims: packaged?.pageShims ?? [],
      shimmedRows: rj ? shimmedRows(packaged, rj) : [],
      nc1: {
        networkPhaseLowerBoundMs: packaged?.netLog?.nc1NetworkPhase?.lowerBoundMs ?? null,
        launchToWindowMs: packaged?.cdp?.launchToTargetMs ?? null,
        limitMs: 5000,
      },
      dictionaryRequests: packaged?.netLog?.dictionaryRequests ?? [],
      h9: packaged?.netLog?.h9 ?? null,
      osDialogs: packaged?.osDialogs ?? null,
      dictionariesOnDisk: packaged?.dictionariesOnDisk ?? null,
    },
  };
}

export function formatVerdict(os, verdict) {
  const lines = [];
  const rj = verdict.sections.rj;
  lines.push(`== (34) ${os}: ${verdict.status}`);
  if (rj) {
    lines.push(`RJ: 行 ${rj.rows}（判定 ${rj.pass + rj.fail}: tcp ${rj.byKind.tcp}／udp ${rj.byKind.udp}／hint ${rj.byKind.hint}、対象外 ${rj.na}、区分: 活性 ${rj.byRegion.active}／canary 不可 ${rj.byRegion.canaryless}／不活性 ${rj.byRegion.inert}）合格 ${rj.pass} 不合格 ${rj.fail} 記録全体の不合格 ${rj.recordFailures.length}`);
    if (rj.inert.length) lines.push(`不活性の行（合否に数えない）${rj.inert.length} 行: ${rj.inert.map((row) => row.id).join(", ")}`);
  }
  lines.push(`NL: ${verdict.sections.nl.pass ? "合格" : "不合格"}（channels ${JSON.stringify(verdict.sections.nl.channels)}）`);
  lines.push(`.local: ${verdict.sections.local.status}（${verdict.sections.local.reason}）`);
  lines.push(`行列: ${verdict.sections.matrix.rows} 行、欠け ${verdict.sections.matrix.missing.length}、余り ${verdict.sections.matrix.extra.length}`);
  lines.push(`道具の対照（toolcheck）: TCP の行 ${verdict.sections.toolcheck.tcpRows}、listener への接続あり ${verdict.sections.toolcheck.observedRows ?? 0}、食い違い ${verdict.sections.toolcheck.mismatched.length}`);
  lines.push(`正の対照: net log の nonce つきの host ${verdict.sections.positive.netLog.observed}、DoH ${JSON.stringify(verdict.sections.positive.doh.observed)}`);
  for (const gap of verdict.gaps) lines.push(`  GAP(観測の道具) ${gap}`);
  for (const failure of verdict.failures) lines.push(`  FAIL ${failure}`);
  for (const canary of verdict.recorded.unboundCanaries) {
    lines.push(`  記録: bind できない canary ${canary.label}（${canary.error}）の宛先の行: ${canary.rows.map((row) => `${row.id}=${row.region ?? row.verdict}`).join(", ")}`);
  }
  for (const shim of verdict.recorded.pageShims) lines.push(`  記録: page の shim ${shim}`);
  for (const row of verdict.recorded.shimmedRows ?? []) {
    lines.push(`  記録: shim 済みの行 ${row.id}（${row.kind ?? "?"}、判定 ${row.verdict}。packaged では送信しないので実質は実行されていない。合格の数には含む）`);
  }
  lines.push(`記録（合否にしない）: NC-1 の network の段の下限 ${verdict.recorded.nc1.networkPhaseLowerBoundMs} ms、起動から窓まで ${verdict.recorded.nc1.launchToWindowMs} ms（期限 5000 ms）、辞書の要求 ${verdict.recorded.dictionaryRequests.length} 件、H9 ${JSON.stringify(verdict.recorded.h9)}`);
  return lines.join("\n");
}

export function readOsRecords(dir) {
  const read = (name) => {
    const file = path.join(dir, `${name}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  };
  return { baseline: read("baseline"), toolcheck: read("toolcheck"), packaged: read("packaged"), packageCheck: read("package-check") };
}

const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node electron/scripts/packaged-smoke/verdict.mjs <os の記録の dir>");
    process.exitCode = 2;
  } else {
    const verdict = judgeOs(readOsRecords(dir));
    console.log(formatVerdict(path.basename(path.resolve(dir)), verdict));
    process.exitCode = verdict.pass ? 0 : 1;
  }
}
