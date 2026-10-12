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

function groupAliveSafely(processGroupId) {
  try {
    return groupExists(processGroupId);
  } catch {
    return true;
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

async function retainGroupOwnerUntilExit(processGroupId) {
  while (true) {
    try {
      if (!groupExists(processGroupId)) return;
    } catch {
      // An unobservable group remains owned and unresolved.
    }
    await delay(20);
  }
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

/**
 * Optional bounded-close mode returns unknown cleanup with `error.lateClose`;
 * the caller must await it to keep ownership until close and group exit.
 */
export async function runLocalCiCommand(
  entry,
  {
    closeGraceMs = null,
    killGraceMs = 2_000,
    logDirectory,
    openFile = open,
    root,
    signal = null,
    spawnProcess = spawn,
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
  if (
    closeGraceMs !== null &&
    (!Number.isSafeInteger(closeGraceMs) || closeGraceMs <= 0)
  ) {
    throw new Error("local CI closeGraceMs must be a positive safe integer");
  }
  if (typeof spawnProcess !== "function") {
    throw new Error("local CI spawnProcess must be a function");
  }

  const absoluteLogDirectory = path.resolve(root, logDirectory);
  await mkdir(absoluteLogDirectory, { recursive: true });
  const stdoutPath = path.join(absoluteLogDirectory, `${taskId}.stdout.log`);
  const stderrPath = path.join(absoluteLogDirectory, `${taskId}.stderr.log`);
  const stdout = await openFile(stdoutPath, "wx");
  let stderr;
  try {
    stderr = await openFile(stderrPath, "wx");
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
  let cleanupError = null;
  let keepHandlesUntilLateClose = false;
  let notifyStopStarted;
  const stopStarted = new Promise((resolve) => {
    notifyStopStarted = resolve;
  });

  try {
    // Log setup awaits must not admit a child after cancellation closes admission.
    if (signal?.aborted) throw signal.reason ?? new Error("local CI interrupted");
    child = spawnProcess(commandExecutable(entry.command), entry.args, {
      cwd: path.resolve(root, entry.cwd ?? "."),
      detached: true,
      env: { ...process.env, ...(entry.env ?? {}) },
      shell: false,
      stdio: ["ignore", stdout.fd, stderr.fd],
    });

    const stop = () => {
      if (!cleanupPromise) {
        cleanupPromise = terminateProcessGroup(child.pid, {
          killGraceMs,
          termGraceMs,
        });
        if (closeGraceMs !== null) {
          cleanupPromise = cleanupPromise.catch((error) => {
            cleanupError = error;
            return {
              complete: false,
              groupAlive: true,
              killSent: false,
              termSent: false,
            };
          });
        }
        notifyStopStarted({ cleanup: cleanupPromise });
      }
      return cleanupPromise;
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

    const closePromise = new Promise((resolve) => {
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (exitCode, childSignal) => {
        resolve({ exitCode, signal: childSignal ?? null });
      });
    });
    let closed;
    if (closeGraceMs === null) {
      closed = await closePromise;
    } else {
      const observed = await Promise.race([
        closePromise.then((result) => ({ kind: "closed", result })),
        stopStarted.then(async ({ cleanup }) => {
          await cleanup;
          return Promise.race([
            closePromise.then((result) => ({ kind: "closed", result })),
            delay(closeGraceMs).then(() => ({ kind: "close-unobserved" })),
          ]);
        }),
      ]);
      if (observed.kind === "close-unobserved") {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", interrupt);
        const cleanup = await cleanupPromise;
        keepHandlesUntilLateClose = true;
        let groupAlive = true;
        try {
          groupAlive = cleanup.groupAlive || groupExists(child.pid);
        } catch {
          // An unobservable process group remains owned and unresolved.
        }
        const result = {
          closeObserved: false,
          cleanup: {
            ...cleanup,
            complete: false,
            groupAlive,
            closeObserved: false,
          },
          durationMs: Math.round(performance.now() - started),
          interrupted,
          logs: {
            stderr: { path: path.relative(root, stderrPath), complete: false },
            stdout: { path: path.relative(root, stdoutPath), complete: false },
          },
          pid: child.pid,
          processGroupId: child.pid,
          signal: null,
          exitCode: null,
          timedOut,
          termination: "unknown",
          ...(spawnError ? { error: spawnError.message } : {}),
          ...(cleanupError ? { cleanupError: cleanupError.message } : {}),
        };
        const lateClose = closePromise.then(async (late) => {
          await retainGroupOwnerUntilExit(child.pid);
          await Promise.all([stdout.close(), stderr.close()]);
          return {
            closeObserved: true,
            cleanup: { ...cleanup, complete: true, groupAlive: false },
            error: spawnError?.message ?? null,
            exitCode: late.exitCode,
            processGroupId: child.pid,
            signal: late.signal,
            termination: "late-close-and-group-exit-observed",
          };
        });
        const error = new Error(
          "local CI process group close was not observed after bounded TERM/KILL cleanup",
        );
        error.result = result;
        error.lateClose = lateClose;
        throw error;
      }
      closed = observed.result;
    }
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
    let survivorDetected;
    try {
      survivorDetected = cleanupPromise
        ? closeGraceMs === null
          ? groupExists(child.pid)
          : groupAliveSafely(child.pid)
        : !(await waitForGroupExit(child.pid, termGraceMs));
    } catch (error) {
      if (closeGraceMs === null) throw error;
      cleanupError = error;
      survivorDetected = true;
    }
    if (survivorDetected) {
      try {
        const survivorCleanup = await terminateProcessGroup(child.pid, {
          killGraceMs,
          termGraceMs,
        });
        Object.assign(cleanup, survivorCleanup, { survivorDetected: true });
      } catch (error) {
        if (closeGraceMs === null) throw error;
        cleanupError = error;
        Object.assign(cleanup, {
          complete: false,
          groupAlive: true,
          survivorDetected: true,
        });
      }
    }

    if (survivorDetected || cleanup.complete !== true) {
      const error = new Error(
        survivorDetected
          ? "local CI process group survived command close"
          : "local CI process group survived TERM and KILL",
      );
      if (closeGraceMs === null) {
        await Promise.all([stdout.close(), stderr.close()]);
        error.result = {
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
        throw error;
      }
      error.result = {
        ...closed,
        closeObserved: true,
        cleanup: {
          ...cleanup,
          complete: cleanup.complete,
          closeObserved: true,
        },
        durationMs: Math.round(performance.now() - started),
        interrupted,
        logs: {
          stderr: { path: path.relative(root, stderrPath), complete: false },
          stdout: { path: path.relative(root, stdoutPath), complete: false },
        },
        pid: child.pid,
        processGroupId: child.pid,
        timedOut,
        termination:
          cleanup.complete && !groupAliveSafely(child.pid)
            ? "close-and-group-exit-observed-after-cleanup"
            : "unknown",
        ...(spawnError ? { error: spawnError.message } : {}),
        ...(cleanupError ? { cleanupError: cleanupError.message } : {}),
      };
      if (cleanup.complete !== true) {
        keepHandlesUntilLateClose = true;
        error.lateClose = retainGroupOwnerUntilExit(child.pid).then(
          async () => {
            await Promise.all([stdout.close(), stderr.close()]);
            return {
              closeObserved: true,
              cleanup: { ...cleanup, complete: true, groupAlive: false },
              error: spawnError?.message ?? null,
              exitCode: closed.exitCode,
              processGroupId: child.pid,
              signal: closed.signal,
              termination: "late-group-exit-observed",
            };
          },
        );
      }
      throw error;
    }

    await Promise.all([stdout.close(), stderr.close()]);
    const logs = {
      stderr: await fileIdentity(root, stderrPath),
      stdout: await fileIdentity(root, stdoutPath),
    };
    if (closeGraceMs === null) {
      return {
        ...closed,
        cleanup,
        durationMs: Math.round(performance.now() - started),
        interrupted,
        logs,
        pid: child.pid,
        timedOut,
        ...(spawnError ? { error: spawnError.message } : {}),
      };
    }
    return {
      ...closed,
      closeObserved: true,
      cleanup: { ...cleanup, closeObserved: true },
      durationMs: Math.round(performance.now() - started),
      interrupted,
      logs,
      pid: child.pid,
      processGroupId: child.pid,
      timedOut,
      termination: "close-and-group-exit-observed",
      ...(spawnError ? { error: spawnError.message } : {}),
      ...(cleanupError ? { cleanupError: cleanupError.message } : {}),
    };
  } catch (error) {
    if (!keepHandlesUntilLateClose)
      await Promise.allSettled([stdout.close(), stderr.close()]);
    throw error;
  }
}
