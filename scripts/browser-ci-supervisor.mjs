#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESIDUAL_GRACE_MS = 250;

export async function groupMembers({
  platform = process.platform,
  readDirectory = readdir,
  readStat = readFile,
  procRoot = "/proc",
  selfPid = process.pid,
} = {}) {
  if (platform !== "linux") return [];
  const members = [];
  let entries;
  try {
    entries = await readDirectory(procRoot);
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  let scanUnavailable = false;
  await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        try {
          const stat = await readStat(`${procRoot}/${entry}/stat`, "utf8");
          const end = stat.lastIndexOf(")");
          if (end < 0) {
            scanUnavailable = true;
            return;
          }
          const fields = stat
            .slice(end + 2)
            .trim()
            .split(/\s+/);
          const pid = Number(entry);
          const pgrp = Number(fields[2]);
          if (
            fields.length < 22 ||
            !Number.isSafeInteger(pid) ||
            !Number.isSafeInteger(pgrp)
          ) {
            scanUnavailable = true;
            return;
          }
          if (pid !== selfPid && pgrp === selfPid) {
            members.push(pid);
          }
        } catch (error) {
          if (error?.code !== "ENOENT" && error?.code !== "ESRCH") {
            scanUnavailable = true;
          }
        }
      }),
  );
  return scanUnavailable ? null : members;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function main() {
  const executable = process.argv[2];
  if (executable === undefined) {
    console.error("browser-ci-supervisor requires a command");
    process.exitCode = 2;
    return;
  }

  const child = spawn(executable, process.argv.slice(3), { stdio: "inherit" });
  let interrupted = false;
  let finalized = false;

  // Keep the detached group leader alive after group TERM. The outer watchdog
  // can therefore revalidate this PID/PGID before escalating to group KILL.
  process.on("SIGTERM", () => {
    interrupted = true;
  });
  process.on("SIGINT", () => {
    interrupted = true;
  });
  child.on("error", () => {});

  child.once("close", (exitCode, signal) => {
    if (finalized) return;
    finalized = true;
    void (async () => {
      const members = await groupMembers();
      if (members === null) {
        try {
          process.kill(-process.pid, "SIGKILL");
        } catch {}
        process.exitCode = 1;
        return;
      }
      if (members.length === 0 && !interrupted) {
        process.exitCode = signal === null ? (exitCode ?? 1) : 1;
        return;
      }

      // A same-PGID descendant makes a normal run non-certifying even if the
      // descendant exits during this bounded cleanup window.
      try {
        process.kill(-process.pid, "SIGTERM");
      } catch {
        try {
          process.kill(-process.pid, "SIGKILL");
        } catch {}
        process.exitCode = 1;
        return;
      }
      await sleep(RESIDUAL_GRACE_MS);
      const survivors = await groupMembers();
      if (survivors === null || survivors.length !== 0) {
        try {
          process.kill(-process.pid, "SIGKILL");
        } catch {}
      }
      process.exitCode = 1;
    })();
  });
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntrypoint) main();
