import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  SOCKET_SAMPLE_SCHEMA,
  analyzeNetLog,
  argvOfCmdline,
  assertX11Ozone,
  assessSocketSamples,
  buildSocketSample,
  classifySocket,
  decodeProcAddress,
  descendantsOf,
  isLoopbackAddress,
  parseNetLogText,
  parseProcNetTable,
  parseProcStat,
  sampleElectronSockets,
  startSocketSampler,
} from "./egress.mjs";

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:9C40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:D431 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 2222 1 0000000000000000 20 4 30 10 -1
   2: 0A00020F:D432 2E5DB8AC:01BB 02 00000000:00000000 00:00000000 00000000  1000        0 3333 1 0000000000000000 20 4 30 10 -1
   3: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4444 1 0000000000000000 100 0 0 10 0
`;
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0000000000000000FFFF00000100007F:9C41 0000000000000000FFFF00000100007F:D433 01 00000000:00000000 00:00000000 00000000  1000        0 5555 1 0000000000000000 20 4 30 10 -1
   1: 00000000000000000000000001000000:9C42 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6666 1 0000000000000000 100 0 0 10 0
`;
const UDP = `   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  100: 00000000:14E9 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 7777 2 0000000000000000 0
  101: 0100007F:9C43 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 8888 2 0000000000000000 0
`;

test("/proc addresses decode in host byte order for IPv4 and IPv6", () => {
  assert.deepEqual(decodeProcAddress("0100007F:1F90"), {
    family: 4,
    address: "127.0.0.1",
    port: 8080,
  });
  assert.equal(decodeProcAddress("2E5DB8AC:01BB").address, "172.184.93.46");
  assert.equal(
    decodeProcAddress("00000000000000000000000001000000:0050").address,
    "::1",
  );
  assert.equal(
    decodeProcAddress("0000000000000000FFFF00000100007F:0050").address,
    "::ffff:7f00:1",
  );
  assert.equal(
    decodeProcAddress("00000000000000000000000000000000:0000").address,
    "::",
  );
  assert.throws(() => decodeProcAddress("127.0.0.1:80"), /unparsable/);
});

test("loopback is 127/8, ::1 and IPv4-mapped 127; the wildcard is not loopback", () => {
  for (const address of [
    "127.0.0.1",
    "127.8.9.10",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ])
    assert.ok(isLoopbackAddress(address), address);
  for (const address of [
    "0.0.0.0",
    "::",
    "10.0.2.15",
    "::ffff:a00:20f",
    "128.0.0.1",
    "fe80::1",
  ])
    assert.ok(!isLoopbackAddress(address), address);
});

test("sockets classify listeners and connections; wildcard listeners are external", () => {
  const tcp = parseProcNetTable(TCP, "tcp");
  assert.deepEqual(
    tcp.map((row) => [row.inode, row.state, classifySocket(row)]),
    [
      ["1111", "listen", "loopback"],
      ["2222", "established", "loopback"],
      ["3333", "syn-sent", "external"],
      ["4444", "listen", "external-listener"],
    ],
  );
  const tcp6 = parseProcNetTable(TCP6, "tcp");
  assert.deepEqual(
    tcp6.map((row) => classifySocket(row)),
    ["loopback", "loopback"],
  );
  const udp = parseProcNetTable(UDP, "udp");
  assert.deepEqual(
    udp.map((row) => classifySocket(row)),
    ["external-listener", "loopback"],
  );
});

test("the process tree is the root and its descendants only", () => {
  const parentOf = new Map([
    [10, 1],
    [11, 10],
    [12, 11],
    [13, 10],
    [20, 1], // the harness' own node and vite are not below Electron
    [21, 20],
  ]);
  assert.deepEqual(descendantsOf(10, parentOf), [10, 11, 13, 12]);
  assert.deepEqual(descendantsOf(99, parentOf), []);
  assert.deepEqual(parseProcStat("123 (Web Content (x)) S 45 1 1 0"), {
    pid: 123,
    comm: "Web Content (x)",
    ppid: 45,
  });
  assert.deepEqual(argvOfCmdline("electron\0--type=renderer\0--x"), [
    "electron",
    "--type=renderer",
    "--x",
  ]);
  assert.deepEqual(argvOfCmdline("electron --type=gpu-process"), [
    "electron",
    "--type=gpu-process",
  ]);
});

function processes() {
  return [
    { pid: 10, type: "browser", socketInodes: ["1111", "2222", "7777"] },
    { pid: 11, type: "utility", socketInodes: ["3333"] },
    { pid: 12, type: "renderer", socketInodes: null },
  ];
}

const tables = () => [
  ...parseProcNetTable(TCP, "tcp"),
  ...parseProcNetTable(TCP6, "tcp"),
  ...parseProcNetTable(UDP, "udp"),
];

test("a socket sample joins inodes to the tree and lists violations", () => {
  const sample = buildSocketSample({
    atMs: 5,
    rootPid: 10,
    processes: processes(),
    tables: tables(),
  });
  assert.equal(sample.schema, SOCKET_SAMPLE_SCHEMA);
  assert.deepEqual(sample.pids, [10, 11, 12]);
  assert.deepEqual(sample.unreadable, [12]);
  assert.deepEqual(sample.sockets, {
    tcp: 3,
    udp: 1,
    loopback: 2,
    unconnected: 0,
  });
  assert.deepEqual(
    sample.external.map((row) => [row.pid, row.remote]),
    [[11, "172.184.93.46:443"]],
  );
  assert.deepEqual(
    sample.externalListeners.map((row) => [row.pid, row.local]),
    [[10, "0.0.0.0:5353"]],
  );
  // Sockets of processes outside the tree (inode 4444, 5555) are not counted.
  assert.ok(!JSON.stringify(sample).includes("8080"));
});

const RUN = { startedAtMs: 1_000, finishedAtMs: 61_000 };
function cleanSample(atMs) {
  return {
    schema: SOCKET_SAMPLE_SCHEMA,
    atMs,
    rootPid: 10,
    pids: [10],
    unreadable: [],
    sockets: { tcp: 1, udp: 0, loopback: 1, unconnected: 0 },
    external: [],
    externalListeners: [],
  };
}

test("socket samples must cover the run and show no external socket", () => {
  const rows = [0, 20_000, 40_000, 62_000].map(cleanSample);
  assert.deepEqual(assessSocketSamples({ samples: rows, run: RUN }), {
    clean: true,
    violations: [],
    gaps: [],
  });
  const external = rows.map((row, at) =>
    at === 2
      ? {
          ...row,
          external: [{ pid: 11, proto: "tcp", local: "a", remote: "b" }],
        }
      : row,
  );
  assert.match(
    assessSocketSamples({ samples: external, run: RUN }).violations[0],
    /external tcp/,
  );
  const listener = rows.map((row, at) =>
    at === 1
      ? {
          ...row,
          externalListeners: [{ pid: 10, proto: "udp", local: "0.0.0.0:5353" }],
        }
      : row,
  );
  assert.match(
    assessSocketSamples({ samples: listener, run: RUN }).violations[0],
    /reachable from outside/,
  );
  assert.match(
    assessSocketSamples({ samples: rows.slice(1), run: RUN }).gaps.join(),
    /before the run/,
  );
  assert.match(
    assessSocketSamples({ samples: rows.slice(0, 3), run: RUN }).gaps.join(),
    /after the run/,
  );
  assert.match(
    assessSocketSamples({
      samples: [rows[0], rows[3]],
      run: RUN,
    }).gaps.join(),
    /too far apart/,
  );
  assert.match(
    assessSocketSamples({
      samples: rows.map((row, at) => (at === 1 ? { ...row, pids: [] } : row)),
      run: RUN,
    }).gaps.join(),
    /no Electron process/,
  );
  assert.match(
    assessSocketSamples({
      samples: rows.map((row, at) =>
        at === 1
          ? { schema: SOCKET_SAMPLE_SCHEMA, atMs: 20_000, error: "EACCES" }
          : row,
      ),
      run: RUN,
    }).gaps.join(),
    /failed: EACCES/,
  );
  assert.equal(assessSocketSamples({ samples: [], run: RUN }).clean, false);
});

test("the sampler takes a first and a final sample and owns its timer", () => {
  let clock = 0;
  const calls = [];
  const sampler = startSocketSampler({
    rootPid: 10,
    intervalMs: 60_000,
    now: () => (clock += 1),
    sampleOnce: ({ atMs }) => {
      calls.push(atMs);
      if (calls.length === 2) throw new Error("gone");
      return cleanSample(atMs);
    },
  });
  const samples = sampler.stop();
  assert.equal(samples.length, 2);
  assert.match(samples[1].error, /gone/);
  assert.equal(sampler.stop().length, 2, "stop is idempotent");
});

test("sampleElectronSockets reads a /proc tree (synthetic directory)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cp4-proc-"));
  try {
    const proc = (pid, ppid, inodes) => {
      const dir = path.join(root, String(pid));
      mkdirSync(path.join(dir, "fd"), { recursive: true });
      mkdirSync(path.join(dir, "net"), { recursive: true });
      writeFileSync(path.join(dir, "stat"), `${pid} (electron) S ${ppid} 1 1`);
      writeFileSync(path.join(dir, "cmdline"), `electron\0--type=utility`);
      inodes.forEach((inode, at) =>
        symlinkSync(`socket:[${inode}]`, path.join(dir, "fd", String(at))),
      );
      writeFileSync(path.join(dir, "net", "tcp"), TCP);
      writeFileSync(path.join(dir, "net", "tcp6"), TCP6);
      writeFileSync(path.join(dir, "net", "udp"), UDP);
      writeFileSync(path.join(dir, "net", "udp6"), UDP.split("\n")[0]);
    };
    proc(10, 1, ["1111"]);
    proc(11, 10, ["3333"]);
    proc(20, 1, ["4444"]);
    const sample = sampleElectronSockets({
      rootPid: 10,
      atMs: 7,
      procRoot: root,
    });
    assert.deepEqual(sample.pids, [10, 11]);
    assert.equal(sample.external.length, 1);
    assert.equal(sample.externalListeners.length, 0);
    assert.deepEqual(
      sample.processes.map((row) => row.type),
      ["utility", "utility"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("S1 import: every Chromium child names x11 or the launch stops", () => {
  const tree = [
    { pid: 1, type: "browser", ozonePlatform: null },
    { pid: 2, type: "gpu-process", ozonePlatform: "x11" },
  ];
  assert.deepEqual(assertX11Ozone(tree).ozonePlatforms, ["x11"]);
  assert.throws(
    () =>
      assertX11Ozone([
        ...tree,
        { pid: 3, type: "renderer", ozonePlatform: "wayland" },
      ]),
    /\[precheck\].*wayland/,
  );
  assert.throws(() => assertX11Ozone([tree[0]]), /no Electron child/);
});

function netLog(events) {
  return {
    constants: {
      logEventTypes: {
        TCP_CONNECT: 1,
        TCP_CONNECT_ATTEMPT: 2,
        UDP_CONNECT: 3,
        DNS_TRANSACTION: 4,
        HOST_RESOLVER_MANAGER_JOB: 5,
        URL_REQUEST_START_JOB: 6,
        PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST: 7,
      },
    },
    events,
  };
}

test("the net log counts non-loopback attempts and keeps K6/3's expected classes apart", () => {
  const dict =
    "https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic?x=1";
  const clean = analyzeNetLog(
    netLog([
      {
        type: 1,
        phase: 1,
        source: { id: 1 },
        params: { address_list: ["127.0.0.1:40000"] },
      },
      {
        type: 2,
        phase: 1,
        source: { id: 1 },
        params: { address: "127.0.0.1:41000" },
      },
      {
        type: 5,
        phase: 1,
        source: { id: 2 },
        params: { host: "https://~NOTFOUND:443" },
      },
      {
        type: 5,
        phase: 1,
        source: { id: 3 },
        params: { host: "grimodex-rule-sentinel.invalid" },
      },
      {
        type: 5,
        phase: 1,
        source: { id: 4 },
        params: { host: "http://127.0.0.1:5173" },
      },
      { type: 6, phase: 1, source: { id: 9 }, params: { url: dict } },
      {
        type: 7,
        phase: 0,
        source: { id: 9 },
        params: { proxy_info: "SOCKS5 127.0.0.1:40000" },
      },
    ]),
    { blackholePort: 40000 },
  );
  assert.equal(clean.nonLoopbackAttempts, 0);
  assert.deepEqual(clean.loopbackConnects, { blackhole: 1, other: 1 });
  assert.deepEqual(clean.resolverJobs, {
    total: 3,
    rejected: 1,
    hosts: ["127.0.0.1", "grimodex-rule-sentinel.invalid"],
  });
  assert.deepEqual(clean.dictionaryRequests, [
    {
      url: "https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic",
      proxy: "SOCKS5 127.0.0.1:40000",
    },
  ]);
  const dirty = analyzeNetLog(
    netLog([
      { type: 2, phase: 1, params: { address: "142.250.0.1:443" } },
      { type: 3, phase: 1, params: { address: "[2001:db8::1]:443" } },
      { type: 4, phase: 1, params: { hostname: "example.com" } },
      { type: 5, phase: 1, params: { host: "https://github.com:443" } },
    ]),
  );
  assert.equal(dirty.nonLoopbackAttempts, 4);
  assert.deepEqual(
    dirty.attempts.map((row) => row.endpoint),
    ["142.250.0.1:443", "[2001:db8::1]:443", "example.com", "github.com"],
  );
  assert.throws(() => analyzeNetLog({ events: [] }), /constants/);
});

test("a net log cut by an abrupt exit is repaired and marked", () => {
  const whole = JSON.stringify(
    netLog([
      {
        type: 2,
        phase: 1,
        params: { address: "127.0.0.1:1", nested: { a: 1 } },
      },
      { type: 2, phase: 1, params: { address: "10.0.0.1:443" } },
    ]),
  );
  assert.equal(parseNetLogText(whole).truncated, false);
  const cut = whole.slice(0, whole.lastIndexOf('{"type":2'));
  const repaired = parseNetLogText(`${cut}{"type":2,"pha`);
  assert.equal(repaired.truncated, true);
  assert.equal(repaired.log.events.length, 1);
  assert.throws(() => parseNetLogText("not json"), /could not be repaired/);
});
