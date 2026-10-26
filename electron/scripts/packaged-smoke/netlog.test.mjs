import assert from "node:assert/strict";
import test from "node:test";

import { connectsInWindow, ls1ConnectTimes, ls1PortsOf, nc1NetworkPhase, normalizeNetLogHost, parseNetLog, summarizeNetLog } from "./netlog.mjs";

// 合成の net log（Chromium の形の一部だけ）。実機の記録ではなく、解析の規則だけを試す
const TYPES = {
  PROXY_CONFIG_CHANGED: 1, TCP_CONNECT: 2, TCP_CONNECT_ATTEMPT: 3, HOST_RESOLVER_MANAGER_REQUEST: 4,
  HOST_RESOLVER_MANAGER_JOB: 5, URL_REQUEST_START_JOB: 6,
};
const PHASES = { PHASE_NONE: 0, PHASE_BEGIN: 1, PHASE_END: 2 };
const SOURCES = { NONE: 0, SOCKET: 1, NETWORK_SERVICE_HOST_RESOLVER: 2, URL_REQUEST: 3 };
const OFFSET = 1_700_000_000_000;

function netLog(events) {
  return {
    constants: { logEventTypes: TYPES, logEventPhase: PHASES, logSourceType: SOURCES, timeTickOffset: String(OFFSET) },
    events: events.map(([type, phase, time, params = {}, source = "NONE", id = 1]) => ({
      type: TYPES[type], phase: PHASES[phase], time: String(time), params, source: { type: SOURCES[source], id },
    })),
  };
}

const proxyChanged = (port, time = 10) => ["PROXY_CONFIG_CHANGED", "PHASE_NONE", time, { new_config: { bypass_list: ["<-loopback>"], single_proxy: [`[socks5://127.0.0.1:${port}]`] } }];
const connect = (address, time, phase = "PHASE_BEGIN") => ["TCP_CONNECT", phase, time, { address_list: [address], aliases: [] }, "SOCKET"];

test("LS-1 の port は socks5://127.0.0.1:<port> の PROXY_CONFIG_CHANGED だけから取る（from_system と他の proxy は数えない）", () => {
  const log = netLog([
    proxyChanged(43931),
    ["PROXY_CONFIG_CHANGED", "PHASE_NONE", 20, { new_config: { from_system: true } }],
    ["PROXY_CONFIG_CHANGED", "PHASE_NONE", 30, { new_config: { single_proxy: ["[http://127.0.0.1:8080]"] } }],
  ]);
  const summary = summarizeNetLog(log);
  assert.deepEqual(summary.ls1Ports, [43931]);
  assert.equal(summary.ls1Port, 43931);
});

test("LS-1 の候補が 2 つあれば port を決めない（接続を数えない）", () => {
  const log = netLog([proxyChanged(1111), proxyChanged(2222, 20), connect("127.0.0.1:1111", 30)]);
  const summary = summarizeNetLog(log);
  assert.deepEqual(summary.ls1Ports, [1111, 2222]);
  assert.equal(summary.ls1Port, null);
  assert.equal(summary.ls1Connects, 0);
});

test("LS-1 への接続は TCP_CONNECT の begin で宛先が 127.0.0.1:<port> のものだけ。時刻は timeTickOffset + time", () => {
  const log = netLog([
    proxyChanged(43931),
    connect("127.0.0.1:43931", 100),
    connect("127.0.0.1:43931", 100, "PHASE_END"),
    connect("127.0.0.1:9", 120), // 別の宛先（canary など）は数えない
    connect("[::1]:43931", 130), // 別の address は数えない
    ["TCP_CONNECT_ATTEMPT", "PHASE_BEGIN", 140, { address: "127.0.0.1:43931" }, "SOCKET"], // 同じ接続の attempt は二重に数えない
    connect("127.0.0.1:43931", 150),
  ]);
  const events = summarizeNetLog(log)._connectTimes;
  assert.deepEqual(events, [OFFSET + 100, OFFSET + 150]);
  assert.equal(connectsInWindow(events, { startedAt: OFFSET + 90, endedAt: OFFSET + 110 }), 1);
  assert.equal(connectsInWindow(events, { startedAt: OFFSET + 111, endedAt: OFFSET + 149 }), 0);
  assert.equal(connectsInWindow(events, { startedAt: OFFSET + 150, endedAt: OFFSET + 150 }), 1);
});

test("host resolver の host は NL の正規化で集め、URL 要求の host は数えない。nonce を含む生の host を数え、記録では <n> に伏せる", () => {
  const nonce = "a1b2c3";
  const log = netLog([
    ["HOST_RESOLVER_MANAGER_REQUEST", "PHASE_BEGIN", 1, { host: "https://~NOTFOUND" }, "NETWORK_SERVICE_HOST_RESOLVER", 1],
    ["HOST_RESOLVER_MANAGER_REQUEST", "PHASE_END", 2, {}, "NETWORK_SERVICE_HOST_RESOLVER", 1],
    ["HOST_RESOLVER_MANAGER_REQUEST", "PHASE_BEGIN", 3, { host: "127.0.0.1:39035" }, "SOCKET", 2],
    ["HOST_RESOLVER_MANAGER_JOB", "PHASE_BEGIN", 4, { host: "[::1]:443" }, "SOCKET", 3],
    ["HOST_RESOLVER_MANAGER_REQUEST", "PHASE_BEGIN", 5, { host: `stunname-${nonce}.probe.test:3478` }, "SOCKET", 4],
    ["URL_REQUEST_START_JOB", "PHASE_BEGIN", 6, { url: "https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic?x=1" }, "URL_REQUEST", 5],
  ]);
  const { hostResolver, dictionaryRequests } = summarizeNetLog(log, { nonce });
  assert.deepEqual(hostResolver.requestHosts, { "127.0.0.1": 1, "stunname-<n>.probe.test": 1, "~notfound": 1 });
  assert.deepEqual(hostResolver.jobHosts, { "::1": 1 });
  assert.equal(hostResolver.nonceBearing, 1);
  assert.ok(!Object.keys(hostResolver.requestHosts).some((host) => host.includes("gvt1")));
  assert.deepEqual(dictionaryRequests.map((request) => request.url), ["https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic"]);
});

test("normalizeNetLogHost は scheme・port・角括弧を外して小文字にする", () => {
  assert.equal(normalizeNetLogHost("app://GitHub.com"), "github.com");
  assert.equal(normalizeNetLogHost("http://~notfound:35057"), "~notfound");
  assert.equal(normalizeNetLogHost("[::1]:443"), "::1");
});

test("NC-1 の network の段の下限は setProxy から自己確認の最初の 3 件の resolve の終わりまで（記録だけ）", () => {
  const log = netLog([
    proxyChanged(43931, 1000),
    ["HOST_RESOLVER_MANAGER_REQUEST", "PHASE_BEGIN", 1004, { host: "127.0.0.1:0" }, "NETWORK_SERVICE_HOST_RESOLVER", 13],
    ["HOST_RESOLVER_MANAGER_REQUEST", "PHASE_END", 1004, {}, "NETWORK_SERVICE_HOST_RESOLVER", 13],
    ["HOST_RESOLVER_MANAGER_REQUEST", "PHASE_BEGIN", 1005, { host: "~NOTFOUND:0" }, "NETWORK_SERVICE_HOST_RESOLVER", 20],
    ["HOST_RESOLVER_MANAGER_REQUEST", "PHASE_END", 1005, {}, "NETWORK_SERVICE_HOST_RESOLVER", 20],
    ["HOST_RESOLVER_MANAGER_REQUEST", "PHASE_BEGIN", 1006, { host: "~NOTFOUND:0" }, "NETWORK_SERVICE_HOST_RESOLVER", 21],
    ["HOST_RESOLVER_MANAGER_REQUEST", "PHASE_END", 1009, {}, "NETWORK_SERVICE_HOST_RESOLVER", 21],
  ]);
  const view = summarizeNetLog(log).nc1NetworkPhase;
  assert.equal(view.lowerBoundMs, 9);
  assert.deepEqual(view.selfCheckResolves.map((entry) => entry.host), ["127.0.0.1:0", "~NOTFOUND:0", "~NOTFOUND:0"]);
  // 3 件そろわなければ推定しない
  const short = netLog([proxyChanged(43931, 1000), ["HOST_RESOLVER_MANAGER_REQUEST", "PHASE_BEGIN", 1004, { host: "127.0.0.1:0" }, "NETWORK_SERVICE_HOST_RESOLVER", 13]]);
  assert.equal(summarizeNetLog(short).nc1NetworkPhase.lowerBoundMs, null);
  assert.equal(nc1NetworkPhase([], 1).lowerBoundMs, null);
});

test("終了の途中で切れた net log も読む。形が不正なら throw（道具の欠落として扱われる）", () => {
  const text = JSON.stringify(netLog([proxyChanged(5)])).replace(/\]\}$/, ",");
  assert.equal(ls1PortsOf([]).length, 0);
  assert.deepEqual(summarizeNetLog(parseNetLog(text)).ls1Ports, [5]);
  assert.throws(() => summarizeNetLog({ events: [] }), /constants/);
  assert.throws(() => summarizeNetLog({ constants: { logEventTypes: {}, logEventPhase: {} }, events: [] }), /timeTickOffset/);
  assert.deepEqual(ls1ConnectTimes([], null), []);
});
