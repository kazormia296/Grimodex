#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDirectory = path.join(root, "node_modules", "electron");
const packageJson = JSON.parse(
  await readFile(path.join(electronDirectory, "package.json"), "utf8"),
);
const rootPackage = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const version = rootPackage.devDependencies?.electron;
if (!version || packageJson.version !== version) {
  throw new Error(
    "installed Electron package does not match the pinned version",
  );
}

const dist = path.join(electronDirectory, "dist");
const binary =
  process.platform === "darwin"
    ? path.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
    : path.join(
        dist,
        process.platform === "win32" ? "electron.exe" : "electron",
      );
async function installed() {
  try {
    const [installedVersion] = await Promise.all([
      readFile(path.join(dist, "version"), "utf8"),
      access(binary, constants.X_OK),
    ]);
    return installedVersion.trim().replace(/^v/u, "") === version;
  } catch {
    return false;
  }
}

if (!(await installed())) {
  const env = { ...process.env };
  // The package installer must verify its own dist, even when a local launcher
  // overrides the path returned by require("electron").
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  env.electron_config_cache ??= path.join(
    root,
    ".artifacts",
    "electron-download-cache",
  );
  await mkdir(env.electron_config_cache, { recursive: true });
  const args = [];
  if (
    process.allowedNodeEnvironmentFlags.has("--use-env-proxy") &&
    (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)
  ) {
    args.push("--use-env-proxy");
  }
  args.push(path.join(electronDirectory, "install.js"));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 || result.signal) {
    throw new Error(
      `pinned Electron installer failed (${result.signal ?? result.code})`,
    );
  }
}

if (!(await installed())) {
  throw new Error(
    `Electron ${version} executable is missing after installation`,
  );
}
console.log(`Electron ${version} executable ready`);
