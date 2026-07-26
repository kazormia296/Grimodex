import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_KEYS = new Set([
  "darwin-aarch64-app",
  "darwin-x86_64-app",
  "linux-aarch64-appimage",
  "linux-aarch64-deb",
  "linux-aarch64-rpm",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "linux-x86_64-rpm",
  "windows-aarch64-nsis",
  "windows-x86_64-nsis",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function platformForAsset(fileName, version) {
  const prefix = `Grimodex-${escapeRegExp(version)}`;
  const matchers = [
    [
      new RegExp(`^${prefix}-windows-(x64|x86_64|amd64|arm64|aarch64)\\.exe$`),
      "windows",
      "nsis",
    ],
    [
      new RegExp(
        `^${prefix}-mac-(x64|x86_64|amd64|arm64|aarch64)\\.app\\.tar\\.gz$`,
      ),
      "darwin",
      "app",
    ],
    [
      new RegExp(
        `^${prefix}-linux-(x64|x86_64|amd64|arm64|aarch64)\\.AppImage$`,
      ),
      "linux",
      "appimage",
    ],
    [
      new RegExp(`^${prefix}-linux-(x64|x86_64|amd64|arm64|aarch64)\\.deb$`),
      "linux",
      "deb",
    ],
    [
      new RegExp(`^${prefix}-linux-(x64|x86_64|amd64|arm64|aarch64)\\.rpm$`),
      "linux",
      "rpm",
    ],
  ];
  for (const [matcher, osName, installer] of matchers) {
    const match = fileName.match(matcher);
    if (!match) continue;
    const arch = ["x64", "x86_64", "amd64"].includes(match[1])
      ? "x86_64"
      : "aarch64";
    return `${osName}-${arch}-${installer}`;
  }
  return null;
}

function validateInstallerCompleteness(platformKeys) {
  const keys = new Set(
    platformKeys instanceof Map ? platformKeys.keys() : platformKeys,
  );
  for (const osName of ["darwin", "linux", "windows"]) {
    if (![...keys].some((key) => key.startsWith(`${osName}-`))) {
      throw new Error(`Missing bridge installer family: ${osName}`);
    }
  }

  for (const arch of ["x86_64", "aarch64"]) {
    const linuxPrefix = `linux-${arch}-`;
    if (![...keys].some((key) => key.startsWith(linuxPrefix))) continue;
    for (const installer of ["appimage", "deb", "rpm"]) {
      const required = `${linuxPrefix}${installer}`;
      if (!keys.has(required)) {
        throw new Error(`Missing required bridge installer: ${required}`);
      }
    }
  }
}

export function validateBridgeManifestSchema(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Bridge manifest must be an object");
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("Bridge manifest version is required");
  }
  if (typeof manifest.notes !== "string") {
    throw new Error("Bridge manifest notes must be a string");
  }
  if (
    typeof manifest.pub_date !== "string" ||
    Number.isNaN(Date.parse(manifest.pub_date))
  ) {
    throw new Error("Bridge manifest pub_date must be an ISO date");
  }
  const platforms = manifest.platforms;
  if (
    !platforms ||
    typeof platforms !== "object" ||
    !Object.keys(platforms).length
  ) {
    throw new Error("Bridge manifest must contain at least one platform");
  }
  for (const [platform, update] of Object.entries(platforms)) {
    if (!PLATFORM_KEYS.has(platform)) {
      throw new Error(`Unsupported Tauri updater platform: ${platform}`);
    }
    if (!update || typeof update !== "object") {
      throw new Error(`Invalid update entry for ${platform}`);
    }
    if (
      typeof update.signature !== "string" ||
      update.signature.trim() === ""
    ) {
      throw new Error(`A real signature is required for ${platform}`);
    }
    if (typeof update.url !== "string" || !update.url.startsWith("https://")) {
      throw new Error(`An HTTPS update URL is required for ${platform}`);
    }
  }
  validateInstallerCompleteness(Object.keys(platforms));
  return true;
}

export async function buildBridgeManifest({
  assetsDir,
  version,
  tag,
  repository,
  notes,
  pubDate,
}) {
  if (tag !== `v${version}`) {
    throw new Error(`Bridge tag/version mismatch: ${tag} vs ${version}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }

  const platformEntries = new Map();
  const entries = await readdir(assetsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const platform = platformForAsset(entry.name, version);
    if (!platform) continue;
    if (platformEntries.has(platform)) {
      throw new Error(`Duplicate updater asset for ${platform}`);
    }

    const signaturePath = path.join(assetsDir, `${entry.name}.sig`);
    let signature;
    try {
      signature = (await readFile(signaturePath, "utf8")).trim();
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Missing signature sidecar for ${entry.name}`);
      }
      throw error;
    }
    if (!signature) {
      throw new Error(`Empty signature sidecar for ${entry.name}`);
    }

    platformEntries.set(platform, {
      signature,
      url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(entry.name)}`,
    });
  }
  validateInstallerCompleteness(platformEntries);

  const manifest = {
    version,
    notes,
    pub_date: new Date(pubDate).toISOString(),
    platforms: Object.fromEntries(
      [...platformEntries.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  validateBridgeManifestSchema(manifest);
  return manifest;
}

export async function writeImmutableManifest(outputPath, manifest) {
  validateBridgeManifestSchema(manifest);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, body, { flag: "wx" });
    return { written: true };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const existing = await readFile(outputPath, "utf8");
  if (existing !== body) {
    throw new Error(
      `Refusing to replace immutable bridge manifest: ${outputPath}`,
    );
  }
  return { written: false };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid arguments near: ${key ?? "<end>"}`);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = [
    "assets-dir",
    "version",
    "tag",
    "repository",
    "notes",
    "pub-date",
    "output",
  ];
  for (const name of required) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }

  const manifest = await buildBridgeManifest({
    assetsDir: path.resolve(args["assets-dir"]),
    version: args.version,
    tag: args.tag,
    repository: args.repository,
    notes: args.notes,
    pubDate: args["pub-date"],
  });
  const result = await writeImmutableManifest(
    path.resolve(args.output),
    manifest,
  );
  console.log(
    `${result.written ? "created" : "verified"} immutable bridge manifest: ${args.output}`,
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
