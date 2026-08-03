import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { app, shell } from "electron";

import type { ShellCommandHandlers } from "../shared/ipcContract.js";

const RELEASE_API_URL =
  "https://api.github.com/repos/kazormia296/mozkey-ibg/releases?per_page=10";
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const GITHUB_DOWNLOAD_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface MozkeyInstallResult {
  version: string;
  assetName: string;
}

type FetchLike = (
  input: string,
  init?: {
    headers?: Readonly<Record<string, string>>;
    redirect?: "follow";
  },
) => Promise<Response>;

export interface MozkeyInstallerDependencies {
  fetch?: FetchLike;
  platform?: NodeJS.Platform;
  arch?: string;
  userDataDir?: string;
  readLinuxOsRelease?: () => Promise<string>;
  openInstaller?: (installerPath: string) => Promise<string>;
}

export interface MozkeyInstallerManager {
  handlers: ShellCommandHandlers;
}

function assertGithubUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Mozkey IbG release contains an invalid download URL");
  }
  if (url.protocol !== "https:" || !GITHUB_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new Error("Mozkey IbG release contains an untrusted download URL");
  }
}

async function fetchGithub(
  fetchImpl: FetchLike,
  url: string,
): Promise<Response> {
  assertGithubUrl(url);
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Grimodex-Mozkey-Installer",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.url !== "") assertGithubUrl(response.url);
  return response;
}

async function readLimitedBytes(
  response: Response,
  limit: number,
  label: string,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(`${label} is larger than the allowed limit`);
  }
  if (!response.body) throw new Error(`${label} response has no body`);

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    length += chunk.byteLength;
    if (length > limit) {
      throw new Error(`${label} is larger than the allowed limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function parseRelease(value: unknown): GithubRelease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Mozkey IbG release metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.tag_name !== "string" ||
    typeof record.draft !== "boolean" ||
    typeof record.prerelease !== "boolean" ||
    !Array.isArray(record.assets)
  ) {
    throw new Error("Mozkey IbG release metadata is invalid");
  }
  const assets = record.assets.map((asset) => {
    if (typeof asset !== "object" || asset === null || Array.isArray(asset)) {
      throw new Error("Mozkey IbG release asset metadata is invalid");
    }
    const candidate = asset as Record<string, unknown>;
    if (
      typeof candidate.name !== "string" ||
      typeof candidate.browser_download_url !== "string" ||
      typeof candidate.size !== "number" ||
      !Number.isSafeInteger(candidate.size) ||
      candidate.size <= 0 ||
      candidate.size > MAX_PACKAGE_BYTES
    ) {
      throw new Error("Mozkey IbG release asset metadata is invalid");
    }
    return {
      name: candidate.name,
      browser_download_url: candidate.browser_download_url,
      size: candidate.size,
    };
  });
  return {
    tag_name: record.tag_name,
    draft: record.draft,
    prerelease: record.prerelease,
    assets,
  };
}

async function loadRelease(fetchImpl: FetchLike): Promise<GithubRelease> {
  const response = await fetchGithub(fetchImpl, RELEASE_API_URL);
  if (response.status === 404) {
    throw new Error("No public Mozkey IbG release is available yet");
  }
  if (!response.ok) {
    throw new Error(
      `Mozkey IbG release lookup failed with HTTP ${response.status}`,
    );
  }
  const bytes = await readLimitedBytes(
    response,
    MAX_RELEASE_METADATA_BYTES,
    "Mozkey IbG release metadata",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Mozkey IbG release metadata is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Mozkey IbG release metadata is invalid");
  }
  const release = parsed
    .map((candidate) => parseRelease(candidate))
    .find((candidate) => !candidate.draft);
  if (!release) {
    throw new Error("No public Mozkey IbG release is available yet");
  }
  return release;
}

function releaseVersion(tag: string): string {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match) throw new Error("Mozkey IbG release tag is invalid");
  return match[1];
}

function linuxFamily(osRelease: string): "deb" | "rpm" | "arch" | null {
  const values = osRelease
    .split(/\r?\n/)
    .filter((line) => /^(ID|ID_LIKE)=/.test(line))
    .flatMap((line) =>
      line
        .slice(line.indexOf("=") + 1)
        .replace(/["']/g, "")
        .split(/\s+/),
    )
    .map((value) => value.toLowerCase());
  if (values.some((value) => /^(debian|ubuntu|linuxmint|pop)$/.test(value))) {
    return "deb";
  }
  if (
    values.some((value) =>
      /^(fedora|rhel|centos|rocky|almalinux|suse|opensuse)$/.test(value),
    )
  ) {
    return "rpm";
  }
  if (values.includes("arch")) return "arch";
  return null;
}

async function expectedAssetName(
  platform: NodeJS.Platform,
  arch: string,
  version: string,
  readLinuxOsRelease: () => Promise<string>,
): Promise<string> {
  if (platform === "win32") {
    if (arch === "x64") return `MozkeyIbG_v${version}_x64.msi`;
    if (arch === "arm64") return `MozkeyIbG_v${version}_arm64.msi`;
  }
  if (platform === "darwin" && arch === "arm64") {
    return `MozkeyIbG_v${version}_macos_arm64.pkg`;
  }
  if (platform === "linux" && arch === "x64") {
    const family = linuxFamily(await readLinuxOsRelease());
    if (family === "deb") return `mozkey-ibg_${version}_amd64.deb`;
    if (family === "rpm") return `mozkey-ibg-${version}-1.x86_64.rpm`;
    if (family === "arch") {
      throw new Error(
        "Install mozkey-ibg-bin with an AUR helper on Arch Linux",
      );
    }
  }
  throw new Error(
    `Mozkey IbG installation is not supported on ${platform}/${arch}`,
  );
}

function findAsset(release: GithubRelease, name: string): ReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`Mozkey IbG release asset is missing: ${name}`);
  if (path.basename(asset.name) !== asset.name) {
    throw new Error("Mozkey IbG release asset name is unsafe");
  }
  assertGithubUrl(asset.browser_download_url);
  return asset;
}

function parseChecksum(checksums: string, assetName: string): string {
  for (const line of checksums.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[2] === assetName) return match[1].toLowerCase();
  }
  throw new Error(`Mozkey IbG checksum is missing for ${assetName}`);
}

async function hashFile(filePath: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function downloadVerifiedPackage(
  fetchImpl: FetchLike,
  asset: ReleaseAsset,
  expectedSha256: string,
  destinationDir: string,
): Promise<string> {
  await mkdir(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, asset.name);
  if ((await hashFile(destination)) === expectedSha256) return destination;

  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const response = await fetchGithub(fetchImpl, asset.browser_download_url);
  if (!response.ok) {
    throw new Error(`Mozkey IbG download failed with HTTP ${response.status}`);
  }
  if (!response.body)
    throw new Error("Mozkey IbG download response has no body");

  const handle = await open(temporary, "wx");
  const hash = createHash("sha256");
  let downloaded = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      downloaded += chunk.byteLength;
      if (downloaded > asset.size || downloaded > MAX_PACKAGE_BYTES) {
        throw new Error("Mozkey IbG download is larger than release metadata");
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();

  if (downloaded !== asset.size || hash.digest("hex") !== expectedSha256) {
    await rm(temporary, { force: true });
    throw new Error("Mozkey IbG checksum verification failed");
  }
  await rm(destination, { force: true });
  await rename(temporary, destination);
  return destination;
}

export function createMozkeyInstallerManager(
  dependencies: MozkeyInstallerDependencies = {},
): MozkeyInstallerManager {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const userDataDir = dependencies.userDataDir ?? app.getPath("userData");
  const readLinuxOsRelease =
    dependencies.readLinuxOsRelease ??
    (() => readFile("/etc/os-release", "utf8"));
  const openInstaller =
    dependencies.openInstaller ?? ((value) => shell.openPath(value));
  let inFlight: Promise<MozkeyInstallResult> | null = null;

  const install = async (): Promise<MozkeyInstallResult> => {
    const release = await loadRelease(fetchImpl);
    const version = releaseVersion(release.tag_name);
    const assetName = await expectedAssetName(
      platform,
      arch,
      version,
      readLinuxOsRelease,
    );
    const asset = findAsset(release, assetName);
    const checksumAsset = findAsset(release, "SHA256SUMS");
    const checksumResponse = await fetchGithub(
      fetchImpl,
      checksumAsset.browser_download_url,
    );
    if (!checksumResponse.ok) {
      throw new Error(
        `Mozkey IbG checksum download failed with HTTP ${checksumResponse.status}`,
      );
    }
    const checksumBytes = await readLimitedBytes(
      checksumResponse,
      MAX_CHECKSUM_BYTES,
      "Mozkey IbG checksums",
    );
    const expectedSha256 = parseChecksum(
      checksumBytes.toString("utf8"),
      asset.name,
    );
    const installerPath = await downloadVerifiedPackage(
      fetchImpl,
      asset,
      expectedSha256,
      path.join(userDataDir, "mozkey-installers"),
    );
    const openError = await openInstaller(installerPath);
    if (openError !== "") {
      throw new Error(`Mozkey IbG installer could not be opened: ${openError}`);
    }
    return { version, assetName };
  };

  return {
    handlers: {
      mozkey_download_and_install: async () => {
        if (inFlight) return inFlight;
        const operation = install();
        inFlight = operation;
        const clearFlight = (): void => {
          if (inFlight === operation) inFlight = null;
        };
        void operation.then(clearFlight, clearFlight);
        return operation;
      },
    },
  };
}
