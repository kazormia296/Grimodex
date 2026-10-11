#!/usr/bin/env node
// Grouped observations in the existing contracts job, not Full admission.
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runLocalCiCommand } from "./local-ci-process-supervisor.mjs";

export function normalizedDestination(destination, prefixes) {
  if (typeof destination !== "string" || !path.isAbsolute(destination) || /[\r\n\0]/u.test(destination)) throw new Error("invalid destination");
  const resolved = path.resolve(destination);
  const prefix = prefixes.filter(([, root]) => root && path.isAbsolute(root))
    .sort((a, b) => b[1].length - a[1].length)
    .find(([, root]) => resolved === root || resolved.startsWith(`${root}/`));
  if (!prefix) throw new Error("unrecognized destination scope");
  return `${prefix[0]}${resolved.slice(prefix[1].length)}`;
}

async function exclusiveJson(file, value) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function recordSetupObservation(phase) {
  if (!["installed", "reports"].includes(phase) || process.env.SETUP_OBSERVATION_PROFILE !== "contracts") throw new Error("contracts-only observation required");
  const root = process.cwd();
  const directory = path.join(root, ".artifacts/canonical-source");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error("owned evidence directory required");
  const identity = JSON.parse(await readFile(path.join(directory, "checkout-identity.json"), "utf8"));
  if (identity.commitSha !== process.env.GITHUB_SHA || !/^[a-f0-9]{40}$/u.test(identity.treeSha) ||
      !/^[1-9][0-9]*$/u.test(process.env.GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]*$/u.test(process.env.GITHUB_RUN_ATTEMPT ?? "")) throw new Error("current hosted identity required");
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("observation cancelled"));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const logDirectory = `.artifacts/local-ci/setup-observation-${phase}`;
  const binding = { ...identity, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
  try {
    // Marker survives success/error/cancellation: no retry, overwrite or recovery.
    await exclusiveJson(path.join(directory, `allocation-${phase}-pending.json`), binding);
    const children = [];
    const query = async (id, command, args, timeoutMs = 15000) => {
      const result = await runLocalCiCommand({ command, args, cwd: "." }, {
        root, logDirectory, taskId: id, timeoutMs, signal: controller.signal,
      });
      if (result.exitCode !== 0 || result.timedOut || result.interrupted || !result.cleanup.complete) throw new Error("metadata child did not retire successfully");
      children.push({ id, exitCode: result.exitCode, cleanup: result.cleanup, logs: result.logs });
      const output = await readFile(path.join(root, logDirectory, `${id}.stdout.log`), "utf8");
      if (output.length > 1024 * 1024) throw new Error("bounded metadata output required");
      return output.trim();
    };
    const prefixes = [["workspace", root], ["runner-tool-cache", process.env.RUNNER_TOOL_CACHE], ["home", homedir()]];
    const sources = {};
    for (const file of [".github/workflows/canonical-ci.yml", "scripts/local-ci-setup-observation.mjs", "scripts/local-ci-setup-allocation.py", "pnpm-lock.yaml", "package.json"]) {
      sources[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
    }
    let versions = null;
    let provenance = null;
    let selected;
    if (phase === "installed") {
      const pnpm = await query("pnpm-version", "pnpm", ["--version"]);
      if (pnpm !== "10.33.0") throw new Error("pinned pnpm required");
      const store = await query("pnpm-store", "pnpm", ["store", "path", "--silent"]);
      const toolchain = (await query("rust-toolchain", "rustup", ["show", "active-toolchain"])).split(/\s/u)[0];
      const rust = (await query("rust-version", "rustc", ["--version"])).match(/^rustc ([0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?)\b/u)?.[1];
      if (!/^[a-z0-9][a-z0-9_.-]{0,100}$/u.test(toolchain) || !rust || !/^v22\./u.test(process.version)) throw new Error("source-shaped tool versions required");
      versions = { pnpm, node: process.version, rust, toolchain };
      const cargo = process.env.CARGO_HOME || path.join(homedir(), ".cargo");
      const rustup = process.env.RUSTUP_HOME || path.join(homedir(), ".rustup");
      // Pinned action installs pnpm (standalone defaults false) in its dest cwd.
      // Resolve only this exact public package link, not an arbitrary tree scan.
      const installer = process.env.PNPM_OBSERVATION_DEST;
      normalizedDestination(installer, prefixes);
      const canonicalInstaller = await realpath(installer);
      normalizedDestination(canonicalInstaller, prefixes);
      const payload = path.join(canonicalInstaller, "node_modules", "pnpm");
      let payloadRoot;
      try { payloadRoot = await realpath(payload); }
      catch (error) { if (error.code !== "ENOENT") throw error; payloadRoot = payload; }
      const payloadRelative = path.relative(canonicalInstaller, payloadRoot);
      if (!payloadRelative || payloadRelative === ".." || payloadRelative.startsWith(`..${path.sep}`) || path.isAbsolute(payloadRelative)) {
        throw new Error("pnpm package must remain inside its canonical installer");
      }
      provenance = {
        pnpmInstaller: { destination: normalizedDestination(installer, prefixes), basis: "pinned action dest output / bootstrap install cwd" },
        pnpmPayload: { destination: normalizedDestination(payloadRoot, prefixes), basis: "pinned action default non-standalone pnpm package; exact package link resolution" },
        installedStore: { destination: normalizedDestination(store, prefixes), basis: "installed pnpm 10.33.0 store path query in workspace" },
        currentHome: { destination: normalizedDestination(homedir(), prefixes), basis: "observer OS home, not historical bootstrap config/home attestation" },
        bootstrapStore: { status: "unobserved", destination: null, basis: "bootstrap bundled pnpm/config/home were not captured during action setup; installed v10 query and current PNPM_HOME do not attest bootstrap v3 location" },
      };
      selected = [
        ["pnpm-installed", installer],
        ["pnpm-payload", payloadRoot],
        ["node-installed", path.dirname(path.dirname(await realpath(process.execPath)))],
        ["rust-installed", path.join(rustup, "toolchains", toolchain)],
        ["cargo-shims", path.join(cargo, "bin")],
        ["rust-download-cache", path.join(rustup, "downloads")],
        ["rust-extraction", path.join(rustup, "tmp")],
        ["packages-installed", path.join(root, "node_modules")],
        ["pnpm-store", store],
      ];
      // Only already-joined query logs: the walker's own output is still active.
      for (const child of children) for (const stream of ["stdout", "stderr"]) {
        selected.push([`query-${child.id}-${stream}`, path.join(root, logDirectory, `${child.id}.${stream}.log`)]);
      }
    } else {
      selected = [["contract-tap", path.join(directory, "contracts.tap")], ["checkout-identity", path.join(directory, "checkout-identity.json")]];
    }
    const destinations = Object.fromEntries(selected.map(([id, destination]) => [id, normalizedDestination(destination, prefixes)]));
    const snapshot = JSON.parse(await query("allocation", "python3", ["scripts/local-ci-setup-allocation.py", JSON.stringify(selected)], 75000));
    controller.signal.throwIfAborted();
    await exclusiveJson(path.join(directory, `allocation-${phase}.json`), {
      version: "canonical-setup-observation/1", phase, binding, sources, versions, provenance, destinations, snapshot,
      children: children.map(({ id, exitCode, cleanup, logs }) => ({ id, exitCode, cleanup,
        logJoins: Object.fromEntries(Object.entries(logs).map(([stream, log]) => [stream, { size: log.size, sha256: log.sha256 }])),
      })),
      scope: "Sequential metadata snapshots; no file contents. Coexistence deduplicates observed roots only, not an atomic peak or cold Full forecast.",
      unobserved: ["bundled bootstrap pnpm effective config/home/store location and allocation", "pnpm/node/package historical download and extraction peaks", "complete hosted action logs and observer output growth after snapshot", "other Full installers/preparation/fixtures/journeys", "future growth and additive uncertainty", "future runner capacity/quota/exclusion"],
    });
    controller.signal.throwIfAborted();
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  recordSetupObservation(process.argv[2]).catch(() => {
    console.error("[artifact] grouped setup allocation observation failed; owner/output retained");
    process.exitCode = 1;
  });
}
