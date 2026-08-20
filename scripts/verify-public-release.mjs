#!/usr/bin/env node

import { createHash } from "node:crypto";

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === "stable") {
      options.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    options.set(name, value);
    index += 1;
  }
  for (const name of ["repository", "tag"]) {
    if (!options.has(name))
      throw new Error(`Missing required option: --${name}`);
  }
  return options;
}

function releaseApiUrl(repository, tag) {
  return `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
}

async function fetchAnonymous(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Grimodex-public-release-smoke",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Anonymous request failed (${response.status}): ${url}`);
  }
  return response;
}

async function assertDownload(fetchImpl, url, label) {
  const response = await fetchAnonymous(fetchImpl, url);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error(`${label} is empty: ${url}`);
    return bytes;
  }
  const reader = response.body.getReader();
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
  }
  if (size === 0) throw new Error(`${label} is empty: ${url}`);
  return size;
}

function assetByName(release, name) {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) {
    throw new Error(`Expected one ${name} asset, found ${matches.length}`);
  }
  return matches[0];
}

function requireAsset(release, pattern, label) {
  const matches = release.assets.filter((asset) => pattern.test(asset.name));
  if (matches.length < 1) throw new Error(`Missing ${label} asset`);
  return matches;
}

export async function verifyPublicRelease(
  { repository, tag, stable = false },
  fetchImpl = globalThis.fetch,
) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const apiResponse = await fetchAnonymous(
    fetchImpl,
    releaseApiUrl(repository, tag),
  );
  const release = await apiResponse.json();
  if (release.tag_name !== tag) throw new Error("Release tag mismatch");
  if (release.draft !== false) throw new Error("Release must be published");
  const version = tag.replace(/^v/, "");
  const requiredFiles = [
    "LICENSE",
    "NOTICE",
    "RELEASE_NOTES.md",
    "provenance.json",
  ];
  for (const name of requiredFiles) {
    const asset = assetByName(release, name);
    await assertDownload(fetchImpl, asset.browser_download_url, name);
  }
  requireAsset(
    release,
    new RegExp(`^Grimodex-${version}-windows-.*\\.exe$`),
    "Windows installer",
  );
  for (const extension of ["AppImage", "deb", "rpm"]) {
    requireAsset(
      release,
      new RegExp(`^Grimodex-${version}-linux-.*\\.${extension}$`),
      `Linux ${extension} installer`,
    );
  }
  for (const extension of ["dmg", "zip", "app\\.tar\\.gz"]) {
    requireAsset(
      release,
      new RegExp(`^Grimodex-${version}-mac-.*\\.${extension}$`),
      `macOS ${extension} installer`,
    );
  }

  const metadataNames = ["latest.yml", "latest-linux.yml", "latest-mac.yml"];
  for (const name of metadataNames) {
    const asset = assetByName(release, name);
    await assertDownload(fetchImpl, asset.browser_download_url, name);
  }

  let manifest = { platforms: {} };
  const manifestAsset = release.assets.find(
    (asset) => asset.name === "latest.json",
  );
  if (stable && !manifestAsset)
    throw new Error("Expected one latest.json asset");
  if (manifestAsset) {
    const manifestResponse = await fetchAnonymous(
      fetchImpl,
      manifestAsset.browser_download_url,
    );
    const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
    if (manifestBytes.length === 0) throw new Error("latest.json is empty");
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
      if (
        !entry.url?.startsWith(`https://github.com/${repository}/releases/`)
      ) {
        throw new Error(
          `Manifest URL for ${platform} does not target ${repository}`,
        );
      }
      await assertDownload(fetchImpl, entry.url, `manifest ${platform}`);
    }
  }

  if (stable) {
    const latestUrls = [
      `https://github.com/${repository}/releases/latest/download/latest.yml`,
      `https://github.com/${repository}/releases/latest/download/latest-linux.yml`,
      `https://github.com/${repository}/releases/latest/download/latest-mac.yml`,
      `https://github.com/${repository}/releases/latest/download/latest.json`,
    ];
    for (const url of latestUrls)
      await assertDownload(fetchImpl, url, "latest");
  }

  const provenanceAsset = assetByName(release, "provenance.json");
  const provenanceResponse = await fetchAnonymous(
    fetchImpl,
    provenanceAsset.browser_download_url,
  );
  const provenanceBytes = new Uint8Array(
    await provenanceResponse.arrayBuffer(),
  );
  if (provenanceBytes.length === 0) throw new Error("provenance.json is empty");
  const provenance = JSON.parse(new TextDecoder().decode(provenanceBytes));
  if (provenance.publication?.repository !== repository) {
    throw new Error("Provenance publication repository mismatch");
  }
  if (provenance.publication?.tag !== tag) {
    throw new Error("Provenance publication tag mismatch");
  }
  return {
    tag,
    repository,
    assetCount: release.assets.length,
    manifestPlatforms: Object.keys(manifest.platforms ?? {}).length,
    provenanceSha256: createHash("sha256")
      .update(provenanceBytes)
      .digest("hex"),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await verifyPublicRelease({
      repository: options.get("repository"),
      tag: options.get("tag"),
      stable: options.get("stable") === true,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
