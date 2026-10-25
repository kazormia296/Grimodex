#!/usr/bin/env node
/**
 * H1（K3/3 `nir1-d2a-activation-proposal/3`）: 更新経路の redirect 先の host が
 * RS-1 の GitHub 3 host に含まれるかを確かめる検知の script（CP-2b P3）。
 *
 * - 起点は `electron/electron` の現行版（`package.json` の `electron`）の公開 asset
 *   `SHASUMS256.txt`。`redirect: "manual"` で 1 hop ずつ受け、`Location` の host を
 *   正規化して RS-1 の 3 host（`electron/main/rendererContainment.ts` の
 *   `RS1_GITHUB_HOSTS`）に exact で含まれる場合だけ次の要求を出す。含まれない host には
 *   要求を出さずに失敗する（exit code 1）。
 * - 検知だけを行う。host の追加や RS-1 の変更はしない（新しい draftRef。重要な変更）。
 * - 要求に認証情報を付けない。log は hop ごとの status と host だけ（query は出さない）。
 *
 * 判断の記録: `docs/plans/nir1-lane-decisions/cp2b-decisions.md` の DR-CP2B-P3-1〜4。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** electron-updater（builder-util-runtime 9.7.0）の `maxRedirects` と同じ上限。 */
export const MAX_REDIRECTS = 10;

/** 1 要求の上限（ms）。job 全体は workflow の timeout（10 分）で切る。 */
export const REQUEST_TIMEOUT_MS = 30_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 検知の失敗。`reason` は閉じた code、`host` は公開の host 名だけ。 */
export class UpdateRouteError extends Error {
  constructor(reason, detail = {}) {
    super(
      `${reason}${detail.host ? ` host=${detail.host}` : ""}${
        detail.status !== undefined ? ` status=${detail.status}` : ""
      }`,
    );
    this.name = "UpdateRouteError";
    this.reason = reason;
    this.host = detail.host;
    this.status = detail.status;
  }
}

/** `electron/main/rendererContainment.ts` を書き換えずに読み、`RS1_GITHUB_HOSTS` を返す。 */
export async function loadRs1GithubHosts(
  file = path.join(repoRoot, "electron", "main", "rendererContainment.ts"),
) {
  const { transform } = await import("esbuild");
  const source = await readFile(file, "utf8");
  const { code } = await transform(source, {
    loader: "ts",
    format: "esm",
    target: "node20",
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
  return validateHostList(module.RS1_GITHUB_HOSTS);
}

/** RS-1 の GitHub の host の集合として受け入れられる形か確かめる（3 件、正規化済み）。 */
export function validateHostList(hosts) {
  if (
    !Array.isArray(hosts) ||
    hosts.length !== 3 ||
    hosts.some(
      (host) =>
        typeof host !== "string" ||
        host.length === 0 ||
        host !== host.toLowerCase() ||
        host.endsWith(".") ||
        host.includes("*"),
    ) ||
    new Set(hosts).size !== hosts.length
  ) {
    throw new UpdateRouteError("rs1-hosts-invalid");
  }
  return Object.freeze([...hosts]);
}

/** `package.json` の `electron`（exact の `x.y.z` だけ）から起点の URL を作る。 */
export function electronShasumsUrl(electronVersion) {
  if (
    typeof electronVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(electronVersion)
  ) {
    throw new UpdateRouteError("electron-version-not-exact");
  }
  return `https://github.com/electron/electron/releases/download/v${electronVersion}/SHASUMS256.txt`;
}

export async function readElectronVersion(
  file = path.join(repoRoot, "package.json"),
) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  return manifest.devDependencies?.electron ?? manifest.dependencies?.electron;
}

/**
 * 要求の前の検査。`location` を `base` に対して解決し、正規化した URL を返す。
 * RS-1 の host（exact）、`https:`、userinfo なし、既定の port、末尾の `.` なしでなければ
 * 失敗。
 */
export function admitUrl(location, base, allowedHosts) {
  let url;
  try {
    url = base === undefined ? new URL(location) : new URL(location, base);
  } catch {
    throw new UpdateRouteError("location-unparsable");
  }
  // URL の hostname は小文字化と IDN の写像（全角の句点 `。` などを `.` へ）を済ませている。
  const host = url.hostname;
  if (url.protocol !== "https:") {
    throw new UpdateRouteError("not-https", { host });
  }
  if (url.username !== "" || url.password !== "") {
    throw new UpdateRouteError("userinfo-present", { host });
  }
  if (url.port !== "") {
    throw new UpdateRouteError("non-default-port", { host });
  }
  // 末尾の `.` 付きの名前は外さずに拒否する。製品の `EXCLUDE <host>` が末尾の `.` 付きの
  // 名前に当たるかは確かめておらず、検知だけが通って製品が止まる差を作らない。
  if (host.endsWith(".")) {
    throw new UpdateRouteError("trailing-dot", { host });
  }
  if (!allowedHosts.includes(host)) {
    throw new UpdateRouteError("host-outside-rs1", { host });
  }
  return { url, host };
}

/**
 * 起点から redirect を 1 hop ずつ辿る。どの要求も、その前に `admitUrl` を通す。
 * 成功すれば `{ hops: [{ host, status }] }` を返し、失敗は `UpdateRouteError` を投げる。
 */
export async function checkUpdateRoute({
  startUrl,
  allowedHosts,
  fetchImpl = fetch,
  maxRedirects = MAX_REDIRECTS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  log = () => {},
}) {
  let { url, host } = admitUrl(startUrl, undefined, allowedHosts);
  const hops = [];
  for (let redirects = 0; ; redirects += 1) {
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new UpdateRouteError("request-failed", { host });
    }
    const status = response.status;
    hops.push({ host, status });
    log(`hop ${redirects} ${host} ${status}`);
    if (REDIRECT_STATUSES.has(status)) {
      await discardBody(response);
      if (redirects >= maxRedirects) {
        throw new UpdateRouteError("too-many-redirects", { host, status });
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new UpdateRouteError("location-missing", { host, status });
      }
      ({ url, host } = admitUrl(location, url, allowedHosts));
      continue;
    }
    await discardBody(response);
    if (status !== 200) {
      throw new UpdateRouteError("unexpected-status", { host, status });
    }
    return { hops };
  }
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // 本文は読まない。cancel の失敗は判定に使わない。
  }
}

async function main() {
  const allowedHosts = await loadRs1GithubHosts();
  const startUrl = electronShasumsUrl(await readElectronVersion());
  const log = (line) => console.log(`update-route-watch: ${line}`);
  log(`rs1 ${allowedHosts.join(",")}`);
  const { hops } = await checkUpdateRoute({ startUrl, allowedHosts, log });
  log(`ok ${hops.map((hop) => hop.host).join(" -> ")}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const line =
      error instanceof UpdateRouteError
        ? error.message
        : `internal-error ${error?.name ?? "Error"}`;
    console.error(`update-route-watch: FAIL ${line}`);
    process.exitCode = 1;
  });
}
