// CP-4 S1c-1: egress evidence of an Electron run (TASK §8, §13 P-9, §15.1;
// DR-CP4-S1C1-6).
//
// Two independent views:
//   - socket samples: every 20 s (and before/after the run) the sockets of
//     the Electron process tree (the Main pid and its descendants, the
//     C-query worker included) are read from /proc (`fd` → `socket:[inode]`,
//     joined with `net/{tcp,tcp6,udp,udp6}`). This sees traffic that does not
//     go through Chromium (Native reqwest, the Main's Node). Limit: a
//     connection opened and closed between two samples is not seen.
//   - the Chromium net log: connect attempts and resolver jobs that are not
//     loopback. K6/3's expected classes (the LS-1 blackhole connection and the
//     blackholed dictionary request) connect to loopback and are counted
//     apart, never as non-loopback attempts.
//
// The parsers and assessments are pure; `readProcessTree`,
// `sampleElectronSockets` and `startSocketSampler` read /proc only.

import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { WINDOW_SAMPLE_INTERVAL_MS } from "./constants.mjs";

export const SOCKET_SAMPLE_SCHEMA = "nir1-cp4-socket-sample/1";

const TCP_STATES = Object.freeze({
  "01": "established",
  "02": "syn-sent",
  "03": "syn-recv",
  "04": "fin-wait1",
  "05": "fin-wait2",
  "06": "time-wait",
  "07": "close",
  "08": "close-wait",
  "09": "last-ack",
  "0A": "listen",
  "0B": "closing",
});

function hexWordToBytes(word) {
  // /proc/net prints each 32-bit word in host (little-endian) order.
  const bytes = [];
  for (let at = 6; at >= 0; at -= 2)
    bytes.push(Number.parseInt(word.slice(at, at + 2), 16));
  return bytes;
}

/** `0100007F:1F90` (IPv4) or 32-hex IPv6 → `{ address, port }`. */
export function decodeProcAddress(text) {
  const match = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/u.exec(
    text,
  );
  if (!match) throw new Error(`[artifact] unparsable /proc address ${text}`);
  const [, hex, portHex] = match;
  const port = Number.parseInt(portHex, 16);
  if (hex.length === 8)
    return { family: 4, address: hexWordToBytes(hex).join("."), port };
  const bytes = [];
  for (let at = 0; at < 32; at += 8)
    bytes.push(...hexWordToBytes(hex.slice(at, at + 8)));
  const groups = [];
  for (let at = 0; at < 16; at += 2)
    groups.push(((bytes[at] << 8) | bytes[at + 1]).toString(16));
  return { family: 6, address: compressIpv6(groups), port };
}

function compressIpv6(groups) {
  let best = { at: -1, length: 0 };
  for (let at = 0; at < groups.length; ) {
    if (groups[at] !== "0") {
      at += 1;
      continue;
    }
    let end = at;
    while (end < groups.length && groups[end] === "0") end += 1;
    if (end - at > best.length) best = { at, length: end - at };
    at = end;
  }
  if (best.length < 2) return groups.join(":");
  const head = groups.slice(0, best.at).join(":");
  const tail = groups.slice(best.at + best.length).join(":");
  return `${head}::${tail}`;
}

/** Loopback: 127.0.0.0/8, ::1, and IPv4-mapped 127.x. */
export function isLoopbackAddress(address) {
  if (/^127\.\d+\.\d+\.\d+$/u.test(address)) return true;
  if (address === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address);
  if (mapped) return isLoopbackAddress(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/iu.exec(address);
  if (mappedHex) return Number.parseInt(mappedHex[1], 16) >> 8 === 127;
  return false;
}

export function isUnspecifiedAddress(address) {
  return address === "0.0.0.0" || address === "::";
}

/** Rows of one /proc/net/{tcp,tcp6,udp,udp6} table. */
export function parseProcNetTable(text, proto) {
  if (!["tcp", "udp"].includes(proto))
    throw new Error(`[artifact] unknown protocol ${proto}`);
  const rows = [];
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 10) continue;
    const local = decodeProcAddress(fields[1]);
    const remote = decodeProcAddress(fields[2]);
    rows.push({
      proto,
      family: local.family,
      local: { address: local.address, port: local.port },
      remote: { address: remote.address, port: remote.port },
      state:
        proto === "tcp"
          ? (TCP_STATES[fields[3].toUpperCase()] ?? `0x${fields[3]}`)
          : fields[3].toUpperCase() === "01"
            ? "connected"
            : "unconnected",
      inode: fields[9],
    });
  }
  return rows;
}

/**
 * One socket → `loopback` / `unconnected` (allowed) or `external` /
 * `external-listener` (violations). A TCP listener or an unconnected UDP
 * socket bound to a non-loopback address (wildcard included) is a listener
 * reachable from outside the host.
 */
export function classifySocket(row) {
  const remoteUnset =
    isUnspecifiedAddress(row.remote.address) && row.remote.port === 0;
  const isListener =
    (row.proto === "tcp" && row.state === "listen") ||
    (row.proto === "udp" && remoteUnset);
  if (isListener)
    return isLoopbackAddress(row.local.address)
      ? "loopback"
      : "external-listener";
  if (remoteUnset) return "unconnected";
  return isLoopbackAddress(row.remote.address) ? "loopback" : "external";
}

/** `/proc/<pid>/stat` → `{ pid, comm, ppid }` (comm may contain spaces). */
export function parseProcStat(text) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open)
    throw new Error("[artifact] unparsable /proc stat");
  const fields = text
    .slice(close + 2)
    .trim()
    .split(" ");
  return {
    pid: Number(text.slice(0, open).trim()),
    comm: text.slice(open + 1, close),
    ppid: Number(fields[1]),
  };
}

/** The root and its descendants from a pid → ppid map (breadth-first). */
export function descendantsOf(rootPid, parentOf) {
  if (!parentOf.has(rootPid)) return [];
  const children = new Map();
  for (const [pid, ppid] of parentOf) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const tree = [];
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    tree.push(pid);
    for (const child of (children.get(pid) ?? []).sort((a, b) => a - b))
      queue.push(child);
  }
  return tree;
}

/** `socket:[12345]` link targets → inodes. */
export function socketInodes(linkTargets) {
  const inodes = new Set();
  for (const target of linkTargets) {
    const match = /^socket:\[(\d+)\]$/u.exec(target);
    if (match) inodes.add(match[1]);
  }
  return inodes;
}

/** Zygote children rewrite their title, so cmdline may be space-joined. */
export function argvOfCmdline(text) {
  return text.split(/[\0 ]+/u).filter(Boolean);
}

/**
 * Builds one socket sample from what was read: the tree's pids with their
 * socket inodes, and the socket tables of their network namespace(s).
 */
export function buildSocketSample({ atMs, rootPid, processes, tables }) {
  const owner = new Map();
  for (const process of processes)
    for (const inode of process.socketInodes ?? []) owner.set(inode, process);
  const sample = {
    schema: SOCKET_SAMPLE_SCHEMA,
    atMs,
    rootPid,
    pids: processes.map((row) => row.pid),
    unreadable: processes
      .filter((row) => row.socketInodes === null)
      .map((row) => row.pid),
    sockets: { tcp: 0, udp: 0, loopback: 0, unconnected: 0 },
    external: [],
    externalListeners: [],
  };
  const seen = new Set();
  for (const row of tables) {
    const process = owner.get(row.inode);
    if (!process || seen.has(`${row.proto}:${row.inode}`)) continue;
    seen.add(`${row.proto}:${row.inode}`);
    sample.sockets[row.proto] += 1;
    const kind = classifySocket(row);
    const entry = {
      pid: process.pid,
      type: process.type ?? null,
      proto: row.proto,
      local: `${row.local.address}:${row.local.port}`,
      remote: `${row.remote.address}:${row.remote.port}`,
      state: row.state,
    };
    if (kind === "loopback") sample.sockets.loopback += 1;
    else if (kind === "unconnected") sample.sockets.unconnected += 1;
    else if (kind === "external") sample.external.push(entry);
    else sample.externalListeners.push(entry);
  }
  return sample;
}

function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The Electron process tree read from /proc (exe, Chromium type, ozone). */
export function readProcessTree(rootPid, procRoot = "/proc") {
  const parentOf = new Map();
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/u.test(entry)) continue;
    const stat = read(path.join(procRoot, entry, "stat"));
    if (stat === null) continue;
    try {
      parentOf.set(Number(entry), parseProcStat(stat).ppid);
    } catch {
      // exited while reading
    }
  }
  return descendantsOf(rootPid, parentOf).map((pid) => {
    const dir = path.join(procRoot, String(pid));
    const argv = argvOfCmdline(read(path.join(dir, "cmdline")) ?? "");
    let exe = null;
    let netns = null;
    try {
      exe = readlinkSync(path.join(dir, "exe"));
    } catch {
      // not readable (exited, or another user)
    }
    try {
      netns = readlinkSync(path.join(dir, "ns", "net"));
    } catch {
      // not readable
    }
    return {
      pid,
      ppid: parentOf.get(pid) ?? null,
      exe,
      netns,
      type:
        argv.find((arg) => arg.startsWith("--type="))?.slice(7) ?? "browser",
      ozonePlatform:
        argv.find((arg) => arg.startsWith("--ozone-platform="))?.slice(17) ??
        null,
    };
  });
}

/** Every Chromium child that names an ozone platform uses x11 (S1 import). */
export function assertX11Ozone(tree) {
  const platforms = [
    ...new Set(tree.map((row) => row.ozonePlatform).filter(Boolean)),
  ];
  if (platforms.length === 0)
    throw new Error(
      "[artifact] no Electron child process with --ozone-platform observed",
    );
  if (platforms.some((platform) => platform !== "x11"))
    throw new Error(
      `[precheck] Electron child processes use a visible ozone platform: ${platforms.join(",")}`,
    );
  return {
    processCount: tree.length,
    ozonePlatforms: platforms,
    types: [...new Set(tree.map((row) => row.type))].sort(),
  };
}

function readSocketInodes(pid, procRoot) {
  const dir = path.join(procRoot, String(pid), "fd");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const targets = [];
  for (const entry of entries) {
    try {
      targets.push(readlinkSync(path.join(dir, entry)));
    } catch {
      // closed while reading
    }
  }
  return [...socketInodes(targets)];
}

/** One socket sample of the Electron tree rooted at `rootPid`. */
export function sampleElectronSockets({
  rootPid,
  atMs = Date.now(),
  procRoot = "/proc",
}) {
  const tree = readProcessTree(rootPid, procRoot);
  const processes = tree.map((row) => ({
    ...row,
    socketInodes: readSocketInodes(row.pid, procRoot),
  }));
  const tables = [];
  const readNamespaces = new Set();
  for (const process of processes) {
    const key = process.netns ?? `pid:${process.pid}`;
    if (readNamespaces.has(key)) continue;
    readNamespaces.add(key);
    for (const [file, proto] of [
      ["tcp", "tcp"],
      ["tcp6", "tcp"],
      ["udp", "udp"],
      ["udp6", "udp"],
    ]) {
      const text = read(path.join(procRoot, String(process.pid), "net", file));
      if (text !== null) tables.push(...parseProcNetTable(text, proto));
    }
  }
  const sample = buildSocketSample({ atMs, rootPid, processes, tables });
  sample.processes = tree.map(({ pid, ppid, exe, type }) => ({
    pid,
    ppid,
    exe,
    type,
  }));
  return sample;
}

/**
 * Samples every `intervalMs` (20 s) until `stop()`, which takes the final
 * sample. The timer is unref'd and owned by the returned handle.
 */
export function startSocketSampler({
  rootPid,
  intervalMs = WINDOW_SAMPLE_INTERVAL_MS,
  sampleOnce = sampleElectronSockets,
  now = Date.now,
}) {
  const samples = [];
  const take = () => {
    try {
      samples.push(sampleOnce({ rootPid, atMs: now() }));
    } catch (error) {
      samples.push({
        schema: SOCKET_SAMPLE_SCHEMA,
        atMs: now(),
        rootPid,
        error: String(error?.message ?? error),
      });
    }
  };
  take();
  const timer = setInterval(take, intervalMs);
  timer.unref?.();
  let stopped = false;
  return {
    samples,
    stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        take();
      }
      return samples;
    },
  };
}

function sampleShapeErrors(sample, at) {
  const errors = [];
  if (sample?.schema !== SOCKET_SAMPLE_SCHEMA)
    errors.push(`socket sample ${at} has no ${SOCKET_SAMPLE_SCHEMA} schema`);
  if (typeof sample?.error === "string")
    errors.push(`socket sample ${at} failed: ${sample.error}`);
  if (!Number.isFinite(sample?.atMs))
    errors.push(`socket sample ${at} lacks atMs`);
  if (!Array.isArray(sample?.pids) || sample.pids.length === 0)
    errors.push(`socket sample ${at} saw no Electron process`);
  for (const field of ["external", "externalListeners", "unreadable"])
    if (!Array.isArray(sample?.[field]))
      errors.push(`socket sample ${at} lacks ${field}`);
  return errors;
}

/**
 * The socket samples cover the run (before, after, gaps at most twice the
 * 20 s interval), every sample read the tree, and none saw an external
 * connection or a listener reachable from outside the host.
 */
export function assessSocketSamples({ samples, run }) {
  const gaps = [];
  const violations = [];
  if (!Array.isArray(samples)) gaps.push("socket samples missing");
  const rows = Array.isArray(samples) ? samples : [];
  rows.forEach((sample, at) => gaps.push(...sampleShapeErrors(sample, at)));
  if (!Number.isFinite(run?.startedAtMs) || !Number.isFinite(run?.finishedAtMs))
    gaps.push("run start/finish times missing");
  if (gaps.length > 0) return { clean: false, violations, gaps };
  const sorted = [...rows].sort((a, b) => a.atMs - b.atMs);
  if (sorted.length < 2) gaps.push("fewer than two socket samples");
  else {
    if (sorted[0].atMs > run.startedAtMs)
      gaps.push("no socket sample before the run");
    if (sorted.at(-1).atMs < run.finishedAtMs)
      gaps.push("no socket sample after the run");
    for (let at = 1; at < sorted.length; at++)
      if (sorted[at].atMs - sorted[at - 1].atMs > 2 * WINDOW_SAMPLE_INTERVAL_MS)
        gaps.push(`socket samples ${at - 1} and ${at} are too far apart`);
  }
  for (const sample of sorted) {
    for (const entry of sample.external)
      violations.push(
        `external ${entry.proto} ${entry.local} -> ${entry.remote} (pid ${entry.pid}) at ${sample.atMs}`,
      );
    for (const entry of sample.externalListeners)
      violations.push(
        `listener reachable from outside ${entry.proto} ${entry.local} (pid ${entry.pid}) at ${sample.atMs}`,
      );
  }
  return {
    clean: violations.length === 0 && gaps.length === 0,
    violations,
    gaps,
  };
}

// ---- Chromium net log -------------------------------------------------------

/**
 * Parses a net log file. Chromium writes the closing `]}` only on a clean
 * shutdown; a log cut after the last complete event is repaired once and
 * marked `truncated`.
 */
export function parseNetLogText(text) {
  try {
    return { log: JSON.parse(text), truncated: false };
  } catch {
    // Cut back to the end of an earlier complete event; a "}," inside an
    // event's params fails to parse and moves further back.
    let cut = text.length;
    for (let tries = 0; tries < 64; tries++) {
      cut = text.lastIndexOf("},", cut - 1);
      if (cut < 0) break;
      try {
        return {
          log: JSON.parse(`${text.slice(0, cut + 1)}]}`),
          truncated: true,
        };
      } catch {
        // keep moving back
      }
    }
    throw new Error("[artifact] net log is not JSON and could not be repaired");
  }
}

function hostOf(endpoint) {
  const text = String(endpoint);
  const bracket = /^\[([^\]]+)\](?::\d+)?$/u.exec(text);
  if (bracket) return bracket[1];
  const v4 = /^(\d+\.\d+\.\d+\.\d+)(?::\d+)?$/u.exec(text);
  if (v4) return v4[1];
  return text;
}

const EXPECTED_RESOLVER_NAMES = new Set([
  "localhost",
  "grimodex-rule-sentinel.invalid",
]);

/**
 * Chromium's IPv6 reachability check: a UDP connect (a route lookup; no
 * datagram is sent) to this fixed address (disclosed in DA-1 and K3/3 as
 * Chromium's own traffic). Counted apart only when no byte was sent on it.
 */
export const IPV6_REACHABILITY_PROBE = "[2001:4860:4860::8888]:443";

/** A resolver request's host as Chromium logs it (scheme://host:port or host:port). */
function resolverHost(value) {
  const text = String(value);
  const url = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/:]+)(?::\d+)?/iu.exec(
    text,
  );
  const host = url
    ? url[1]
    : /^\[[^\]]+\](?::\d+)?$/u.test(text)
      ? text.replace(/(?<=\]):\d+$/u, "")
      : text.replace(/:\d+$/u, "");
  return host.replace(/^\[|\]$/gu, "");
}

const DICTIONARY_URL =
  /^https?:\/\/[^/]*\.gvt1\.com\/edgedl\/chrome\/dict\/[^/?#]+\.bdic(?:[?#].*)?$/u;
const RESOLVER_EVENTS = new Set([
  "HOST_RESOLVER_MANAGER_REQUEST",
  "HOST_RESOLVER_MANAGER_JOB",
]);
const BYTES_SENT_EVENTS = new Set(["UDP_BYTES_SENT", "SOCKET_BYTES_SENT"]);

/** Sources reachable from `roots` through `source_dependency` links. */
function dependentSources(events, roots) {
  const owner = new Map([...roots].map((id) => [id, id]));
  for (let changed = true, rounds = 0; changed && rounds < 16; rounds++) {
    changed = false;
    for (const event of events) {
      const from = owner.get(event.source?.id);
      const to = event.params?.source_dependency?.id;
      if (from !== undefined && to !== undefined && !owner.has(to)) {
        owner.set(to, from);
        changed = true;
      }
    }
  }
  return owner;
}

/**
 * Classifies one net log. `nonLoopbackAttempts` counts connect attempts
 * (TCP / UDP) to a non-loopback address, DNS transactions of Chromium's own
 * resolver, and resolver requests for a name that the NC-1 rules did not
 * reject (`~NOTFOUND`) and that is not loopback, the sentinel or `localhost`
 * (such a name reaches the system resolver). Chromium's IPv6 reachability
 * check is counted apart (`ipv6ReachabilityProbe`) unless bytes were sent on
 * it. Loopback connects are split into the LS-1 blackhole port (K6/3 (a))
 * and the rest; dictionary URL requests (K6/3 (b)) are listed with the proxy
 * they resolved to and their final error.
 */
export function analyzeNetLog(log, { blackholePort = null } = {}) {
  const names = Object.fromEntries(
    Object.entries(log?.constants?.logEventTypes ?? {}).map(([name, id]) => [
      id,
      name,
    ]),
  );
  if (Object.keys(names).length === 0)
    throw new Error("[artifact] net log lacks its event type constants");
  const events = log.events ?? [];
  const attempts = [];
  const loopback = { blackhole: 0, other: 0 };
  const resolverHosts = [];
  const probeSources = new Map();
  let reachabilityChecks = 0;
  const dictionaryIds = new Map();
  for (const event of events) {
    const name = names[event.type];
    const params = event.params ?? {};
    const endpoints = [];
    if (
      (name === "TCP_CONNECT_ATTEMPT" || name === "UDP_CONNECT") &&
      params.address
    )
      endpoints.push(params.address);
    if (name === "TCP_CONNECT" && Array.isArray(params.address_list))
      endpoints.push(...params.address_list);
    for (const endpoint of endpoints) {
      const host = hostOf(endpoint);
      if (isLoopbackAddress(host)) {
        const port = Number(/:(\d+)$/u.exec(String(endpoint))?.[1]);
        if (blackholePort !== null && port === blackholePort)
          loopback.blackhole += 1;
        else loopback.other += 1;
      } else if (
        name === "UDP_CONNECT" &&
        String(endpoint) === IPV6_REACHABILITY_PROBE
      )
        probeSources.set(event.source?.id, String(endpoint));
      else attempts.push({ event: name, endpoint: String(endpoint) });
    }
    if (name === "HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK")
      reachabilityChecks += 1;
    if (name === "DNS_TRANSACTION" && event.phase === 1)
      attempts.push({
        event: name,
        endpoint: String(params.hostname ?? "dns"),
      });
    if (RESOLVER_EVENTS.has(name) && params.host !== undefined) {
      const host = resolverHost(params.host);
      const rejected = /^~notfound$/iu.test(host);
      resolverHosts.push(rejected ? "~NOTFOUND" : host);
      if (
        !rejected &&
        !isLoopbackAddress(host) &&
        !EXPECTED_RESOLVER_NAMES.has(host)
      )
        attempts.push({ event: name, endpoint: host });
    }
    if (
      name === "URL_REQUEST_START_JOB" &&
      event.phase === 1 &&
      DICTIONARY_URL.test(String(params.url ?? ""))
    )
      dictionaryIds.set(
        event.source?.id,
        String(params.url).replace(/[?#].*$/u, ""),
      );
  }
  let ipv6ReachabilityProbe = 0;
  for (const [id, endpoint] of probeSources) {
    const sent = events.some(
      (event) =>
        event.source?.id === id && BYTES_SENT_EVENTS.has(names[event.type]),
    );
    if (sent) attempts.push({ event: "UDP_CONNECT+sent", endpoint });
    else ipv6ReachabilityProbe += 1;
  }
  const owner = dependentSources(events, dictionaryIds.keys());
  const dictionaryRequests = new Map(
    [...dictionaryIds].map(([id, url]) => [
      id,
      { url, proxy: null, netError: null },
    ]),
  );
  for (const event of events) {
    const request = dictionaryRequests.get(owner.get(event.source?.id));
    if (!request) continue;
    const name = names[event.type];
    const params = event.params ?? {};
    if (
      name === "PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST" &&
      params.proxy_info !== undefined
    )
      request.proxy ??= String(params.proxy_info);
    if (
      dictionaryIds.has(event.source?.id) &&
      name === "URL_REQUEST_START_JOB" &&
      event.phase === 2 &&
      params.net_error !== undefined
    )
      request.netError = params.net_error;
  }
  return {
    eventCount: events.length,
    nonLoopbackAttempts: attempts.length,
    attempts,
    ipv6ReachabilityProbe,
    ipv6ReachabilityChecks: reachabilityChecks,
    loopbackConnects: loopback,
    resolverRequests: {
      total: resolverHosts.length,
      rejected: resolverHosts.filter((host) => host === "~NOTFOUND").length,
      hosts: [
        ...new Set(resolverHosts.filter((host) => host !== "~NOTFOUND")),
      ].sort(),
    },
    dictionaryRequests: [...dictionaryRequests.values()],
  };
}
