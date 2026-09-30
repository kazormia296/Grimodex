import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Only the outer local-CI supervisor creates a process group and owns the task
// deadline (including startup). Never detach children from that group here.
async function runWithXvfb(command, args) {
  const children = new Set();
  let directory;
  let admissionClosed = false;
  let failure;
  let cancellationCode;
  let cleanup;
  let exitCode = 1;
  let stopWaiting;
  const stopped = new Promise((resolve) => {
    stopWaiting = resolve;
  });

  function start(executable, argv, options = {}) {
    if (admissionClosed) throw failure ?? new Error("Xvfb admission closed");
    const child = spawn(executable, argv, {
      stdio: "inherit",
      ...options,
      detached: false,
      shell: false,
    });
    const owned = { child, done: false, error: null };
    owned.closed = new Promise((resolve) => {
      child.once("error", (error) => {
        owned.error = error;
      });
      child.once("close", (code, signal) => {
        owned.done = true;
        children.delete(owned);
        resolve({ code, signal, error: owned.error });
      });
    });
    children.add(owned);
    return owned;
  }

  async function terminate(owned) {
    if (owned.done) return;
    owned.child.kill("SIGTERM");
    const escalation = setTimeout(() => owned.child.kill("SIGKILL"), 500);
    try {
      // A signal request is not exit evidence. Keep ownership until close;
      // the outer supervisor retains its existing deadline and final PG check.
      await owned.closed;
    } finally {
      clearTimeout(escalation);
    }
  }

  function closeAdmission() {
    admissionClosed = true;
    stopWaiting();
    cleanup ??= Promise.allSettled([...children].map(terminate)).then(
      (results) => {
        const errors = results.filter((result) => result.status === "rejected");
        if (errors.length)
          throw new AggregateError(
            errors.map((result) => result.reason),
            "Xvfb cleanup failed",
          );
      },
    );
    return cleanup;
  }

  function stop(error, code) {
    failure ??= error;
    cancellationCode ??= code;
    void closeAdmission().catch((error) => {
      failure ??= error;
    });
  }
  const onTerm = () =>
    stop(new Error("Xvfb command cancelled by SIGTERM"), 143);
  const onInt = () => stop(new Error("Xvfb command cancelled by SIGINT"), 130);
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  async function authorize(authFile, display, cookie) {
    const owned = start("xauth", ["-f", authFile, "source", "-"], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    // Do not expose the cookie in argv or logs. A failed stdin write is still
    // followed by child close, not treated as completed cleanup.
    owned.child.stdin.on("error", (error) => stop(error));
    owned.child.stdin.end(`add :${display} MIT-MAGIC-COOKIE-1 ${cookie}\n`);
    const result = await owned.closed;
    if (result.error || result.code !== 0) {
      throw (
        result.error ??
        new Error(`xauth failed (${result.code ?? result.signal})`)
      );
    }
  }

  try {
    if (!command)
      throw new Error("Usage: local-ci-xvfb.mjs <command> [args...]");
    directory = await mkdtemp(path.join(os.tmpdir(), "grimodex-xvfb-"));
    const authFile = path.join(directory, "Xauthority");
    await writeFile(authFile, "", { mode: 0o600 });
    const cookie = randomBytes(16).toString("hex");
    // Xvfb loads the cookie before accepting clients, independently of the
    // display number in this record. Add the client's actual display below.
    await authorize(authFile, 0, cookie);
    const server = start(
      "Xvfb",
      [
        "-displayfd",
        "3",
        "-screen",
        "0",
        "1920x1080x24",
        "-nolisten",
        "tcp",
        "-auth",
        authFile,
      ],
      { stdio: ["ignore", "inherit", "inherit", "pipe"] },
    );
    void server.closed.then((result) => {
      if (!admissionClosed) {
        stop(
          result.error ??
            new Error(`Xvfb exited (${result.code ?? result.signal})`),
        );
      }
    });

    const display = await new Promise((resolve, reject) => {
      let record = "";
      let ready = false;
      const pipe = server.child.stdio[3];
      const fail = (error) => {
        stop(error);
        reject(error);
      };
      const onEnd = () => {
        if (!ready) fail(new Error("Xvfb closed displayfd before readiness"));
      };
      const onData = (data) => {
        if (admissionClosed) return;
        if (ready || record.length + data.length > 12) {
          fail(new Error("Invalid Xvfb displayfd record"));
          return;
        }
        record += data.toString("latin1");
        if (!/^\d*\n?$/u.test(record)) {
          fail(new Error("Invalid Xvfb displayfd record"));
        } else if (record.endsWith("\n")) {
          const number = Number(record.trim());
          if (
            !Number.isSafeInteger(number) ||
            number > 65535 ||
            record === "\n"
          ) {
            fail(new Error("Invalid Xvfb display number"));
          } else {
            ready = true;
            resolve(number);
          }
        }
      };
      pipe.on("data", onData);
      pipe.once("end", onEnd);
      pipe.once("error", fail);
      void stopped.then(() => reject(failure ?? new Error("Xvfb stopped")));
    });
    await authorize(authFile, display, cookie);
    if (server.done)
      throw failure ?? new Error("Xvfb exited before command admission");
    const application = start(command, args, {
      env: { ...process.env, DISPLAY: `:${display}`, XAUTHORITY: authFile },
    });
    const result = await application.closed;
    if (result.error) throw result.error;
    exitCode = result.signal
      ? 128 + (os.constants.signals[result.signal] ?? 1)
      : (result.code ?? 1);
  } catch (error) {
    failure ??= error;
  } finally {
    await closeAdmission();
    if (directory) await rm(directory, { recursive: true, force: true });
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
    if (failure) {
      console.error(failure.message);
      // Even a child exiting zero cannot hide server/startup/cleanup failure.
      exitCode = cancellationCode ?? 1;
    }
  }
  return exitCode;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const code = await runWithXvfb(process.argv[2], process.argv.slice(3));
  process.exitCode = code;
}
