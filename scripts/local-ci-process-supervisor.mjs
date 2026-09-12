import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

// CI commands must keep descendants in their inherited process group. A
// daemon or double-fork can escape ordinary Node process-group cleanup.

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function groupExists(processGroupId) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)
    return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function signalGroup(processGroupId, signal) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)
    return false;
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGroupExit(processGroupId, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (groupExists(processGroupId) && performance.now() < deadline) {
    await delay(20);
  }
  return !groupExists(processGroupId);
}

async function terminateProcessGroup(
  processGroupId,
  { killGraceMs, termGraceMs },
) {
  const cleanup = {
    complete: true,
    groupAlive: false,
    killSent: false,
    termSent: false,
  };
  if (!groupExists(processGroupId)) return cleanup;
  cleanup.termSent = signalGroup(processGroupId, "SIGTERM");
  if (await waitForGroupExit(processGroupId, termGraceMs)) return cleanup;
  cleanup.killSent = signalGroup(processGroupId, "SIGKILL");
  cleanup.complete = await waitForGroupExit(processGroupId, killGraceMs);
  cleanup.groupAlive = !cleanup.complete;
  return cleanup;
}

async function fileIdentity(root, filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return {
    path: path.relative(root, filePath),
    sha256: `sha256:${hash.digest("hex")}`,
    size: (await stat(filePath)).size,
  };
}

function commandExecutable(command) {
  return process.platform === "win32" && command === "pnpm"
    ? "pnpm.cmd"
    : command;
}

export async function runLocalCiCommand(
  entry,
  {
    killGraceMs = 2_000,
    logDirectory,
    root,
    signal = null,
    taskId,
    termGraceMs = 2_000,
    timeoutMs = entry.timeoutMs ?? 0,
  },
) {
  if (process.platform === "win32") {
    throw new Error("local CI process-group supervision requires POSIX");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(taskId ?? "")) {
    throw new Error("local CI supervisor requires a safe taskId");
  }
  if (signal?.aborted) throw signal.reason ?? new Error("local CI interrupted");

  const absoluteLogDirectory = path.resolve(root, logDirectory);
  await mkdir(absoluteLogDirectory, { recursive: true });
  const stdoutPath = path.join(absoluteLogDirectory, `${taskId}.stdout.log`);
  const stderrPath = path.join(absoluteLogDirectory, `${taskId}.stderr.log`);
  const stdout = await open(stdoutPath, "wx");
  let stderr;
  try {
    stderr = await open(stderrPath, "wx");
  } catch (error) {
    await stdout.close();
    throw error;
  }
  const started = performance.now();
  let child;
  let spawnError = null;
  let timedOut = false;
  let interrupted = false;
  let cleanupPromise = null;

  try {
    child = spawn(commandExecutable(entry.command), entry.args, {
      cwd: path.resolve(root, entry.cwd ?? "."),
      detached: true,
      env: { ...process.env, ...(entry.env ?? {}) },
      shell: false,
      stdio: ["ignore", stdout.fd, stderr.fd],
    });

    const stop = () => {
      cleanupPromise ??= terminateProcessGroup(child.pid, {
        killGraceMs,
        termGraceMs,
      });
    };
    const interrupt = () => {
      interrupted = true;
      stop();
    };
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, timeoutMs)
        : null;

    const closed = await new Promise((resolve) => {
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (exitCode, childSignal) => {
        resolve({ exitCode, signal: childSignal ?? null });
      });
    });
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", interrupt);
    const cleanup = cleanupPromise
      ? await cleanupPromise
      : {
          complete: true,
          groupAlive: false,
          killSent: false,
          termSent: false,
        };
    const survivorDetected = cleanupPromise
      ? groupExists(child.pid)
      : !(await waitForGroupExit(child.pid, termGraceMs));
    if (survivorDetected) {
      const survivorCleanup = await terminateProcessGroup(child.pid, {
        killGraceMs,
        termGraceMs,
      });
      Object.assign(cleanup, survivorCleanup, { survivorDetected: true });
    }

    await Promise.all([stdout.close(), stderr.close()]);
    const result = {
      ...closed,
      cleanup,
      durationMs: Math.round(performance.now() - started),
      interrupted,
      logs: {
        stderr: await fileIdentity(root, stderrPath),
        stdout: await fileIdentity(root, stdoutPath),
      },
      pid: child.pid,
      timedOut,
      ...(spawnError ? { error: spawnError.message } : {}),
    };
    if (survivorDetected || cleanup.complete !== true) {
      const error = new Error(
        survivorDetected
          ? "local CI process group survived command close"
          : "local CI process group survived TERM and KILL",
      );
      error.result = result;
      throw error;
    }
    return result;
  } catch (error) {
    await Promise.allSettled([stdout.close(), stderr.close()]);
    throw error;
  }
}
