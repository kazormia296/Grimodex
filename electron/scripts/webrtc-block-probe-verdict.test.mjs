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

test("対照不成立の行に帰属した到達は、未検証に変換されず不合格", () => {
  const baseline = { rows: [row("ll.turn-tcp.ll6", "gathering:complete")] };
  const out = judgeRecord(
    { label: "x", totals: { leakedProbes: 1, canaryHits: 1, unattributed: 0 }, rows: [row("ll.turn-tcp.ll6", "gathering:gathering", 1, 0)] },
    { baseline },
  );
  assert.equal(out.fail, 1);
  assert.equal(out.unverified.length, 0);
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

test("種類の内訳は判定した行だけを数える（対照不成立の行を含めない）", () => {
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
  assert.equal(out.unverified.length, 1);
});

test("DNS だけの行は、対照で試みが観測できなくても対照不成立にせず、canary 0 で合格（K3/3 R14）", () => {
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
  assert.equal(out.unverified.length, 0);
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
