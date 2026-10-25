/**
 * CP-2b P2（K3/3 `nir1-d2a-activation-proposal/3` の Negative (34)。G-pub）の packaged smoke の net log の解析。
 *
 * Chromium の `--log-net-log=<file> --net-log-capture-mode=Everything` の出力を読む純関数だけを置く（製品に触れない）。
 * - 名前（(34)(ii)）: `HOST_RESOLVER_MANAGER_REQUEST`／`JOB` の host を NL の正規化（scheme・port・角括弧を外し小文字）で集める。
 *   URL 要求の event の host は数えない。正規化は `webrtc-block-probe.mjs` の `netLogAlerts` と同じ形。
 * - LS-1 の port: `PROXY_CONFIG_CHANGED` の `new_config.single_proxy` の `socks5://127.0.0.1:<port>`（1 つだけのときに採る）。
 * - LS-1 への接続: `TCP_CONNECT` の PHASE_BEGIN で `address_list` に `127.0.0.1:<port>` を含む event。時刻は
 *   `constants.timeTickOffset + time`（wall clock の ms）。Linux では Main の listener の実数と行ごとに一致した（cp2b-decisions §8.2）。
 * - 記録だけのもの（合否にしない）: NC-1 の所要の推定、辞書・更新の要求、辞書の要求と setProxy の順序（H9）。
 */
import { createHash } from "node:crypto";

/** net log の JSON。終了の途中で切れた file（末尾の `]}` が無い）も probe と同じ方法で読む */
export function parseNetLog(text) {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(String(text).replace(/,\s*$/, "") + "]}");
  }
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** NL の正規化（net log の host）。`https://~notfound`、`127.0.0.1:39035`、`[::1]:443` など */
export function normalizeNetLogHost(raw) {
  return String(raw)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/:\d+$/, "")
    .replace(/^\[(.*)\]$/, "$1")
    .toLowerCase();
}

function invert(map = {}) {
  return Object.fromEntries(Object.entries(map).map(([name, value]) => [value, name]));
}

function eventView(log) {
  const constants = log?.constants;
  if (!constants?.logEventTypes || !constants?.logEventPhase || !Array.isArray(log?.events)) {
    throw new Error("net log の形が不正（constants／events がない）");
  }
  const typeNames = invert(constants.logEventTypes);
  const phaseNames = invert(constants.logEventPhase);
  const sourceNames = invert(constants.logSourceType ?? {});
  const offset = Number(constants.timeTickOffset);
  if (!Number.isFinite(offset)) throw new Error("net log の timeTickOffset がない");
  return log.events.map((event) => ({
    type: typeNames[event.type] ?? `#${event.type}`,
    phase: phaseNames[event.phase] ?? `#${event.phase}`,
    source: sourceNames[event.source?.type] ?? `#${event.source?.type}`,
    sourceId: event.source?.id ?? null,
    at: offset + Number(event.time),
    params: event.params ?? {},
  }));
}

const LS1_PROXY_RE = /^\[?socks5:\/\/127\.0\.0\.1:(\d+)\]?$/;

/** LS-1 の候補の port（`PROXY_CONFIG_CHANGED` の single_proxy が socks5://127.0.0.1:<port> のもの）。重複を除く */
export function ls1PortsOf(events) {
  const ports = new Set();
  for (const event of events) {
    if (event.type !== "PROXY_CONFIG_CHANGED") continue;
    const single = event.params?.new_config?.single_proxy;
    for (const entry of Array.isArray(single) ? single : single ? [single] : []) {
      const match = LS1_PROXY_RE.exec(String(entry));
      if (match) ports.add(Number(match[1]));
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** LS-1 への接続の時刻（`TCP_CONNECT` の begin で、宛先が 127.0.0.1:<port>） */
export function ls1ConnectTimes(events, port) {
  if (!Number.isInteger(port)) return [];
  const target = `127.0.0.1:${port}`;
  return events
    .filter((event) => event.type === "TCP_CONNECT" && event.phase === "PHASE_BEGIN")
    .filter((event) => (event.params?.address_list ?? []).some((address) => String(address) === target))
    .map((event) => event.at)
    .sort((a, b) => a - b);
}

/**
 * NC-1 の所要の推定（記録だけ）。下限: LS-1 の `PROXY_CONFIG_CHANGED`（setProxy の適用）から、その後の network service の
 * host resolver の最初の 3 件の要求（自己確認 (a)(b): sentinel、EXCLUDE していない IP literal 2 件）の終わりまで。listener の起動と
 * `resolveProxy`（net log に出ない）を含まないので下限で、上限は harness の起動から窓の出現まで（run.mjs が別に記録する）。
 */
export function nc1NetworkPhase(events, port) {
  const proxyAt = events.find((event) => event.type === "PROXY_CONFIG_CHANGED"
    && ls1PortsOf([event]).includes(port))?.at ?? null;
  if (proxyAt == null) return { proxyConfigAt: null, selfCheckResolves: [], lowerBoundMs: null };
  const requests = new Map();
  for (const event of events) {
    if (event.at < proxyAt || event.at > proxyAt + 5000) continue;
    if (event.type !== "HOST_RESOLVER_MANAGER_REQUEST" || event.source !== "NETWORK_SERVICE_HOST_RESOLVER") continue;
    const entry = requests.get(event.sourceId) ?? { host: null, begin: null, end: null };
    if (event.phase === "PHASE_BEGIN") { entry.host = String(event.params?.host ?? ""); entry.begin = event.at; }
    if (event.phase === "PHASE_END") entry.end = event.at;
    requests.set(event.sourceId, entry);
  }
  const ordered = [...requests.values()].filter((entry) => entry.begin != null).sort((a, b) => a.begin - b.begin).slice(0, 3);
  const last = ordered.length === 3 && ordered.every((entry) => entry.end != null)
    ? Math.max(...ordered.map((entry) => entry.end))
    : null;
  return {
    proxyConfigAt: proxyAt,
    selfCheckResolves: ordered.map((entry) => ({ host: entry.host, offsetMs: entry.begin - proxyAt })),
    lowerBoundMs: last == null ? null : last - proxyAt,
  };
}

/**
 * net log の要約。nonce は記録に残す前に `<n>` に伏せる（probe と同じ表記）。
 * hostResolver は `judgeNl`／`judgeNlPositiveControl` が読む形（requestHosts／jobHosts／nonceBearing）。
 */
export function summarizeNetLog(log, { nonce = "" } = {}) {
  const events = eventView(log);
  const counts = { REQUEST: new Map(), JOB: new Map() };
  const raw = new Map();
  const timed = [];
  const urlRequests = [];
  for (const event of events) {
    const match = /^HOST_RESOLVER_MANAGER_(REQUEST|JOB)$/.exec(event.type);
    if (match && event.params?.host != null && event.phase !== "PHASE_END") {
      const host = String(event.params.host);
      const norm = normalizeNetLogHost(host);
      counts[match[1]].set(norm, (counts[match[1]].get(norm) ?? 0) + 1);
      raw.set(host, (raw.get(host) ?? 0) + 1);
      timed.push({ at: event.at, host: norm });
    }
    if (event.type === "URL_REQUEST_START_JOB" && event.params?.url) {
      urlRequests.push({ at: event.at, url: String(event.params.url).split("?")[0].slice(0, 160) });
    }
  }
  const mask = (value) => (nonce ? String(value).split(nonce).join("<n>") : String(value));
  const asObject = (map) => Object.fromEntries([...map.entries()].sort().map(([key, value]) => [mask(key), value]));
  const ports = ls1PortsOf(events);
  const port = ports.length === 1 ? ports[0] : null;
  const connects = ls1ConnectTimes(events, port);
  const proxyAt = port == null ? null : nc1NetworkPhase(events, port).proxyConfigAt;
  const dictionary = urlRequests.filter((request) => /gvt1\.com\/edgedl\/chrome\/dict\//.test(request.url));
  return {
    hostResolver: {
      requestHosts: asObject(counts.REQUEST),
      jobHosts: asObject(counts.JOB),
      rawRequestHosts: asObject(raw),
      nonceBearing: nonce ? [...raw.keys()].filter((key) => key.includes(nonce)).length : null,
    },
    ls1Ports: ports,
    ls1Port: port,
    ls1Connects: connects.length,
    nc1NetworkPhase: port == null ? null : nc1NetworkPhase(events, port),
    // 記録だけ: 辞書と更新の要求（URL の path まで。query は捨てる）、辞書の要求と setProxy の順序（H9）
    dictionaryRequests: dictionary.map((request) => ({ url: mask(request.url), offsetFromProxyMs: proxyAt == null ? null : request.at - proxyAt })),
    updateRequests: urlRequests.filter((request) => /github\.com|githubusercontent\.com/.test(request.url)).map((request) => mask(request.url)).slice(0, 20),
    h9: proxyAt == null || dictionary.length === 0
      ? null
      : { firstDictionaryOffsetFromProxyMs: dictionary[0].at - proxyAt, dictionaryBeforeProxy: dictionary[0].at < proxyAt },
    // 行ごとの帰属に使う（記録には残さない）
    _connectTimes: connects,
    _hostTimes: timed,
  };
}

/** 行の時間窓（startedAt〜endedAt）に入る LS-1 への接続の数 */
export function connectsInWindow(times, row) {
  return times.filter((at) => at >= row.startedAt && at <= row.endedAt).length;
}
