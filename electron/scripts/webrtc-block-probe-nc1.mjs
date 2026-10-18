/**
 * NC-1（K3/3 `nir1-d2a-activation-proposal/3`。NC-1 の lane、S3）の G-open の記録を判定する道具。
 *
 * `webrtc-block-probe-verdict.mjs`（測定の記録の写し。行ごとの合否 RJ）に足りない判定を持つ。RJ の述語は変えず、
 * draft が別の述語として定めているものだけをここに置く:
 *   - `.local` の規則（`judgeLocalRule`）: 対照（閉じ込めなし）で UDP 5353 の問合せが >0 のときだけ、最終構成で 0 を要求する
 *   - 名前の漏れ NL（`judgeNl`）と、その正の対照（`judgeNlPositiveControl`）
 *   - Positive (9)(i)(ii)(iii)(v)（`judgePositive9`）
 *   - (30b) listener の頑健性（`judgeChurn`）、再読込・遷移の後の localhost の持続（`judgeReloadRows`）
 *   - (33) 更新と env の proxy（`judgeUpdaterEnvProxy`）
 *   - 起動順序と辞書の要求（`judgeStartupOrder`。`webrtc-block-probe-order.mjs` の出力）
 *   - 実機の観測（`judgeNcSession`、`judgeNcPolicy`、`judgeDevTools`）
 *   - 合成の記録（`synthesizeLeaks`、`synthesizeHintNotInBaseline`、`synthesizeFqdnLeaks`）: 判定が赤になることの対照
 *
 * すべて純粋な関数で、記録の JSON を読むだけ（製品に触れない）。CI には入れない（引き継ぎ H3）。
 */
import { classify } from "./webrtc-block-probe-verdict.mjs";

/** NL の許容集合 A（draft の「名前の漏れ（NL）の定義」）。正規化は小文字、末尾 dot なし */
export const NL_ALLOWED_NAMES = Object.freeze([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "localhost",
  "grimodex-rule-sentinel.invalid",
  "127.0.0.1",
]);
/** net log に限って許容（rules が拒否した名前の書換え先） */
export const NL_NETLOG_ONLY = "~notfound";
/** DoH の canary の qname に限って許容（Chromium の到達性確認。固定名で攻撃者が選べない） */
export const NL_DOH_ONLY = "www.gstatic.com";

const NONCE_MARK = "<n>";

const clone = (value) => JSON.parse(JSON.stringify(value));
const rowsOf = (record) => record?.rows ?? [];
const rowById = (record, id) => rowsOf(record).find((row) => row.id === id);

export function normalizeResolvedName(name) {
  return String(name).replace(/\[rc0\]$/, "").replace(/\.$/, "").toLowerCase();
}

// ── .local の規則 ─────────────────────────────────────────────────────────

/** `.local` の行（道具の classify が `mdns` を返す行）の id */
export function mdnsRowIds(record) {
  return rowsOf(record).filter((row) => classify(row).kind === "mdns").map((row) => row.id);
}

const queriesOver = (record, ids) => ids.reduce((sum, id) => sum + (rowById(record, id)?.mdnsQueries ?? 0), 0);

/**
 * draft の `.local` の規則（合否はここだけ）: 同じ環境のベースラインで `.local` の問合せ（UDP 5353 の multicast）が >0 と
 * 観測できた（対照が取れた）ときだけ、最終構成で 0 であることを合否に含める。ベースラインで >0 を観測できない環境では、
 * 合否から外して「未検証」として記録に残し、G-pub の 3 OS の packaged smoke で同じ規則により確かめる。
 * 戻り値の status: "pass" | "fail" | "unverified"
 */
export function judgeLocalRule(record, baseline) {
  const ids = mdnsRowIds(baseline);
  if (ids.length === 0) {
    return { status: "unverified", reason: "ベースラインに .local の行がない", baselineQueries: 0, finalQueries: null };
  }
  const baselineQueries = queriesOver(baseline, ids);
  if (!baseline?.mdns?.joined || baselineQueries <= 0) {
    return {
      status: "unverified",
      reason: baseline?.mdns?.joined
        ? "ベースラインで .local の問合せ（UDP 5353）を観測できない（対照が取れない）"
        : `ベースラインで UDP 5353 の multicast に参加できない（${baseline?.mdns?.error ?? "mdns の観測なし"}）`,
      baselineQueries,
      finalQueries: null,
    };
  }
  if (!record?.mdns?.joined) {
    return { status: "unverified", reason: "最終構成の記録で UDP 5353 の multicast に参加できていない", baselineQueries, finalQueries: null };
  }
  const finalIds = mdnsRowIds(record);
  const missing = ids.filter((id) => !finalIds.includes(id));
  const finalQueries = queriesOver(record, finalIds);
  const totalNonce = record.mdns.nonceBearing ?? 0;
  if (missing.length > 0) {
    return { status: "fail", reason: `最終構成の記録に .local の行がない: ${missing.join(", ")}`, baselineQueries, finalQueries };
  }
  if (finalQueries > 0 || totalNonce > 0) {
    return { status: "fail", reason: `最終構成で .local の問合せ ${Math.max(finalQueries, totalNonce)} 件（期待は 0）`, baselineQueries, finalQueries };
  }
  return { status: "pass", reason: "対照で観測した .local の問合せが最終構成で 0", baselineQueries, finalQueries };
}

// ── 名前の漏れ NL ─────────────────────────────────────────────────────────

/**
 * NL の述語（draft の「名前の漏れ（NL）の定義」）。観測する host: getaddrinfo の記録層（`dnsAll`）、DoH の canary の qname
 * （`dohAll`）、net log の host resolver の host（`netLog.hostResolver`）。観測した host の正規化した集合が許容集合 A の内側で、
 * nonce を含む名前が 0 ならば合格。観測していない channel（null）は集合に入れず `channels` に出す。
 */
export function judgeNl(record) {
  const allowed = new Set(NL_ALLOWED_NAMES);
  const outside = [];
  const channels = {};
  const check = (channel, names, extraAllowed) => {
    if (names == null) { channels[channel] = null; return; }
    channels[channel] = names.length;
    for (const raw of names) {
      const name = channel === "netLog" ? String(raw).toLowerCase() : normalizeResolvedName(raw);
      if (String(raw).includes(NONCE_MARK) || (!allowed.has(name) && name !== extraAllowed)) outside.push(`${channel}:${raw}`);
    }
  };
  check("getaddrinfo", record?.dnsAll ?? null, undefined);
  check("doh", record?.dohAll ?? null, NL_DOH_ONLY);
  const hostResolver = record?.netLog?.hostResolver ?? null;
  check("netLog", hostResolver ? [...new Set([...Object.keys(hostResolver.requestHosts ?? {}), ...Object.keys(hostResolver.jobHosts ?? {})])] : null, NL_NETLOG_ONLY);
  const nonceBearing = hostResolver?.nonceBearing ?? 0;
  if (nonceBearing > 0) outside.push(`netLog:nonce を含む生の host ${nonceBearing} 件`);
  return { pass: outside.length === 0, outside, channels };
}

/** 正の対照で名前の観測を要求するカテゴリ（行 id の形） */
export const NL_POSITIVE_CATEGORIES = Object.freeze({
  stun: /^main\.stun\.name$/,
  "turn-udp": /^main\.turn-udp\.name$/,
  "turn-tcp": /^main\.turn-tcp\.name$/,
  turns: /^main\.turns\.name$/,
  "dns-prefetch": /^dns\.dns-prefetch$/,
  "fqdn-remote-candidate": /^main\.remote-candidate-(udp|tcp)\.fqdn/,
});

/**
 * 正の対照: 閉じ込めなしの記録で、STUN／TURN-UDP／TURN-TCP／TURNS／dns-prefetch と FQDN の remote candidate の
 * 各名前が観測されること（観測されなければ試験の欠陥）。channel: "getaddrinfo"（行の dnsNames）| "doh"（行の dohNames）|
 * "netLog"（行ごとの net log はないので、nonce を含む生の host の件数）。require で要求するカテゴリを絞れる
 * （nl の行列は FQDN の行を持たない）。
 */
export function judgeNlPositiveControl(baseline, channel, { require = Object.keys(NL_POSITIVE_CATEGORIES) } = {}) {
  if (channel === "netLog") {
    const count = baseline?.netLog?.hostResolver?.nonceBearing ?? 0;
    return { ok: count > 0, channel, missing: count > 0 ? [] : ["nonce を含む生の host が 0 件"], observed: count };
  }
  const key = channel === "doh" ? "dohNames" : "dnsNames";
  const missing = [];
  const observed = {};
  for (const category of require) {
    const pattern = NL_POSITIVE_CATEGORIES[category];
    const rows = rowsOf(baseline).filter((row) => pattern.test(row.id));
    const seen = rows.some((row) => (row[key] ?? []).some((name) => String(name).includes(NONCE_MARK)));
    observed[category] = seen;
    if (!seen) missing.push(category);
  }
  return { ok: missing.length === 0, channel, missing, observed };
}

// ── Positive (9) ──────────────────────────────────────────────────────────

const SELF_CHECK_PROXY_URLS = ["https://turn.attacker.invalid:443/", "https://example.invalid:8443/", "http://127.0.0.1:1/"];

/**
 * Positive (9)(i)(ii)(iii)(v) の記録での確認。(vi) は単体試験（`rendererContainment.test.ts`）、(iv) は journey。
 *  (i) `app://bundle` の `fetch('/…')` が 200、同梱の worker が `worker-ok`
 *  (ii) 自己確認と同じ観測: 製品の start() が成功（失敗の固定コードなし）、sentinel が 127.0.0.1、EXCLUDE していない IP literal が
 *       ERR_NAME_NOT_RESOLVED、resolveProxy の固定の URL が SOCKS5 127.0.0.1:<port>
 *  (iii) Main の Node の fetch が 200
 *  (v) Main から loopback の受信 socket への接続が通る
 */
export function judgePositive9(record) {
  const failures = [];
  const outcome = (id) => rowById(record, id)?.outcome;
  if (outcome("control.same-origin-fetch") !== "status:200") failures.push(`(i) fetch('/index.html') が 200 でない: ${outcome("control.same-origin-fetch")}`);
  if (!String(outcome("control.bundled-worker") ?? "").startsWith("worker-ok")) failures.push(`(i) 同梱の worker が worker-ok でない: ${outcome("control.bundled-worker")}`);
  if (outcome("main.node-fetch") !== "200") failures.push(`(iii) Main の Node の fetch が 200 でない: ${outcome("main.node-fetch")}`);
  if (outcome("main.node-fetch.loopback-socket") !== "connected") failures.push(`(v) Main から loopback の受信 socket への接続が通っていない: ${outcome("main.node-fetch.loopback-socket")}`);
  if (!(record?.totals?.ctlHits >= 1)) failures.push("(v) loopback の受信 socket が接続を受けていない（totals.ctlHits）");
  const events = record?.events ?? [];
  if (!events.some((event) => /^nc1 orchestrator start => true/.test(event))) failures.push("(ii) 製品の start() が成功していない（events に 'nc1 orchestrator start => true' がない）");
  if ((record?.nc1?.failures ?? []).length > 0) failures.push(`(ii) 固定コードが出ている: ${record.nc1.failures.join(" | ")}`);
  const find = (prefix) => events.find((event) => event.startsWith(prefix));
  const sentinel = find("resolveHost(grimodex-rule-sentinel.invalid) =>");
  if (!sentinel || !/\["127\.0\.0\.1"\]$/.test(sentinel)) failures.push(`(ii) sentinel の resolveHost が 127.0.0.1 でない: ${sentinel}`);
  for (const literal of ["1.1.1.1", "127.0.0.2"]) {
    const line = find(`resolveHost(${literal}) =>`);
    if (!line || !/ERR_NAME_NOT_RESOLVED/.test(line)) failures.push(`(ii) resolveHost(${literal}) が ERR_NAME_NOT_RESOLVED でない: ${line}`);
  }
  const port = record?.nc1?.listenerPort;
  for (const url of SELF_CHECK_PROXY_URLS) {
    const line = find(`resolveProxy(${url}) =>`);
    if (!line || !line.endsWith(`=> SOCKS5 127.0.0.1:${port}`)) failures.push(`(ii) resolveProxy(${url}) が SOCKS5 127.0.0.1:${port} でない: ${line}`);
  }
  return { pass: failures.length === 0, failures };
}

// ── (29) 外した機構ごとの期待カテゴリ ─────────────────────────────────────────

const TCP_PROTO_RE = "(turn-tcp|turns|turns-tcp)";
const UDP_PROTO_RE = "(stun|stuns|turn-udp)";
const exactRows = (proto, form) => new RegExp(`^main\\.${proto}\\.${form}$`);
const need = (pattern, min = 1) => ({ pattern, min });

/**
 * draft の (29) の表: 機構を 1 つ外した構成で漏れるカテゴリ。`direction` は漏れた行の種類（classify の kind）がすべてこの方向に限ること
 * （表にない方向が漏れたら閉じ込めの欠陥）、`required` は min 件以上 canary に届かなければならない行（試験の欠陥でないことの証拠）、
 * `forbidden` は届いてはならない行（その機構が担う層ではないカテゴリ）。
 *   proxy       TCP だけ。sentinel 名の TURN-TCP／TURNS／TURNS-TCP と、loopback の IP literal の TCP（production の rules では prefix の名前でなく literal）
 *   policy      UDP だけ。IP literal の UDP と udp の remote candidate（名前の UDP と FQDN の UDP は (23a) の形の `extraRequired`）
 *   neg-loopback TCP だけ。loopback の IP literal と `localhost` 名の TCP、IP literal の remote candidate。名前（sentinel）の TCP は SOCKS5 が名前を proxy 側へ渡すため漏れない
 */
export const CONTROL_CATEGORIES = Object.freeze({
  proxy: {
    direction: "tcp",
    required: [need(exactRows(TCP_PROTO_RE, "sentinel"), 3), need(exactRows("turn-tcp", "lo4")), need(/^main\.remote-candidate-tcp\.lo4$/)],
    forbidden: [],
  },
  policy: {
    direction: "udp",
    required: [need(exactRows("stun", "lo4")), need(exactRows("turn-udp", "lo4")), need(/^main\.remote-candidate-udp\.lo4$/)],
    forbidden: [],
  },
  "neg-loopback": {
    direction: "tcp",
    required: [need(exactRows("turn-tcp", "lo4")), need(exactRows("turn-tcp", "localhost")), need(/^main\.remote-candidate-tcp\.lo4$/)],
    forbidden: [exactRows(TCP_PROTO_RE, "sentinel")],
  },
});

/**
 * (29): 機構を外した構成の記録が、その機構のカテゴリの漏れを行 id で示していること。
 * `extraRequired` は構成の形ごとの追加（(23a) の形の名前の UDP／TCP、FQDN の remote candidate など。行 id の配列）。
 * 戻り値の `leakedIds` は canary に届いた行（記録の leaked > 0）。
 */
export function judgeControlCategories(record, mechanism, { extraRequired = [] } = {}) {
  const spec = CONTROL_CATEGORIES[mechanism];
  if (!spec) return { pass: false, failures: [`未知の機構: ${mechanism}`], leakedIds: [] };
  const failures = [];
  const leaked = rowsOf(record).filter((row) => row.leaked > 0);
  const leakedIds = leaked.map((row) => row.id);
  for (const row of leaked) {
    const kind = classify(row).kind;
    if (kind !== spec.direction) failures.push(`${row.id}: ${spec.direction} 以外の種類（${kind}）が漏れた（表にないカテゴリ）`);
  }
  for (const { pattern, min } of spec.required) {
    const matched = leaked.filter((row) => pattern.test(row.id));
    if (matched.length < min) failures.push(`${pattern} に当たる行が canary に届いていない（${matched.length} 件。${min} 件以上を期待）`);
  }
  for (const id of extraRequired) {
    if (!leakedIds.includes(id)) failures.push(`${id} が canary に届いていない（期待したカテゴリ）`);
  }
  for (const pattern of spec.forbidden) {
    const hit = leaked.filter((row) => pattern.test(row.id)).map((row) => row.id);
    if (hit.length > 0) failures.push(`${pattern} に当たる行が漏れた（この機構のカテゴリではない）: ${hit.join(", ")}`);
  }
  return { pass: failures.length === 0, failures, leakedIds };
}

// ── 近い名前・特殊な literal の resolveHost（Negative (23) の `al0-nearnames` の形）────────────────

/**
 * 製品の rules（`buildHostResolverRules()`）の下で、RS-1 の `EXCLUDE` が部分一致・サブドメイン・末尾 dot に効かないこと（名前は
 * `ERR_NAME_NOT_RESOLVED`）と、別形式の loopback が `127.0.0.1` に正規化されること、sentinel 名と `127.0.0.1` 自身が `127.0.0.1` に解決されることを、
 * `resolveHost` の events で固定する。将来 RS-1 の規則が glob 化されたり Chromium の版上げで `EXCLUDE` の一致が変わると、ここが赤になる。
 * `github.com.`／`localhost.`（末尾 dot）は EXCLUDE に一致せず拒否される（draft の「末尾 dot つきの事前解決は EXCLUDE に一致しない」の挙動）。
 */
export const NEARNAMES_EXPECTED = Object.freeze({
  "gvt1.com": "ERR_NAME_NOT_RESOLVED",
  "xgvt1.com": "ERR_NAME_NOT_RESOLVED",
  "a.gvt1.com": "ERR_NAME_NOT_RESOLVED",
  "a.b.github.com": "ERR_NAME_NOT_RESOLVED",
  "github.com.": "ERR_NAME_NOT_RESOLVED",
  "github.com.evil.test": "ERR_NAME_NOT_RESOLVED",
  "evil.release-assets.githubusercontent.com": "ERR_NAME_NOT_RESOLVED",
  "api.github.com": "ERR_NAME_NOT_RESOLVED",
  "x.localhost": "ERR_NAME_NOT_RESOLVED",
  "localhost.": "ERR_NAME_NOT_RESOLVED",
  "foo.local": "ERR_NAME_NOT_RESOLVED",
  "[::1]": "ERR_NAME_NOT_RESOLVED",
  "169.254.169.254": "ERR_NAME_NOT_RESOLVED",
  "127.1": "127.0.0.1",
  "0x7f.0.0.1": "127.0.0.1",
  "2130706433": "127.0.0.1",
  "127.0.0.1.": "127.0.0.1",
  "127.0.0.1": "127.0.0.1",
  "grimodex-rule-sentinel.invalid": "127.0.0.1",
});

export function judgeNearNames(record) {
  const failures = [];
  const events = (record?.events ?? []).map(String);
  if (!events.some((event) => /^nc1 orchestrator start => true/.test(event))) failures.push("製品の start() が成功していない（events に 'nc1 orchestrator start => true' がない）");
  if ((record?.nc1?.failures ?? []).length > 0) failures.push(`固定コードが出ている: ${record.nc1.failures.join(" | ")}`);
  const observed = {};
  for (const [name, expected] of Object.entries(NEARNAMES_EXPECTED)) {
    const prefix = `resolveHost(${name}) => `;
    const line = events.find((event) => event.startsWith(prefix));
    if (line === undefined) { failures.push(`${name}: resolveHost の観測がない`); continue; }
    const out = line.slice(prefix.length);
    observed[name] = out;
    const ok = expected === "127.0.0.1" ? out === '["127.0.0.1"]' : (out.startsWith("error:") && out.includes(expected));
    if (!ok) failures.push(`${name}: ${expected} を期待したが ${out}`);
  }
  return { pass: failures.length === 0, failures, observed };
}

// ── (30b) listener の頑健性 ───────────────────────────────────────────────

/** LS-1 の確認済みの同時接続の上限 */
const LS1_MAX = 256;

/**
 * (30b): RTCPeerConnection の開閉の反復で、窓が生きたまま（Main が終了せず、未処理例外なし）、上限超過の切断が続く間も
 * canary 0。`exercised` は上限超過の切断が実際に起きたか（起きなければ試験が listener の上限を叩けていない）。
 */
export function judgeChurn(record) {
  const failures = [];
  const churn = rowById(record, "main.turn-tcp.churn");
  const after = rowById(record, "main.turn-tcp.after-churn");
  if (!churn) failures.push("churn の行がない");
  else {
    if (!String(churn.outcome).startsWith("churn:")) failures.push(`churn の行が完了していない: ${churn.outcome}`);
    if (churn.leaked !== 0) failures.push(`churn の間に canary へ ${churn.leaked} 件到達`);
    if (!(churn.proxied >= 1)) failures.push("churn の間に listener への接続が 0");
  }
  if (!after) failures.push("churn の後の行がない");
  else {
    if (after.leaked !== 0) failures.push(`churn の後に canary へ ${after.leaked} 件到達`);
    if (!(after.proxied >= 1)) failures.push("churn の後の新しい接続が listener に届いていない");
  }
  const nc1 = record?.nc1;
  const exercised = (nc1?.overLimit ?? 0) > 0;
  if (!exercised) failures.push("上限（256）を超える接続の切断が起きていない（試験が listener の上限を叩けていない）");
  if ((nc1?.maxActive ?? 0) > LS1_MAX) failures.push(`同時の接続が ${nc1.maxActive} 件（上限 ${LS1_MAX} を超えた）`);
  if ((nc1?.uncaught ?? []).length > 0) failures.push(`未処理例外 ${nc1.uncaught.length} 件`);
  if (record?.extra?.afterChurn?.evalResult !== 2 || record?.extra?.afterChurn?.crashed) failures.push(`churn の後に窓が応答しない: ${JSON.stringify(record?.extra?.afterChurn)}`);
  if (record?.exit?.code !== 0) failures.push(`Main の終了コードが 0 でない: ${JSON.stringify(record?.exit)}`);
  if ((record?.totals?.canaryHits ?? 0) > 0) failures.push(`記録全体で canary 到達 ${record.totals.canaryHits} 件`);
  return { pass: failures.length === 0, failures, exercised, overLimit: nc1?.overLimit ?? 0, maxActive: nc1?.maxActive ?? 0 };
}

const PERSIST_PROTOS = ["stun", "turn-udp", "turn-tcp", "turns"];

/** 再読込・遷移の後の localhost の TURN／STUN（policy と proxy の持続）。最終は canary 0 と TCP の proxy 宛、対照は TCP が canary に届く */
export function judgeReloadRows(record, baseline) {
  const failures = [];
  for (const tag of ["reload", "nav"]) {
    for (const proto of PERSIST_PROTOS) {
      const id = `main.${proto}.${tag}-localhost`;
      const row = rowById(record, id);
      if (!row) { failures.push(`${id} の行がない`); continue; }
      if (row.leaked !== 0) failures.push(`${id}: canary へ ${row.leaked} 件到達`);
      if ((proto === "turn-tcp" || proto === "turns") && !(row.proxied >= 1)) failures.push(`${id}: listener への接続が 0`);
      if ((proto === "stun" || proto === "turn-udp") && !["gathering:complete", "ice:new"].includes(row.outcome)) failures.push(`${id}: ICE が止まった形でない（${row.outcome}）`);
    }
  }
  if (baseline) {
    const control = ["reload", "nav"].map((tag) => rowById(baseline, `main.turn-tcp.${tag}-localhost`));
    if (!control.every((row) => row && row.leaked > 0)) failures.push("対照（閉じ込めなし）で再読込・遷移の後の localhost の TURN-TCP が canary に届いていない（対照が成立しない）");
  }
  return { pass: failures.length === 0, failures };
}

// ── (33) 更新と env の proxy ──────────────────────────────────────────────

/**
 * (33): AL-0 の構成で取り直した `w0`〜`w5` の形。決定的な合否は local の模擬 proxy 上の観測（外部網に依存しない）。
 *  form "localhost" | "127.0.0.1" | "baseline": 更新の確認が proxy に `CONNECT github.com:443` として届く（正の対照を含む）
 *  form "lan" | "hostname": `ERR_PROXY_CONNECTION_FAILED` で止まり、proxy への接続が 0
 */
export function judgeUpdaterEnvProxy(record, form) {
  const failures = [];
  const connects = record?.envProxyConnects ?? [];
  const githubConnects = connects.filter((line) => /^CONNECT github\.com:443\b/.test(line));
  const check = rowById(record, "main.real-electron-updater-check");
  if (!check) failures.push("更新の確認の行（main.real-electron-updater-check）がない");
  if (form === "localhost" || form === "127.0.0.1" || form === "baseline") {
    if (githubConnects.length < 1) failures.push(`proxy に CONNECT github.com:443 が届いていない: ${JSON.stringify(connects)}`);
  } else if (form === "lan" || form === "hostname") {
    if (connects.length !== 0) failures.push(`proxy への接続が 0 でない: ${JSON.stringify(connects)}`);
    if (!/ERR_PROXY_CONNECTION_FAILED/.test(String(check?.outcome))) failures.push(`更新の確認が ERR_PROXY_CONNECTION_FAILED でない: ${check?.outcome}`);
  } else {
    failures.push(`未知の form: ${form}`);
  }
  if ((record?.totals?.canaryHits ?? 0) > 0) failures.push(`canary 到達 ${record.totals.canaryHits} 件`);
  return { pass: failures.length === 0, failures };
}

// ── 起動順序と辞書の要求 ──────────────────────────────────────────────────

const ORDER_SEQUENCE = [
  "appendSwitch host-resolver-rules (before ready)",
  "registerSecurityHandlers (before ready)",
  "registerWebContentsPolicy (before ready)",
  "nc1 start begin",
  "defaultSession first touch",
  "setProxy start",
  "setProxy done",
  "closeAllConnections done",
  "nc1 start done",
  "applySessionPermissionPolicy done",
  "installProductDownloadGuard done",
  "registerAppProtocolHandler done",
  "BrowserWindow created",
  "window loaded",
];

/**
 * `webrtc-block-probe-order.mjs`（mode product-nc1）の出力の判定。ready からの経過 ms の印で:
 *  - appendSwitch、registerSecurityHandlers、registerWebContentsPolicy が ready の前（0 以下）
 *  - default session の最初の接触が NC-1 の setProxy（`defaultSession first touch` が `setProxy start` の直前で、
 *    applySessionPermissionPolicy／installProductDownloadGuard／registerAppProtocolHandler はその後）
 *  - NC-1 の完了が最初の窓の作成より前
 *  - 辞書の要求が `setProxy` の完了後に始まり、blackhole（SOCKS5 127.0.0.1:<port>）へ向き、env の proxy に届かず、辞書は取得されない
 */
export function judgeStartupOrder(orderResult) {
  const failures = [];
  const rows = orderResult?.rows ?? [];
  if (rows.length === 0) failures.push("実行の記録がない");
  rows.forEach((row, index) => {
    const marks = row.nc1Marks ?? {};
    const label = `#${index}`;
    let previous = -Infinity;
    for (const name of ORDER_SEQUENCE) {
      const at = marks[name];
      if (at == null) { failures.push(`${label}: 印 '${name}' がない`); continue; }
      if (at < previous) failures.push(`${label}: 印 '${name}' が前の印より早い（${at} < ${previous}）`);
      previous = Math.max(previous, at);
    }
    for (const name of ORDER_SEQUENCE.slice(0, 3)) {
      if (marks[name] != null && marks[name] > 0) failures.push(`${label}: '${name}' が ready の後（${marks[name]} ms）`);
    }
    for (const request of row.dictionaryRequests ?? []) {
      if (request.startBeforeSetProxyDone !== false) failures.push(`${label}: 辞書の要求が setProxy の完了前に始まった（${JSON.stringify(request)}）`);
      if (!(request.proxyInfo ?? []).some((info) => /^SOCKS5 127\.0\.0\.1:\d+$/.test(info))) failures.push(`${label}: 辞書の要求が blackhole に向いていない（${JSON.stringify(request.proxyInfo)}）`);
    }
    if ((row.envProxyConnects ?? []).length > 0) failures.push(`${label}: env の proxy に ${row.envProxyConnects.length} 件届いた`);
    if ((row.dictionaries ?? []).length > 0) failures.push(`${label}: 辞書が取得された（${JSON.stringify(row.dictionaries)}）`);
  });
  return { pass: failures.length === 0, failures, runs: rows.length };
}

// ── 実機の観測 ────────────────────────────────────────────────────────────

/** NC-SESSION: default session でない窓。固定コード、graceful な終了（SIGSEGV なし）、server への到達 0 */
export function judgeNcSession(record, control) {
  const failures = [];
  if (!(record?.nc1?.failures ?? []).includes("[grimodex-electron] NC-SESSION")) failures.push(`NC-SESSION の固定コードが出ていない: ${JSON.stringify(record?.nc1?.failures)}`);
  if (!record?.nc1?.beforeQuit || !record?.nc1?.willQuit) failures.push("before-quit／will-quit を経ていない");
  if (record?.nc1?.quitCalls !== 1) failures.push(`app.quit() の呼出しが 1 回でない: ${record?.nc1?.quitCalls}`);
  if (record?.exit?.code !== 0 || record?.exit?.signal) failures.push(`終了が正常でない: ${JSON.stringify(record?.exit)}`);
  if (record?.httpdHits !== 0) failures.push(`破棄された窓の読込が server に届いた: ${record?.httpdHits}`);
  if (!String(record?.extra?.ncSession?.loadOutcome).startsWith("error:")) failures.push(`破棄された窓の loadURL が失敗していない: ${record?.extra?.ncSession?.loadOutcome}`);
  if (control && !(control.httpdHits >= 1)) failures.push("対照（閉じ込めなし）で同じ読込が server に届いていない（対照が成立しない）");
  return { pass: failures.length === 0, failures };
}

/** NC-POLICY の注入: 破棄された窓で page の script が走らず（beacon なし）、canary への到達が 0 */
export function judgeNcPolicy(record, { ok, none } = {}) {
  const failures = [];
  if (!(record?.nc1?.failures ?? []).includes("[grimodex-electron] NC-POLICY")) failures.push(`NC-POLICY の固定コードが出ていない: ${JSON.stringify(record?.nc1?.failures)}`);
  if ((record?.appRequests ?? []).includes("/beacon-ran")) failures.push("破棄された窓の page の script が走った（beacon が届いた）");
  if ((record?.totals?.canaryHits ?? 0) > 0 || (record?.totals?.unattributed ?? 0) > 0) failures.push(`canary への到達がある: ${JSON.stringify(record?.totals)}`);
  if (!record?.nc1?.beforeQuit || !record?.nc1?.willQuit) failures.push("before-quit／will-quit を経ていない");
  if (record?.exit?.code !== 0 || record?.exit?.signal) failures.push(`終了が正常でない: ${JSON.stringify(record?.exit)}`);
  if (ok && !((ok.appRequests ?? []).includes("/beacon-ran") && (ok.totals?.canaryHits ?? 0) === 0)) failures.push("対照 ok（policy が当たる）で script が走って canary 0 になっていない");
  if (none && !((none.appRequests ?? []).includes("/beacon-ran") && (none.totals?.canaryHits ?? 0) > 0)) failures.push("対照 none（閉じ込めなし）で script が走って UDP が canary に届いていない（対照が成立しない）");
  return { pass: failures.length === 0, failures };
}

/** DevTools の webContents が default session で、policy が当たり、NC-SESSION を起こさない（DR-NC1-9） */
export function judgeDevTools(record) {
  const failures = [];
  const snapshot = record?.extra?.devtools?.snapshot ?? [];
  if (!record?.extra?.devtools?.devToolsOpened) failures.push("DevTools が開いていない");
  if (snapshot.length < 2) failures.push(`webContents が 2 つ未満: ${snapshot.length}`);
  for (const contents of snapshot) {
    if (!contents.isDefaultSession) failures.push(`default session でない webContents: ${JSON.stringify(contents)}`);
    if (contents.policy !== "disable_non_proxied_udp") failures.push(`policy が当たっていない webContents: ${JSON.stringify(contents)}`);
  }
  if (!snapshot.some((contents) => contents.url.startsWith("devtools://"))) failures.push("DevTools の webContents（devtools://）が観測できていない");
  if ((record?.nc1?.failures ?? []).length > 0) failures.push(`固定コードが出た: ${record.nc1.failures.join(" | ")}`);
  if (record?.nc1?.quitCalls !== 0) failures.push("DevTools を開いたことで終了に入った");
  return { pass: failures.length === 0, failures };
}

// ── 合成の記録（判定が赤になることの対照）────────────────────────────────

/**
 * 記録全体の必要条件の対照（`ll-synthetic-leaks` の形）: Main 側の行へ 3、blob iframe の SecurityError の行へ 2、
 * `totals.unattributed` へ 5 を書き込んだ合成の記録。実機の記録ではない。
 */
export function synthesizeLeaks(record) {
  const out = clone(record);
  const mainRow = out.rows.find((row) => row.id === "main.net-fetch.window-session");
  const blobRow = out.rows.find((row) => /^realm\.iframe-blob\./.test(row.id));
  if (!mainRow || !blobRow) throw new Error("synthesizeLeaks: Main 側の行か blob iframe の行がない");
  mainRow.leaked = 3;
  blobRow.leaked = 2;
  out.totals = { ...out.totals, unattributed: 5 };
  out.label = `${record.label}-synthetic-leaks（合成。実機の記録ではない）`;
  return out;
}

/** 対照の行列にない DNS だけの行を 1 行足した合成の記録（`ll-synthetic-hint-not-in-baseline` の形） */
export function synthesizeHintNotInBaseline(record) {
  const out = clone(record);
  out.rows.push({ id: "dns.new-hint-not-in-baseline", outcome: "link:preconnect", leaked: 0, proxied: 0 });
  out.label = `${record.label}-synthetic-hint-not-in-baseline（合成。実機の記録ではない）`;
  return out;
}

/**
 * 不活性の行（実 DNS の対照の FQDN の行）へ許容集合の外の名前の解決と canary 到達を書き込んだ合成の記録
 * （`fq-synthetic-fqdn-leaks` の形）。`inertIds` は対照で不活性になる FQDN の行（既定は draft の 2 行）。
 */
export function synthesizeFqdnLeaks(record, { nameRowId = "main.remote-candidate-tcp.fqdn", leakRowId = "main.remote-candidate-udp.fqdn-srflx" } = {}) {
  const out = clone(record);
  const nameRow = out.rows.find((row) => row.id === nameRowId);
  const leakRow = out.rows.find((row) => row.id === leakRowId);
  if (!nameRow || !leakRow) throw new Error("synthesizeFqdnLeaks: FQDN の行がない");
  nameRow.dnsNames = [...(nameRow.dnsNames ?? []), "rct-<n>.probe.test."];
  leakRow.leaked = 2;
  out.totals = { ...out.totals, leakedProbes: (out.totals?.leakedProbes ?? 0) + 1, canaryHits: (out.totals?.canaryHits ?? 0) + 2 };
  out.label = `${record.label}-synthetic-fqdn-leaks（合成。実機の記録ではない）`;
  return out;
}

/** 合成の記録ごとの `--expect-min-fail`（行の不合格＋記録全体の不合格の合計）。draft の「対照の受入れ」の数 */
export const SYNTHETIC_EXPECT_MIN_FAIL = Object.freeze({ leaks: 3, hintNotInBaseline: 1, fqdnLeaks: 3 });
