import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NATIVE_B_RECEIPT = "/run/grimodex-native-b/admission.json";
const NATIVE_B_ENVIRONMENT = [
  "LANG", "TZ", "CI", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GRIMODEX_PRODUCT_JOURNEY_IDS",
  "GRIMODEX_PRODUCT_JOURNEY_CATALOG_DIGEST", "GRIMODEX_PRODUCT_JOURNEY_BUILD_RECEIPT",
  "GRIMODEX_C2ZC_RUST_RECEIPT_PATH", "GRIMODEX_C2ZC_RUST_RECEIPT_SHA256",
  "GRIMODEX_C2ZC_RUST_REQUESTED_BASE", "GRIMODEX_C2ZC_RUST_REQUESTED_HEAD",
  "GRIMODEX_C2ZC_RESTORE_FIXTURE",
];

export function isNativeBJourney(command, args) {
  return (command === "node" || command === process.execPath) &&
    ["electron/scripts/product-journeys.mjs", "electron/scripts/product-journey-shards.mjs"].includes(args[0]);
}

export function nativeBRootMarker(args) {
  if (args.length === 1 && args[0] === "electron/scripts/product-journeys.mjs") {
    return ".artifacts/native-b-root";
  }
  if (args.length !== 6 || args[0] !== "electron/scripts/product-journey-shards.mjs" ||
      args[1] !== "run" || args[2] !== "--shard" || !["1", "2", "3", "4", "5", "6", "7"].includes(args[3]) ||
      args[4] !== "--output-dir" || typeof args[5] !== "string" || /\s/u.test(args[5]) ||
      !/^\.artifacts\/local-ci\/runs\/[A-Za-z0-9_-]+\/product-journeys$/u.test(args[5])) {
    throw new Error("native B only the existing canonical journey command is admitted");
  }
  const run = createHash("sha256").update(args[5]).digest("hex");
  return `.artifacts/native-b-root-${run}-shard-${args[3]}`;
}

export function nativeBIncludesEditor(args, environment) {
  nativeBRootMarker(args);
  if (args[0] === "electron/scripts/product-journey-shards.mjs") return args[3] === "1";
  if (!environment.GRIMODEX_PRODUCT_JOURNEY_IDS) return true;
  const ids = JSON.parse(environment.GRIMODEX_PRODUCT_JOURNEY_IDS);
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string")) {
    throw new Error("native B journey selection invalid");
  }
  return ids.includes("editor-persistence");
}

// Only owned synthetic listeners; never discover/contact a host bus/service.
// The existing wrapper owns pending listen and every accepted socket through
// close. Endpoints travel only in private stdin/receipt, not logs/artifacts.
export async function createNativeBRouteSentinels(assertOpen, onFailure) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grimodex-b-routes-"));
  const listeners = [];
  const sockets = new Set();
  const socketJoins = [];
  let rejected = false;
  let retirement;
  const fail = () => { rejected = true; onFailure(new Error("native B owned host route reached or failed")); };
  const retire = () => retirement ??= (async () => {
    for (const socket of sockets) socket.destroy();
    let timer;
    try {
      await Promise.race([Promise.all(listeners.map(async ({ server, ready, joined }) => {
        await ready.catch(() => undefined);
        server.close();
        await joined;
      })).then(() => Promise.all(socketJoins)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("native B sentinel close/join unknown; owner retained")), 5000);
      })]);
    } finally { clearTimeout(timer); }
    if (rejected) throw new Error("native B sentinel retirement failed; owner retained");
    await rm(directory, { recursive: true, force: false });
  })();
  try {
    await writeFile(path.join(directory, "host-only"), "synthetic-owned-route-sentinel", { mode: 0o600, flag: "wx" });
    const token = randomBytes(16).toString("hex");
    const routes = { pathname: path.join(directory, "system-desktop-secret"), abstract: `\0grimodex-b-${token}`, tcp: 0,
      file: path.join(directory, "host-only") };
    for (const route of [routes.pathname, routes.abstract, { host: "127.0.0.1", port: 0 }]) {
      assertOpen();
      const server = createServer((socket) => {
        sockets.add(socket);
        socketJoins.push(new Promise((resolve) => socket.once("close", () => { sockets.delete(socket); resolve(); })));
        socket.on("error", fail);
        fail(); socket.destroy();
      });
      const joined = new Promise((resolve) => server.once("close", resolve));
      const ready = new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      server.on("error", fail);
      listeners.push({ server, ready, joined });
      server.listen(route);
      await ready;
      assertOpen();
      if (typeof route === "object") routes.tcp = server.address().port;
    }
    return { routes, retire };
  } catch (error) {
    await retire();
    throw error;
  }
}

export function nativeBEnvironment(environment) {
  // Reject selectors, rather than silently overwriting an injected route or
  // sandbox bypass. Namespace containment remains a separate prerequisite.
  for (const [key, value] of Object.entries(environment)) {
    if (value && (/^(?:DBUS_|WAYLAND_|LD_|NODE_OPTIONS$|NODE_PATH$)/u.test(key) ||
      key === "ELECTRON_DISABLE_SANDBOX" || key === "ELECTRON_RENDERER_URL")) {
      throw new Error("native B rejects external route/runtime selectors");
    }
  }
  return Object.fromEntries(NATIVE_B_ENVIRONMENT.filter((key) => environment[key] !== undefined)
    .map((key) => [key, environment[key]]));
}

export async function readNativeBBoundary() {
  const metadata = await lstat(NATIVE_B_RECEIPT).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 ||
      metadata.uid !== process.getuid() || metadata.size > 4096) {
    throw new Error("native B admission identity invalid");
  }
  const record = JSON.parse(await readFile(NATIVE_B_RECEIPT, "utf8"));
  const status = await readFile("/proc/self/status", "utf8");
  const root = await lstat("/");
  if (record.resources?.state !== "private-accepted" || !/^[0-9a-f]{64}$/u.test(record.resources.estimateDigest ?? "") ||
      !/^[0-9a-f-]{36}$/u.test(record.resources.localRunId ?? "")) throw new Error("native B actual private resource gate absent");
  if (root.ino !== record.root || root.dev !== record.rootDevice) throw new Error("native B root identity invalid");
  if (record.version !== "B-native-privileged-setup-v1" || record.uid !== process.getuid() ||
      record.gid !== process.getgid() || record.uid === 0 || process.getgroups().some((gid) => gid !== record.gid)) {
    throw new Error("native B workload identity invalid");
  }
  for (const key of ["CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd"]) {
    const current = status.match(new RegExp(`^${key}:\\s*([0-9a-f]+)$`, "mu"))?.[1];
    if (!current || !/^0+$/u.test(current) || record.capabilities[key] !== current) {
      throw new Error("native B workload capability drop invalid");
    }
  }
  if (!/^NoNewPrivs:\s*0$/mu.test(status)) throw new Error("native B sandbox prerequisite invalid");
  for (const name of ["mnt", "net", "pid", "ipc"]) {
    const current = await readlink(`/proc/self/ns/${name}`);
    if (record.namespaces[name] !== current || record.hostNamespaces[name] === current) {
      throw new Error("native B namespace identity invalid");
    }
  }
  return record;
}

// Only the outer local-CI supervisor creates a process group and owns the task
// deadline (including startup). Never detach children from that group here.
async function runWithXvfb(command, args) {
  const children = new Set();
  let directory;
  let nativeEnvironment;
  let routeSentinels;
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
      ...(nativeEnvironment ? { env: nativeEnvironment } : {}),
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

  async function captureGit(args) {
    const owned = start("/usr/bin/git", ["--no-replace-objects", "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", ...args], {
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => stop(new Error("native B Git capture timed out")), 10_000);
    for (const stream of [owned.child.stdout, owned.child.stderr]) {
      stream.on("error", () => stop(new Error("native B Git capture stream failed")));
      stream.on("data", (data) => {
        bytes += data.length;
        if (bytes > 1024 * 1024) stop(new Error("native B Git capture overflow"));
        else if (stream === owned.child.stdout) chunks.push(data);
      });
    }
    try {
      const result = await owned.closed;
      if (failure || admissionClosed || result.error || result.signal || result.code !== 0) {
        throw new Error("native B Git capture failed; no setup admission");
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      clearTimeout(timer);
    }
  }

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
    if (command.startsWith("--")) throw new Error("Xvfb wrapper flags are not admitted");
    if (process.platform === "linux" && isNativeBJourney(command, args) && nativeBIncludesEditor(args, process.env)) {
      const environment = nativeBEnvironment(process.env);
      const rootMarker = nativeBRootMarker(args);
      const boundary = await readNativeBBoundary();
      if (!boundary) {
        if (process.env.GITHUB_ACTIONS !== "true" || process.getuid() === 0) {
          throw new Error("native B setup requires the admitted ordinary GitHub runner");
        }
        // The real harness still resolves and fingerprints this view itself.
        // Never forward Git config, hooks, credentials, external object aliases,
        // or a precomputed candidate hash as a substitute for that live check.
        const gitDirectory = await lstat(path.join(process.cwd(), ".git"));
        if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) {
          throw new Error("native B requires the ordinary hosted checkout Git directory");
        }
        const baseRef = environment.GRIMODEX_C2ZC_RUST_REQUESTED_BASE ?? "origin/master";
        const headRef = environment.GRIMODEX_C2ZC_RUST_REQUESTED_HEAD ?? "HEAD";
        if (!/^(?:origin\/master|[0-9a-f]{40})$/u.test(baseRef) ||
            !/^(?:HEAD|[0-9a-f]{40})$/u.test(headRef)) {
          throw new Error("native B Git selectors not admitted");
        }
        if (await captureGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
          throw new Error("native B requires the existing clean candidate");
        }
        const currentHead = (await captureGit(["rev-parse", "--verify", "HEAD"])).trim();
        const tree = (await captureGit(["rev-parse", "--verify", "HEAD^{tree}"])).trim();
        const base = (await captureGit(["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
        const head = (await captureGit(["rev-parse", "--verify", `${headRef}^{commit}`])).trim();
        if (head !== currentHead || !/^[0-9a-f]{40}$/u.test(head) || !/^[0-9a-f]{40}$/u.test(base)) {
          throw new Error("native B Git identity changed");
        }
        const tracked = (await captureGit(["ls-files", "-z"])).split("\0").filter(Boolean);
        const gitView = { head, base, tracked };
        const hostNamespaces = Object.fromEntries(await Promise.all(
          ["mnt", "net", "pid", "ipc"].map(async (name) => [name, await readlink(`/proc/self/ns/${name}`)]),
        ));
        async function prepareQualification() {
          if (!nativeBIncludesEditor(args, environment)) return null;
          if (!/^[1-9]\d*$/u.test(environment.GITHUB_RUN_ID ?? "") ||
              !/^[1-9]\d*$/u.test(environment.GITHUB_RUN_ATTEMPT ?? "")) {
            throw new Error("native B qualification requires current hosted attempt identity");
          }
          const identities = {};
          for (const [id, executable] of Object.entries({ sudo: "/usr/bin/sudo", unshare: "/usr/bin/unshare",
            env: "/usr/bin/env", python: "/usr/bin/python3", daemon: "/usr/bin/dbus-daemon",
            client: "/usr/bin/dbus-send", xvfb: "/usr/bin/Xvfb", xauth: "/usr/bin/xauth", node: process.execPath })) {
            const file = await realpath(executable);
            const metadata = await lstat(file);
            if (!metadata.isFile() || metadata.mode & 0o022) throw new Error("native B binary identity unsafe");
            identities[id] = { sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
              uid: metadata.uid, mode: metadata.mode & 0o7777 };
          }
          const source = {};
          for (const file of ["scripts/local-ci-full-filesystems.py", "scripts/local-ci-full-admission.mjs",
            "scripts/local-ci-xvfb.mjs", "scripts/local-ci-native-b.py",
            "electron/scripts/product-journey-native-b.mjs", "electron/scripts/product-journey-harness.mjs",
            "electron/scripts/product-journeys.mjs"]) {
            source[file] = createHash("sha256").update(await readFile(file)).digest("hex");
          }
          const intent = { version: "B-native-privileged-setup-v1", possibleStart: true,
            run: environment.GITHUB_RUN_ID, attempt: environment.GITHUB_RUN_ATTEMPT,
            head, tree, base, commandDigest: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
            ownerPid: process.pid, hostNamespaces, identities, source,
            environmentDigest: createHash("sha256").update(JSON.stringify(environment)).digest("hex") };
          await mkdir(".artifacts", { recursive: true, mode: 0o700 });
          const artifacts = await lstat(".artifacts");
          if (!artifacts.isDirectory() || artifacts.isSymbolicLink() || artifacts.uid !== process.getuid() || artifacts.mode & 0o022) {
            throw new Error("native B qualification evidence owner invalid");
          }
          const bytes = JSON.stringify(intent);
          const file = await open(`${rootMarker}-qualification.json`, "wx", 0o600);
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
          const parent = await open(".artifacts", "r");
          try { await parent.sync(); } finally { await parent.close(); }
          // Exclusive persistent intent survives failed setup/qualification;
          // no rerun or Editor count is inferred from an absent terminal file.
          const assertOpen = () => { if (admissionClosed) throw new Error("native B qualification admission closed"); };
          assertOpen();
          routeSentinels = await createNativeBRouteSentinels(assertOpen, (error) => stop(error));
          return { intentDigest: createHash("sha256").update(bytes).digest("hex"),
            identities, source, head, base, run: intent.run, attempt: intent.attempt, routes: routeSentinels.routes };
        }
        // Host-only admission precedes canonical stage1. This unchanged shard
        // reaches initial setup only after its exact producer dependencies pass.
        if (args[0] !== "electron/scripts/product-journey-shards.mjs" || args[3] !== "1") {
          throw new Error("native B requires the original canonical Full Editor consumer");
        }
        const localRunId = args[5].match(/^\.artifacts\/local-ci\/runs\/([0-9a-f-]{36})\/product-journeys$/u)?.[1];
        const { readFullHostAdmission } = await import("./local-ci-full-admission.mjs");
        const resourceAdmission = await readFullHostAdmission(process.cwd(), { head, base, tree, localRunId,
          runId: environment.GITHUB_RUN_ID, attempt: environment.GITHUB_RUN_ATTEMPT });
        if (admissionClosed) throw new Error("native B private resource admission closed");
        const qualification = await prepareQualification();
        const request = JSON.stringify({
          uid: process.getuid(), gid: process.getgid(), checkout: process.cwd(),
          node: process.execPath, args, environment, hostNamespaces, gitView, qualification,
          resourceAdmission: { path: resourceAdmission.path, sha256: resourceAdmission.sha256 },
        });
        if (Buffer.byteLength(request) > 1024 * 1024) {
          throw new Error("native B setup source manifest overflow");
        }
        const initializer = fileURLToPath(new URL("./local-ci-native-b.py", import.meta.url));
        const launcher = start("/usr/bin/sudo", [
          "-n", "/usr/bin/unshare", "--mount", "--net", "--pid", "--ipc", "--fork",
          "--kill-child=SIGKILL", "--propagation", "private", "/usr/bin/env", "-i",
          "/usr/bin/python3", "-I", initializer,
        ], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
        // The single fixed request is consumed during initial setup only.
        for (const [stream, destination] of
          [[launcher.child.stdout, process.stdout], [launcher.child.stderr, process.stderr]]) {
          stream.on("error", (error) => stop(error));
          stream.pipe(destination, { end: false });
        }
        launcher.child.stdin.on("error", (error) => stop(error));
        launcher.child.stdin.end(`${request}\n`);
        const result = await launcher.closed;
        if (result.error || result.signal || result.code !== 0) {
          throw new Error("native B setup/workload retirement failed; owner retained");
        }
        // PID1 only reports zero after reaping all contained descendants and
        // joining both workload EOFs; launcher close joins the outer pipes.
        await closeAdmission();
        if (failure) throw failure;
        // Only this owner's now-unmounted empty marker is removed, never an
        // artifact/cache tree. Failure/unknown keeps it to fence replacement.
        await routeSentinels?.retire();
        await rmdir(path.join(process.cwd(), rootMarker));
        exitCode = 0;
        return exitCode;
      }
      nativeEnvironment = {
        ...environment, PATH: process.env.PATH, HOME: process.env.HOME,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, TMPDIR: "/tmp",
      };
    }
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
    // Chromium selects native Wayland from the session even when DISPLAY is
    // set. Keep applications on the Xvfb server this wrapper owns.
    const env = {
      ...(nativeEnvironment ?? process.env),
      DISPLAY: `:${display}`,
      XAUTHORITY: authFile,
      XDG_SESSION_TYPE: "x11",
      GRIMODEX_LOCAL_CI_XVFB: "1",
    };
    delete env.WAYLAND_DISPLAY;
    delete env.WAYLAND_SOCKET;
    const application = start(command, args, { env });
    const result = await application.closed;
    if (result.error) throw result.error;
    exitCode = result.signal
      ? 128 + (os.constants.signals[result.signal] ?? 1)
      : (result.code ?? 1);
  } catch (error) {
    failure ??= error;
  } finally {
    await closeAdmission();
    try { await routeSentinels?.retire(); } catch (error) { failure ??= error; }
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
