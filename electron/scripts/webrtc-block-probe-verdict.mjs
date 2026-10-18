/**
 * WebRTC の閉じ込めの記録（webrtc-block-probe の JSON）を「行ごと」に判定する（K3/3 R12）。
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
 *   DNS だけが起きる行（dns-prefetch など）: leaked が 0（名前の合否は NL の述語。ここでは見ない）
 *   対象外（ICE まで届かない行。CSP や handler で止まる行、Main 側の通信、対照）: 判定しない。理由を出す
 *
 *   .local（mDNS）の行: 判定しない（draft の「.local の規則」だけで判定する）
 *   分類できない行: 不合格（fail-safe）
 *   --baseline <record.json>: 閉じ込めなしの同じ行列の記録。対照で試みが観測できない行（canary 到達、ICE の進行中、名前の解決のどれもない）は
 *     判定できないので「対照不成立」として列挙し（未検証）、対照にない行は不合格にする
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
  if (proto && /^remote-candidate-(tcp|udp)$/.test(proto)) return { kind: proto.endsWith("tcp") ? "tcp" : "udp" };
  if (proto && TCP_PROTOS.has(proto)) return { kind: "tcp" };
  if (proto && UDP_PROTOS.has(proto)) return { kind: "udp" };
  return { kind: "unclassified", why: "分類できない行" };
}

export function judge(row, { noListener = false } = {}) {
  const c = classify(row);
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

/** 対照（閉じ込めなしの同じ行列）で試みが観測できた行か。canary への到達、ICE が進行中の outcome、名前の解決のどれか */
export function attemptObserved(baseRow) {
  if (!baseRow) return false;
  return baseRow.leaked > 0
    || /^(gathering:gathering|ice:checking)$/.test(String(baseRow.outcome))
    || (baseRow.dnsNames?.length ?? 0) > 0
    || (baseRow.dohNames?.length ?? 0) > 0;
}

export function judgeRecord(record, options = {}) {
  const baseById = new Map((options.baseline?.rows ?? []).map((r) => [r.id, r]));
  const rows = (record.rows ?? []).map((r) => {
    const j = judge(r, options);
    // hint（DNS だけが起きる行）は名前の合否が NL の述語なので、対照の試みの観測は要求しない（canary 0 だけを見る）
    if (!options.baseline || j.verdict === "n/a" || j.kind === "hint") return j;
    const b = baseById.get(r.id);
    // 対照にない行は不合格（fail-safe）。対照で試みが観測できない行は判定できない（未検証として列挙する）
    if (!b) return { ...j, verdict: "fail", why: "対照（baseline）の行列にない行（fail-safe）" };
    if (!attemptObserved(b)) return { id: r.id, kind: j.kind, verdict: "n/a", why: `対照不成立（baseline でも試みが観測できない: ${b.outcome}）`, unverified: true };
    return j;
  });
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  return {
    label: record.label,
    rows: rows.length,
    pass: count("pass"),
    fail: count("fail"),
    na: count("n/a"),
    failing: rows.filter((r) => r.verdict === "fail"),
    unverified: rows.filter((r) => r.unverified),
    byKind: Object.fromEntries(["tcp", "udp", "hint", "mdns", "unclassified"].map((k) => [k, rows.filter((r) => r.kind === k).length])),
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
  console.log(`${out.label}: 行 ${out.rows}（判定 ${out.pass + out.fail}: tcp ${out.byKind.tcp}／udp ${out.byKind.udp}／hint ${out.byKind.hint}／.local ${out.byKind.mdns}、対象外 ${out.na - out.byKind.mdns}）合格 ${out.pass} 不合格 ${out.fail}`);
  if (!quiet) for (const f of out.failing) console.log(`  FAIL ${f.id} [${f.kind}] ${f.why}`);
  if (out.unverified.length) console.log(`  対照不成立（未検証）${out.unverified.length} 行: ${out.unverified.map((u) => u.id).join(", ")}`);
  if (minFail != null) {
    const ok = out.fail >= minFail;
    console.log(`対照: 不合格 ${out.fail} 行 ${ok ? ">=" : "<"} ${minFail} → ${ok ? "検出できた（期待どおり）" : "検出できていない（試験の欠陥）"}`);
    process.exitCode = ok ? 0 : 1;
  } else {
    process.exitCode = out.fail === 0 ? 0 : 1;
  }
}
