/**
 * WebRTC の閉じ込めの記録（webrtc-block-probe の JSON）を「行ごと」に判定する（K3/3 R12。R15 で 3 区分に揃えた）。
 *
 *   node electron/scripts/webrtc-block-probe-verdict.mjs <record.json> [--expect-min-fail <n>] [--quiet]
 *
 * 集計値（canary 到達 0、proxy 宛の合計 55 以上）は、canary を置けない宛先（link-local など）や、
 * <-loopback> を外して DIRECT に落ちた行を見逃す。このため合否は行ごとに決める。
 *
 *   TCP の ICE 行（turn-tcp／turns／turns-tcp／remote-candidate-tcp、dns.many-* などの TURN-TCP の行）:
 *     合格 = leaked が 0 かつ proxied（blackhole の listener への接続）が 1 以上
 *   UDP の ICE 行（stun／stuns／turn-udp／remote-candidate-udp）:
 *     合格 = leaked が 0 かつ ICE が policy で止まった形の outcome（gathering:complete、ice:new）
 *   DNS だけが起きる行（dns-prefetch など）: leaked が 0（名前の合否は NL の述語。ここでは見ない）。
 *     対照で試みが観測できることは要求しない（--baseline があっても「不活性の行」にしない）。ただし対照の行列にない行は不合格（K3/3 R14）
 *   対象外（ICE まで届かない行。CSP や handler で止まる行、Main 側の通信、対照）: 判定しない。理由を出す
 *
 *   .local（mDNS）の行: 判定しない（draft の「.local の規則」だけで判定する）
 *   分類できない行: 不合格（fail-safe）
 *
 * --baseline があるとき、TCP／UDP の ICE 行は閉じ込めなしの対照で 3 区分に分ける（K3/3 R15。draft の RJ の表と同じ）:
 *   活性の行          = 対照で canary に届いた行。上の TCP／UDP の規則で判定する
 *   canary 不可の行   = 対照で canary には届かないが、接続の試みが観測できた行（ICE が進行中、または ICE server の行の名前の解決。
 *                       link-local、未解決名など）。TCP／UDP の規則は同じ。canary 0 は見かけの 0 なので、合否は proxy 宛と ICE の状態だけが担う
 *   不活性の行        = 対照でも接続を試みない行（[fe80::1]、localhost の TURN-TCP、FQDN の remote candidate など）。合否に数えず、列挙して理由を出す。
 *                       canary への到達があれば不合格のまま。remote candidate の行は名前の解決を試みに数えない。FQDN の remote candidate（行 id が *.fqdn*）は名前の解決だけが起きる行で、
 *                       名前が許容集合（NL の A）の外へ解決されていない（getaddrinfo の記録 dnsNames）ことだけをここで見る
 *
 * 不合格だけを足す必要条件（合格の根拠にはしない。K3/3 R13）:
 *   記録全体で canary 到達が 0。対象外の行（control、Main 側、outcome が error:／no-window／rtc-undefined／setRemoteDescription-failed の行、
 *   不活性の行、.local の行）に帰属した到達と、どの行にも帰属しない到達（totals.unattributed）を含む。1 件でもあれば不合格。
 *   - 対象外の行でも leaked>0 なら行として不合格（judge。不活性の行に変換しない）
 *   - totals.unattributed／canaryHits／leakedProbes が 0 でなければ記録として不合格（recordFailures）
 *   --baseline <record.json>: 閉じ込めなしの同じ行列の記録。対照で接続の試みが観測できない TCP／UDP の行は「不活性の行」として列挙し（合否に数えない）、
 *     対照にない行（DNS だけの行を含む）は不合格にする
 *   --no-listener: blackhole の listener を置かない試験。TCP の行は canary 0 だけを見る
 * 終了コード: 不合格の行があれば 1。--expect-min-fail n（対照の構成用）は不合格が n 行以上のとき 0、未満なら 1。
 */
import fs from "node:fs";

const TCP_PROTOS = new Set(["turn-tcp", "turns", "turns-tcp"]);
const UDP_PROTOS = new Set(["stun", "stuns", "turn-udp"]);
const UDP_STOPPED = new Set(["gathering:complete", "ice:new"]);
const TCP_EXTRA = /^dns\.(many-turn-tcp30|many-turns8|long-name190|gvt1-label|github-label|public-example)$/;

export function classify(row) {
  const id = row.id;
  const outcome = String(row.outcome ?? "");
  if (id.startsWith("control.")) return { kind: "n/a", why: "対照（ICE の行ではない）" };
  if (/^main\.(net-fetch|updater|node-fetch)/.test(id)) return { kind: "n/a", why: "Main 側の通信の確認" };
  if (id === "realm.worker-rtc-defined") return { kind: "n/a", why: "worker に RTCPeerConnection がない（CSP と handler の対照）" };
  if (/^(error:|no-window|rtc-undefined|setRemoteDescription-failed)/.test(outcome)) {
    return { kind: "n/a", why: `行が成立していない（${outcome.slice(0, 40)}）` };
  }
  // .local（mDNS）の行は proxy へ向かないので、行ごとの proxy 宛では判定しない。合否は draft の「.local の規則」（UDP 5353 の観測）だけ
  if (/(^|[.-])(local-name|mdns)([.-]|$)|\.local\b/.test(id)) return { kind: "mdns", why: ".local の規則（UDP 5353 の multicast の観測）で判定する行" };
  if (TCP_EXTRA.test(id)) return { kind: "tcp" };
  if (/^(link:|img$|fetch:|ws$|a-ping$|iframe-http$|form$)/.test(outcome) || /-pf$/.test(id)) return { kind: "hint" };
  const parts = id.split(".");
  // 名前の途中に proto が入る形（main.<proto>.<form>、realm.<name>.<proto>.<form>、rv.lit.<tag>.<proto>、ll.<proto>.<form> など）
  const proto = parts.find((p) => TCP_PROTOS.has(p) || UDP_PROTOS.has(p) || /^remote-candidate-(tcp|udp)$/.test(p));
  // remote candidate の行。address が IP literal の行は名前を持たず、FQDN の行（非 mDNS。行 id が *.fqdn*）は名前の解決だけが起き接続は試みない。
  // どちらも名前の解決は接続の試みに数えない（rc）。FQDN の行（fqdn）は、不活性のとき名前が許容集合の外へ解決されていないことを見る
  if (proto && /^remote-candidate-(tcp|udp)$/.test(proto)) {
    return { kind: proto.endsWith("tcp") ? "tcp" : "udp", rc: true, fqdn: parts.some((p) => /^fqdn/.test(p)) };
  }
  if (proto && TCP_PROTOS.has(proto)) return { kind: "tcp" };
  if (proto && UDP_PROTOS.has(proto)) return { kind: "udp" };
  return { kind: "unclassified", why: "分類できない行" };
}

export function judge(row, { noListener = false } = {}) {
  const c = classify(row);
  // 対象外（n/a、.local）の行でも canary への到達は不合格（合否の根拠にはしないが、到達は見逃さない）
  if ((c.kind === "n/a" || c.kind === "mdns") && row.leaked > 0) {
    return { id: row.id, kind: "excluded-leak", verdict: "fail", why: `対象外の行（${c.why}）に canary へ ${row.leaked} 件到達` };
  }
  if (c.kind === "n/a" || c.kind === "mdns") return { id: row.id, kind: c.kind, verdict: "n/a", why: c.why };
  // 分類できない行は不合格（DA-1 が行を足しても、判定の規則に載らない行は通さない）
  if (c.kind === "unclassified") return { id: row.id, kind: c.kind, verdict: "fail", why: c.why + "（fail-safe）" };
  if (row.leaked > 0) return { id: row.id, kind: c.kind, verdict: "fail", why: `canary へ ${row.leaked} 件到達` };
  if (c.kind === "tcp") {
    // --no-listener（blackhole の listener を置かない試験）では proxy 宛を数えられないので、canary 0 だけを見る
    if (noListener) return { id: row.id, kind: c.kind, verdict: "pass", why: "canary 0（listener なしの試験。proxy 宛は見ない）" };
    return row.proxied >= 1
      ? { id: row.id, kind: c.kind, verdict: "pass", why: `proxy 宛 ${row.proxied}` }
      : { id: row.id, kind: c.kind, verdict: "fail", why: "proxy 宛 0（blackhole に届いていない。DIRECT か未接続）" };
  }
  if (c.kind === "udp") {
    return UDP_STOPPED.has(row.outcome)
      ? { id: row.id, kind: c.kind, verdict: "pass", why: `ICE が止まった形（${row.outcome}）` }
      : { id: row.id, kind: c.kind, verdict: "fail", why: `ICE が止まっていない（${row.outcome}）` };
  }
  return { id: row.id, kind: c.kind, verdict: "pass", why: "canary 0（名前の合否は NL）" };
}

/**
 * 対照（閉じ込めなしの同じ行列）で「接続の試み」が観測できた行か。canary への到達、ICE が進行中の outcome、または名前の解決。
 * ただし remote candidate の行（rc）は、名前の解決だけでは試みと数えない（FQDN の remote candidate は、Chromium が名前を解決するが
 * 接続を試みない。名前を loopback の canary に写しても到達 0。隣の行の名前が時間窓に入ることもある）。
 */
export function attemptObserved(baseRow, { rc = false } = {}) {
  if (!baseRow) return false;
  return baseRow.leaked > 0
    || /^(gathering:gathering|ice:checking)$/.test(String(baseRow.outcome))
    || (!rc && ((baseRow.dnsNames?.length ?? 0) > 0 || (baseRow.dohNames?.length ?? 0) > 0));
}

/** NL の許容集合 A（getaddrinfo の記録層の分。draft の「名前の漏れ（NL）の定義」と同じ集合） */
const NL_ALLOWED = new Set([
  "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "localhost",
  "grimodex-rule-sentinel.invalid", "127.0.0.1",
]);
/** dnsNames（"name" か "name[rc0]"。試験の nonce は <n>）のうち許容集合の外の名前 */
export function nlOutside(dnsNames = []) {
  return dnsNames
    .map((n) => n.replace(/\[rc0\]$/, "").replace(/\.$/, "").toLowerCase())
    .filter((n) => !NL_ALLOWED.has(n));
}

/** 区分: 対照で canary に届いた行は active、届かないが試みが観測できた行は canaryless */
export function regionOf(baseRow) {
  return baseRow.leaked > 0 ? "active" : "canaryless";
}

export function judgeRecord(record, options = {}) {
  const baseById = new Map((options.baseline?.rows ?? []).map((r) => [r.id, r]));
  const rows = (record.rows ?? []).map((r) => {
    const j = judge(r, options);
    if (!options.baseline || j.verdict === "n/a") return j;
    // hint（DNS だけが起きる行）は名前の合否が NL の述語なので、対照で試みが観測できることは要求しない（canary 0 だけを見る。
    // 対照でも解決・到達が 0 の行がある〔Electron で no-op か CSP で止まる〕）。ただし対照の行列にない行は不合格（fail-safe。K3/3 R14）
    if (j.kind === "hint") {
      if (j.verdict === "fail" || baseById.has(r.id)) return j;
      return { ...j, verdict: "fail", why: "対照（baseline）の行列にない行（fail-safe）" };
    }
    // canary へ到達した行は、不活性の行でも合否の外に出さない（到達は不合格のまま）
    if (j.verdict === "fail" && r.leaked > 0) return j;
    const b = baseById.get(r.id);
    // 対照にない行は不合格（fail-safe）
    if (!b) return { ...j, verdict: "fail", why: "対照（baseline）の行列にない行（fail-safe）" };
    const { rc, fqdn } = classify(r);
    // 対照でも接続を試みない行は「不活性の行」。合否に数えず、列挙して理由を出す
    if (!attemptObserved(b, { rc: !!rc })) {
      const why = fqdn
        ? `不活性の行（FQDN の remote candidate。対照でも名前の解決だけで接続を試みない: ${b.outcome}）`
        : `不活性の行（対照でも接続を試みない: ${b.outcome}）`;
      // FQDN の行は、名前が許容集合の外へ解決されていないこと（NL の getaddrinfo の分）だけを見る
      const outside = fqdn ? nlOutside(r.dnsNames) : [];
      if (outside.length) return { id: r.id, kind: j.kind, verdict: "fail", region: "inert", why: `不活性の行で名前が許容集合の外へ解決された（NL）: ${outside.slice(0, 3).join(", ")}` };
      return { id: r.id, kind: j.kind, verdict: "n/a", region: "inert", why, inert: true };
    }
    return { ...j, region: regionOf(b) };
  });
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  // 記録全体の必要条件: どの行にも帰属しない到達（遅れて届いた接続が次の行の窓や対象外の行に入る場合を含む）を見逃さない
  const t = record.totals ?? {};
  const recordFailures = [];
  if (!(typeof t.unattributed === "number")) recordFailures.push("totals.unattributed がない（記録が不完全。fail-safe）");
  else if (t.unattributed > 0) recordFailures.push(`どの行にも帰属しない canary 到達 ${t.unattributed} 件（totals.unattributed）`);
  if (t.canaryHits > 0) recordFailures.push(`記録全体で canary 到達 ${t.canaryHits} 件（totals.canaryHits）`);
  if (t.leakedProbes > 0) recordFailures.push(`canary に届いた probe ${t.leakedProbes} 行（totals.leakedProbes）`);
  // 種類の内訳は判定した行（verdict が n/a でない行）だけを数える
  const judged = rows.filter((r) => r.verdict !== "n/a");
  return {
    recordFailures,
    label: record.label,
    rows: rows.length,
    pass: count("pass"),
    fail: count("fail"),
    na: count("n/a"),
    failing: rows.filter((r) => r.verdict === "fail"),
    inert: rows.filter((r) => r.inert),
    byRegion: Object.fromEntries(["active", "canaryless", "inert"].map((k) => [k, rows.filter((r) => r.region === k).length])),
    byKind: Object.fromEntries(["tcp", "udp", "hint", "mdns", "unclassified", "excluded-leak"].map((k) => [k, judged.filter((r) => r.kind === k).length])),
    mdnsRows: rows.filter((r) => r.kind === "mdns").length,
    results: rows,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a, i) => !a.startsWith("--") && !["--baseline", "--expect-min-fail"].includes(argv[i - 1]));
  const file = positional[0];
  const minFailIdx = argv.indexOf("--expect-min-fail");
  const minFail = minFailIdx >= 0 ? Number(argv[minFailIdx + 1]) : null;
  const quiet = argv.includes("--quiet");
  const baselineIdx = argv.indexOf("--baseline");
  const baseline = baselineIdx >= 0 ? JSON.parse(fs.readFileSync(argv[baselineIdx + 1], "utf8")) : null;
  const out = judgeRecord(JSON.parse(fs.readFileSync(file, "utf8")), { noListener: argv.includes("--no-listener"), baseline });
  console.log(`${out.label}: 行 ${out.rows}（判定 ${out.pass + out.fail}: tcp ${out.byKind.tcp}／udp ${out.byKind.udp}／hint ${out.byKind.hint}／unclassified ${out.byKind.unclassified}／対象外の行への到達 ${out.byKind["excluded-leak"]}、対象外 ${out.na}〔うち .local ${out.mdnsRows}、不活性 ${out.inert.length}〕、区分: 活性 ${out.byRegion.active}／canary 不可 ${out.byRegion.canaryless}／不活性 ${out.byRegion.inert}）合格 ${out.pass} 不合格 ${out.fail} 記録全体の不合格 ${out.recordFailures.length}`);
  if (!quiet) for (const f of out.failing) console.log(`  FAIL ${f.id} [${f.kind}] ${f.why}`);
  for (const f of out.recordFailures) console.log(`  FAIL(記録全体) ${f}`);
  if (out.inert.length) console.log(`  不活性の行（合否に数えない）${out.inert.length} 行: ${out.inert.map((u) => u.id).join(", ")}`);
  if (minFail != null) {
    // 対照の検出は、行の不合格と記録全体の不合格の合計で数える
    const detected = out.fail + out.recordFailures.length;
    const ok = detected >= minFail;
    console.log(`対照: 不合格 ${out.fail} 行＋記録全体 ${out.recordFailures.length} 件 ${ok ? ">=" : "<"} ${minFail} → ${ok ? "検出できた（期待どおり）" : "検出できていない（試験の欠陥）"}`);
    process.exitCode = ok ? 0 : 1;
  } else {
    process.exitCode = out.fail === 0 && out.recordFailures.length === 0 ? 0 : 1;
  }
}
