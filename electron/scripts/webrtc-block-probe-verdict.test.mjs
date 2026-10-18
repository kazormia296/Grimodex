import assert from "node:assert/strict";
import test from "node:test";

import { judgeRecord } from "./webrtc-block-probe-verdict.mjs";

// 合成の記録（K3/3 R13）。最終構成を模した少数の行。実機の記録ではなく、判定の道具の規則だけを試す。
const row = (id, outcome, leaked = 0, proxied = 0) => ({ id, outcome, leaked, proxied });
function closedRecord(mutate = (r) => r) {
  return mutate({
    label: "synthetic-closed",
    totals: { leakedProbes: 0, probes: 8, canaryHits: 0, unattributed: 0, proxyHits: 3 },
    rows: [
      row("main.turn-tcp.lo4", "gathering:complete", 0, 2),
      row("main.stun.lo4", "gathering:complete"),
      row("dns.dns-prefetch.name", "link:x"),
      row("control.same-origin-fetch", "status:200"),
      row("main.net-fetch.window-session", "timeout", 0, 1),
      row("realm.iframe-blob.turn-tcp.name", "error:SecurityError:blocked"),
      row("realm.window-open.stun.name", "no-window"),
      row("realm.worker-rtc-defined", "worker-error"),
    ],
  });
}

test("閉じた記録は全部合格で、記録全体の不合格もない", () => {
  const out = judgeRecord(closedRecord());
  assert.equal(out.fail, 0);
  assert.deepEqual(out.recordFailures, []);
  assert.equal(out.pass, 3);
  assert.equal(out.na, 5);
});

test("Main 側の対象外の行に帰属した canary 到達は不合格", () => {
  const out = judgeRecord(closedRecord((r) => {
    r.rows.find((x) => x.id === "main.net-fetch.window-session").leaked = 3;
    return r;
  }));
  assert.ok(out.failing.some((f) => f.id === "main.net-fetch.window-session"));
});

test("outcome が error: の行（閉じ込めの対象の行）に帰属した到達は不合格", () => {
  const out = judgeRecord(closedRecord((r) => {
    r.rows.find((x) => x.id === "realm.iframe-blob.turn-tcp.name").leaked = 2;
    return r;
  }));
  assert.ok(out.failing.some((f) => f.id === "realm.iframe-blob.turn-tcp.name"));
});

test("不活性の行に帰属した到達は、合否の外に出されず不合格", () => {
  const baseline = { rows: [row("ll.turn-tcp.ll6", "gathering:complete")] };
  const out = judgeRecord(
    { label: "x", totals: { leakedProbes: 1, canaryHits: 1, unattributed: 0 }, rows: [row("ll.turn-tcp.ll6", "gathering:gathering", 1, 0)] },
    { baseline },
  );
  assert.equal(out.fail, 1);
  assert.equal(out.inert.length, 0);
});

test("どの行にも帰属しない到達（totals.unattributed）は記録として不合格", () => {
  const out = judgeRecord(closedRecord((r) => {
    r.totals.unattributed = 5;
    return r;
  }));
  assert.equal(out.fail, 0);
  assert.equal(out.recordFailures.length, 1);
});

test("totals.unattributed がない記録は不合格（fail-safe）", () => {
  const out = judgeRecord(closedRecord((r) => {
    delete r.totals.unattributed;
    return r;
  }));
  assert.equal(out.recordFailures.length, 1);
});

test("種類の内訳は判定した行だけを数える（不活性の行を含めない）", () => {
  const baseline = { rows: [row("ll.turn-tcp.ll6", "gathering:complete"), row("ll.stun.ll4", "gathering:gathering")] };
  const out = judgeRecord(
    {
      label: "x",
      totals: { leakedProbes: 0, canaryHits: 0, unattributed: 0 },
      rows: [row("ll.turn-tcp.ll6", "gathering:complete", 0, 0), row("ll.stun.ll4", "gathering:complete")],
    },
    { baseline },
  );
  assert.equal(out.byKind.tcp, 0);
  assert.equal(out.byKind.udp, 1);
  assert.equal(out.inert.length, 1);
});

test("DNS だけの行は、対照で試みが観測できなくても不活性の行にせず、canary 0 で合格（K3/3 R14）", () => {
  const baseline = { rows: [row("dns.preconnect", "link:preconnect"), row("dns.dns-prefetch", "link:dns-prefetch")] };
  baseline.rows[1].dnsNames = ["x.invalid"];
  const out = judgeRecord(
    {
      label: "x",
      totals: { leakedProbes: 0, canaryHits: 0, unattributed: 0 },
      rows: [row("dns.preconnect", "link:preconnect"), row("dns.dns-prefetch", "link:dns-prefetch")],
    },
    { baseline },
  );
  assert.equal(out.fail, 0);
  assert.equal(out.pass, 2);
  assert.equal(out.byKind.hint, 2);
  assert.equal(out.inert.length, 0);
});

test("対照の行列にない DNS だけの行は不合格（fail-safe。K3/3 R14）", () => {
  const baseline = { rows: [row("dns.dns-prefetch", "link:dns-prefetch")] };
  const out = judgeRecord(
    {
      label: "x",
      totals: { leakedProbes: 0, canaryHits: 0, unattributed: 0 },
      rows: [row("dns.dns-prefetch", "link:dns-prefetch"), row("dns.new-hint-not-in-baseline", "link:preconnect")],
    },
    { baseline },
  );
  assert.equal(out.fail, 1);
  assert.equal(out.failing[0].id, "dns.new-hint-not-in-baseline");
});

test("対照なし（--baseline なし）の DNS だけの行は canary 0 で合格", () => {
  const out = judgeRecord({ label: "x", totals: { unattributed: 0 }, rows: [row("dns.new-hint", "link:preconnect")] });
  assert.equal(out.fail, 0);
});

// ── K3/3 R15: 3 区分（活性／canary 不可／不活性）と FQDN の remote candidate ──
const closedTotals = { leakedProbes: 0, canaryHits: 0, unattributed: 0 };
const withNames = (r, names) => ({ ...r, dnsNames: names });

test("FQDN の remote candidate は、対照でも名前の解決だけなら不活性の行で、proxy 宛 0 でも不合格にならない", () => {
  const baseline = {
    rows: [
      withNames(row("main.remote-candidate-tcp.fqdn", "ice:new"), ["rct-<n>.probe.test"]),
      withNames(row("main.remote-candidate-udp.fqdn", "ice:new"), ["rcu-<n>.probe.test"]),
    ],
  };
  const out = judgeRecord(
    { label: "x", totals: closedTotals, rows: [row("main.remote-candidate-tcp.fqdn", "ice:new"), row("main.remote-candidate-udp.fqdn", "ice:new")] },
    { baseline },
  );
  assert.equal(out.fail, 0);
  assert.equal(out.inert.length, 2);
  assert.equal(out.byRegion.inert, 2);
  assert.equal(out.byKind.tcp, 0);
});

test("不活性の FQDN の行で、名前が許容集合の外へ解決されたら不合格（NL）", () => {
  const baseline = { rows: [withNames(row("main.remote-candidate-tcp.fqdn", "ice:new"), ["rct-<n>.probe.test"])] };
  const out = judgeRecord(
    { label: "x", totals: closedTotals, rows: [withNames(row("main.remote-candidate-tcp.fqdn", "ice:new"), ["rct-<n>.probe.test"])] },
    { baseline },
  );
  assert.equal(out.fail, 1);
  assert.match(out.failing[0].why, /NL/);
});

test("不活性の FQDN の行で、許容集合の名前（github.com など）の解決は不合格にしない", () => {
  const baseline = { rows: [withNames(row("main.remote-candidate-udp.fqdn", "ice:new"), ["x-<n>.probe.test"])] };
  const out = judgeRecord(
    { label: "x", totals: closedTotals, rows: [withNames(row("main.remote-candidate-udp.fqdn", "ice:new"), ["github.com.", "localhost[rc0]"])] },
    { baseline },
  );
  assert.equal(out.fail, 0);
});

test("FQDN の行でも、canary に届けば不合格（不活性の行にしない）", () => {
  const baseline = { rows: [row("main.remote-candidate-tcp.fqdn", "ice:new")] };
  const out = judgeRecord(
    { label: "x", totals: { leakedProbes: 1, canaryHits: 1, unattributed: 0 }, rows: [row("main.remote-candidate-tcp.fqdn", "ice:new", 1, 0)] },
    { baseline },
  );
  assert.equal(out.fail, 1);
  assert.equal(out.inert.length, 0);
});

test("対照の行列にない FQDN の行は不合格（fail-safe）", () => {
  const out = judgeRecord(
    { label: "x", totals: closedTotals, rows: [row("main.remote-candidate-tcp.fqdn", "ice:new")] },
    { baseline: { rows: [] } },
  );
  assert.equal(out.fail, 1);
});

test("名前の解決を試みの数に入れる行（ICE server の TURN の名前）は不活性にならず、proxy 宛 0 なら不合格", () => {
  const baseline = { rows: [withNames(row("main.turn-tcp.ext", "gathering:complete"), ["x-<n>.blocked.invalid"])] };
  const out = judgeRecord(
    { label: "x", totals: closedTotals, rows: [row("main.turn-tcp.ext", "gathering:complete", 0, 0)] },
    { baseline },
  );
  assert.equal(out.fail, 1);
  assert.equal(out.byRegion.canaryless, 1);
});

test("3 区分: 対照で canary に届いた行は活性、届かないが ICE が進行した行は canary 不可、試みのない行は不活性", () => {
  const baseline = {
    rows: [
      row("main.turn-tcp.lo4", "gathering:gathering", 3),
      row("ll.turn-tcp.ll4", "gathering:gathering"),
      row("ll.turn-tcp.ll6", "gathering:complete"),
    ],
  };
  const out = judgeRecord(
    {
      label: "x",
      totals: closedTotals,
      rows: [row("main.turn-tcp.lo4", "gathering:complete", 0, 2), row("ll.turn-tcp.ll4", "gathering:complete", 0, 1), row("ll.turn-tcp.ll6", "gathering:complete")],
    },
    { baseline },
  );
  assert.deepEqual(out.byRegion, { active: 1, canaryless: 1, inert: 1 });
  assert.equal(out.fail, 0);
});

test("IP literal の remote candidate の行も、隣の行の名前が時間窓に入っても、名前の解決を試みに数えず不活性の行になる", () => {
  const baseline = { rows: [withNames(row("ll.remote-candidate-tcp.ll6", "ice:new"), ["rcu-<n>.probe.test."])] };
  const out = judgeRecord(
    { label: "x", totals: closedTotals, rows: [row("ll.remote-candidate-tcp.ll6", "ice:new")] },
    { baseline },
  );
  assert.equal(out.fail, 0);
  assert.equal(out.inert.length, 1);
});
