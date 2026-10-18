/**
 * renderer の外向き通信（WebRTC の接続と名前解決）を Main の network 層で塞ぐ
 * NC-1 の設定の部品（K3/3 `nir1-d2a-activation-proposal/3`。NC-1 の lane）。
 *
 * この file は electron に依存しない純粋な定数と組立てだけを持つ。許可先は
 * 0 件（AL-0）で、名前解決を許す名前は RS-1 の固定の 4 名と sentinel と
 * `127.0.0.1` だけ。`proxyBypassRules` と `host-resolver-rules` はこの file の定数
 * から組み立てる。定数を増減するには新しい draftRef が要る（env、起動引数、設定、
 * IPC、renderer の値から足す入口を作らない）。OS による分岐も作らない。
 *
 * 閉じ込めを止める入口はここにも置かない。制御の構成（機構を 1 つずつ外した対照）
 * は probe 用の main だけが、ここの部品の組合せで作る。
 */

/** RS-1: 名前解決を許す GitHub の更新の host（exact。wildcard にしない）。 */
export const RS1_GITHUB_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
] as const;

/** RS-1: 名前解決を許す固定名（`localhost` 名の local proxy を使う利用者の更新のため）。 */
export const RS1_LOCALHOST = "localhost";

/** RS-1 の固定の 4 名（3 host と `localhost`）。 */
export const RS1_RESOLVABLE_NAMES = [
  ...RS1_GITHUB_HOSTS,
  RS1_LOCALHOST,
] as const;

/** 規則が届いたかを確かめる固定名（自己確認 (a)）。`127.0.0.1` へ写す。 */
export const RESOLVER_SENTINEL_HOST = "grimodex-rule-sentinel.invalid";

/** LS-1 の listener を IP literal で書くための loopback address。 */
export const LOOPBACK_ADDRESS = "127.0.0.1";

/**
 * AL-0: 直接通信（proxy を通さない）を許す先。0 件。renderer の Chromium の通信は
 * すべて blackhole の proxy へ向かう。
 */
export const AL0_DIRECT_ALLOWLIST: readonly string[] = [];

/** 暗黙の loopback bypass を外し、loopback も proxy（blackhole）へ向ける。 */
const NEGATE_LOOPBACK_BYPASS = "<-loopback>";

/** `proxyBypassRules`。`<-loopback>` だけ（AL-0 の許可先は 0 件なので足すものがない）。 */
export const PROXY_BYPASS_RULES: string = [
  NEGATE_LOOPBACK_BYPASS,
  ...AL0_DIRECT_ALLOWLIST,
].join(";");

/** 全 webContents に当てる WebRTC の IP 取扱い policy。 */
export const WEBRTC_IP_HANDLING_POLICY = "disable_non_proxied_udp" as const;

/** `setProxy` に渡す設定の形（electron の型に依存しない構造的な型）。 */
export interface RendererContainmentProxyConfig {
  mode: "fixed_servers";
  proxyRules: string;
  proxyBypassRules: string;
}

/**
 * default session の `setProxy` に渡す設定。LS-1 の port を SOCKS5 の blackhole
 * として指し、`proxyBypassRules` は `PROXY_BYPASS_RULES`（`<-loopback>` だけ）。
 */
export function buildProxyConfig(
  listenerPort: number,
): RendererContainmentProxyConfig {
  if (
    !Number.isInteger(listenerPort) ||
    listenerPort < 1 ||
    listenerPort > 65535
  ) {
    throw new RangeError("listener port must be an integer in 1..65535");
  }
  return {
    mode: "fixed_servers",
    proxyRules: `socks5://${LOOPBACK_ADDRESS}:${listenerPort}`,
    proxyBypassRules: PROXY_BYPASS_RULES,
  };
}

/** 製品の規則（sentinel の MAP、全名の拒否、RS-1 と loopback の EXCLUDE）。順序まで固定。 */
const HOST_RESOLVER_BASE_RULES: readonly string[] = [
  `MAP ${RESOLVER_SENTINEL_HOST} ${LOOPBACK_ADDRESS}`,
  "MAP * ~NOTFOUND",
  ...RS1_GITHUB_HOSTS.map((host) => `EXCLUDE ${host}`),
  `EXCLUDE ${LOOPBACK_ADDRESS}`,
  `EXCLUDE ${RS1_LOCALHOST}`,
];

/**
 * `host-resolver-rules` の値。製品の呼出し（`index.ts` の起動の 1 箇所）は引数なし。
 * `prefixRules` を渡すのは試験だけで、製品の規則の先頭に置いて 1 つの switch に
 * 合成する（`appendSwitch` が command line の同じ switch を置き換えるため）。
 * env、起動引数、設定、IPC、renderer の値を `prefixRules` へ流す入口を作らない。
 */
export function buildHostResolverRules(
  prefixRules: readonly string[] = [],
): string {
  return [...prefixRules, ...HOST_RESOLVER_BASE_RULES].join(", ");
}

/** FC-1: 起動前（窓がない）の失敗の固定コード。 */
export const NC_STARTUP_FAILURE_CODES = [
  "NC-LISTEN",
  "NC-PROXY",
  "NC-CLOSE",
  "NC-SELF-RESOLVE",
  "NC-SELF-PROXY",
  "NC-TIMEOUT",
] as const;

/** FC-1: 実行中（窓がある）の失敗の固定コード。 */
export const NC_RUNTIME_FAILURE_CODES = [
  "NC-POLICY",
  "NC-SESSION",
  "NC-LISTENER-LOST",
] as const;

export type NcStartupFailureCode = (typeof NC_STARTUP_FAILURE_CODES)[number];
export type NcRuntimeFailureCode = (typeof NC_RUNTIME_FAILURE_CODES)[number];
