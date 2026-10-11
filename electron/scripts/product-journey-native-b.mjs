import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeBEnvironment, readNativeBBoundary } from "../../scripts/local-ci-xvfb.mjs";

const DRIVER_METHODS = ["Hello", "NameHasOwner", "GetNameOwner", "GetId", "AddMatch", "RemoveMatch", "RequestName"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const escapeXml = (value) => String(value).replace(/[&<>"']/gu, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
const INITIALIZER = fileURLToPath(new URL("../../scripts/local-ci-native-b.py", import.meta.url));

export function nativeBBusConfig(uid, socket) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !path.isAbsolute(socket) || socket.includes("\0")) {
    throw new Error("native B bus configuration identity invalid");
  }
  return `<busconfig>
  <type>session</type>
  <listen>unix:path=${escapeXml(socket)}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <deny user="*"/>
    <allow user="${uid}"/>
    <deny own="*"/>
    <deny send_destination="*"/>
    <deny receive_sender="*"/>
    <allow receive_sender="org.freedesktop.DBus"/>
${DRIVER_METHODS.map((method) => `    <allow send_destination="org.freedesktop.DBus" send_interface="org.freedesktop.DBus" send_member="${method}" send_type="method_call"/>`).join("\n")}
    <deny send_destination="org.freedesktop.DBus" send_member="StartServiceByName"/>
  </policy>
</busconfig>\n`;
}

export function nativeBElectronEnvironment(environment, address) {
  const selected = nativeBEnvironment(environment);
  if (!/^unix:path=\/[^,;\s]+,guid=[0-9a-f]{32}$/u.test(address)) throw new Error("native B owned bus address invalid");
  if (!/^:\d+$/u.test(environment.DISPLAY ?? "") || !path.isAbsolute(environment.XAUTHORITY ?? "")) {
    throw new Error("native B requires the owned Xvfb environment");
  }
  return {
    ...selected, PATH: environment.PATH, HOME: environment.HOME,
    TMPDIR: "/tmp", XDG_RUNTIME_DIR: environment.XDG_RUNTIME_DIR,
    DISPLAY: environment.DISPLAY, XAUTHORITY: environment.XAUTHORITY,
    XDG_SESSION_TYPE: "x11", GRIMODEX_LOCAL_CI_XVFB: "1", DBUS_SESSION_BUS_ADDRESS: address,
  };
}

export function assertNativeBQualification(boundary) {
  const qualification = boundary?.qualification;
  if (!qualification || !/^[0-9a-f]{64}$/u.test(qualification.intentDigest ?? "") ||
      !["pathnameDenied", "abstractDenied", "tcpDenied", "hostViewDenied"].every((key) => qualification.routes?.[key] === true) ||
      !["setsidDoubleFork", "stdoutEOF", "stderrEOF", "descendantsAbsent"].every((key) => qualification.retirement?.[key] === true) ||
      qualification.retirement.reaped !== 2) {
    throw new Error("native B actual route/retirement prerequisite absent");
  }
  return qualification;
}

async function durableJson(file, record) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

// One harness owns the live daemon and every pending qualification child.
// The enclosing dropped native PID1 owns adopted/setsid/double-fork escapees.
export function createNativeBBusOwner({ signal, spawnProcess = spawn, readBoundary = readNativeBBoundary, onFailure = () => undefined } = {}) {
  let admissionClosed = false;
  let directory;
  let config;
  let configDigest;
  let child;
  let startPromise;
  let qualificationPromise;
  let qualificationEvidence;
  let boundaryBinding;
  let closedPromise;
  let retirement;
  let failure;
  let endpoint;
  let done = false;
  const probes = new Set();
  const closeAdmission = () => { admissionClosed = true; };
  function fail(error) {
    if (!failure) { failure = error; onFailure(); }
    closeAdmission();
  }
  async function bounded(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("native B retirement unobserved; owner quarantined")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  signal?.addEventListener("abort", closeAdmission, { once: true });
  function assertOpen() {
    if (signal?.aborted) closeAdmission();
    if (admissionClosed || failure || done) throw new Error("native B bus admission closed");
  }
  function stopProbe(probe) {
    if (probe.done || probe.stopping) return;
    probe.stopping = true;
    try { if (!probe.child.kill("SIGTERM")) fail(new Error("native B client kill refused")); } catch (error) { fail(error); }
    probe.escalation = setTimeout(() => {
      if (!probe.done) try { probe.child.kill("SIGKILL"); } catch (error) { fail(error); }
    }, 500);
  }

  // Fixed Python modes only. Private inputs are stdin, never argv or logs.
  async function probe(mode, request, expected) {
    assertOpen();
    const processChild = spawnProcess("/usr/bin/python3", ["-I", INITIALIZER, mode], {
      env: { PATH: "/usr/bin:/bin", HOME: "/home/runner", TMPDIR: "/tmp" },
      stdio: ["pipe", "pipe", "pipe"], detached: false, shell: false,
    });
    const owned = { child: processChild, done: false, stopping: false, ends: 0, text: "", bytes: 0, late: null };
    probes.add(owned);
    owned.closed = new Promise((resolve) => {
      processChild.once("error", fail);
      processChild.once("close", (code, childSignal) => {
        owned.done = true;
        clearTimeout(owned.escalation);
        resolve({ code, signal: childSignal });
      });
    });
    processChild.stdin.on("error", fail);
    for (const stream of [processChild.stdout, processChild.stderr]) {
      stream.on("error", fail);
      stream.once("end", () => { owned.ends++; });
      stream.on("data", (data) => {
        owned.bytes += data.length;
        if (owned.bytes > 8192) { fail(new Error("native B client output overflow")); stopProbe(owned); return; }
        if (stream !== processChild.stdout) return; // Never publish stderr.
        owned.text += data.toString("utf8");
        if (mode === "--cancel-client" && owned.text === "ready-for-input\n" && !owned.stopping) {
          // Real child is blocked awaiting input. Close its admission first;
          // a real delayed callback must not deliver an endpoint after cancel.
          stopProbe(owned);
          owned.late = new Promise((resolve) => setImmediate(() => {
            if (!owned.stopping) { fail(new Error("native B late client admission escaped")); processChild.stdin.end("invalid"); }
            resolve();
          }));
        }
      });
    }
    const timeout = setTimeout(() => { fail(new Error("native B qualification client timed out")); stopProbe(owned); }, 5000);
    try {
      if (mode !== "--cancel-client") processChild.stdin.end(JSON.stringify(request));
      const result = await bounded(owned.closed);
      await owned.late;
      if (failure || result.code !== 0 || result.signal || owned.ends !== 2) throw new Error("native B client exit/EOF/join failed");
      if (mode === "--cancel-client") {
        if (owned.text !== "ready-for-input\ncancelled-before-input\n" || !owned.stopping || !owned.late) {
          throw new Error("native B real pending cancellation failed");
        }
      } else if (JSON.stringify(JSON.parse(owned.text)) !== JSON.stringify(expected)) {
        throw new Error("native B semantic qualification failed");
      }
      probes.delete(owned);
      return { exit: 0, stdoutEOF: true, stderrEOF: true, joined: true };
    } catch { const error = new Error("native B qualification client failed; owner quarantined"); fail(error); stopProbe(owned); throw error; }
    finally { clearTimeout(timeout); }
  }

  async function start() {
    assertOpen();
    if (startPromise) return startPromise;
    startPromise = (async () => {
      const boundary = await readBoundary();
      if (!boundary) throw new Error("native B namespace prerequisite absent");
      assertOpen();
      directory = await mkdtemp(path.join(os.tmpdir(), "grimodex-native-b-bus-"));
      assertOpen();
      const socket = path.join(directory, "bus");
      config = path.join(directory, "bus.conf");
      const bytes = nativeBBusConfig(boundary.uid, socket);
      configDigest = digest(bytes);
      await writeFile(config, bytes, { mode: 0o600, flag: "wx" });
      if (qualificationPromise) {
        await durableJson("/run/grimodex-native-b/daemon-start.json", {
          intentDigest: boundary.qualification.intentDigest, configDigest, boundaryBinding,
          daemonDigest: boundary.qualification.identities.daemon.sha256, possibleStart: true,
        });
      }
      assertOpen();
      child = spawnProcess("/usr/bin/dbus-daemon", ["--nofork", `--config-file=${config}`, "--print-address=3"], {
        env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, TMPDIR: "/tmp" },
        stdio: ["ignore", "pipe", "pipe", "pipe"], detached: false, shell: false,
      });
      let ends = 0;
      closedPromise = new Promise((resolve) => {
        child.once("error", fail);
        child.once("close", (code, childSignal) => {
          done = true;
          if (!admissionClosed || ends !== 3 || (code !== 0 && !["SIGTERM", "SIGKILL"].includes(childSignal))) {
            fail(new Error("native B daemon unexpected exit/EOF"));
          }
          resolve({ code, signal: childSignal });
        });
      });
      for (const stream of [child.stdout, child.stderr, child.stdio[3]]) {
        stream.on("error", fail);
        stream.once("end", () => { ends++; });
      }
      child.stdout.resume(); child.stderr.resume();
      endpoint = await new Promise((resolve, reject) => {
        let text = "";
        let ready = false;
        const stream = child.stdio[3];
        stream.on("error", reject);
        stream.on("data", (chunk) => {
          if (ready || text.length + chunk.length > 1024 || admissionClosed) {
            fail(new Error("native B address stream rejected")); reject(failure); return;
          }
          text += chunk.toString("utf8");
          if (text.endsWith("\n")) {
            const address = text.slice(0, -1);
            if (!address.startsWith(`unix:path=${socket},guid=`) || !/^[0-9a-f]{32}$/u.test(address.split(",guid=")[1] ?? "")) {
              fail(new Error("native B address identity rejected")); reject(failure); return;
            }
            ready = true; resolve(address);
          }
        });
        stream.once("end", () => { if (!ready) reject(new Error("native B address EOF before readiness")); });
        void closedPromise.then(() => reject(new Error("native B daemon closed during startup")));
      });
      assertOpen();
      return endpoint;
    })().catch(() => { const error = new Error("native B daemon start failed; owner quarantined"); fail(error); throw error; });
    return startPromise;
  }

  async function verifySources(qualification) {
    for (const file of ["scripts/local-ci-xvfb.mjs", "scripts/local-ci-native-b.py",
      "electron/scripts/product-journey-native-b.mjs", "electron/scripts/product-journey-harness.mjs",
      "electron/scripts/product-journeys.mjs"]) {
      if (digest(await readFile(file)) !== qualification.source[file]) throw new Error("native B qualification source changed");
    }
  }

  async function verifyBinding() {
    assertOpen();
    const boundary = await readBoundary();
    assertNativeBQualification(boundary);
    await verifySources(boundary.qualification);
    if (digest(JSON.stringify(boundary)) !== boundaryBinding || !child || done ||
        digest(await readFile(config)) !== configDigest ||
        digest(await readFile("/usr/bin/dbus-daemon")) !== boundary.qualification.identities.daemon.sha256 ||
        digest(await readFile(INITIALIZER)) !== boundary.qualification.source["scripts/local-ci-native-b.py"]) {
      throw new Error("native B live qualification binding changed");
    }
    assertOpen();
  }

  async function qualify() {
    assertOpen();
    qualificationPromise ??= (async () => {
      const boundary = await readBoundary();
      const qualification = assertNativeBQualification(boundary);
      boundaryBinding = digest(JSON.stringify(boundary));
      await durableJson("/run/grimodex-native-b/bus-qualification-start.json", { intentDigest: qualification.intentDigest,
        boundaryBinding, possibleStart: true });
      assertOpen();
      await verifySources(qualification);
      // Reject missing/changed binaries/source BEFORE the primary daemon.
      if (digest(await readFile("/usr/bin/dbus-daemon")) !== qualification.identities.daemon.sha256 ||
          digest(await readFile("/usr/bin/dbus-send")) !== qualification.identities.client.sha256 ||
          digest(await readFile(INITIALIZER)) !== qualification.source["scripts/local-ci-native-b.py"]) {
        throw new Error("native B qualification installed identity changed");
      }
      await start();
      const socket = endpoint.slice("unix:path=".length).split(",guid=")[0];
      const socketMetadata = await lstat(socket);
      if (!socketMetadata.isSocket() || socketMetadata.uid !== boundary.uid) throw new Error("native B socket owner invalid");
      await chmod(socket, 0o600);
      const invalid = path.join(directory, "malformed.conf");
      const malformed = "<busconfig><auth>EXTERNAL</auth></broken>\n";
      await writeFile(invalid, malformed, { mode: 0o600, flag: "wx" });
      const request = { address: null, config: invalid, configDigest: digest(malformed), intentDigest: qualification.intentDigest };
      const malformedJoin = await probe("--reject-config", request, { malformedConfigDenied: true });
      const cancelJoin = await probe("--cancel-client");
      const semantic = { external: true, anonymousDenied: true, spoofDenied: true,
        ownershipDenied: true, activationDenied: true, destinationDenied: true };
      const semanticJoin = await probe("--qualify-bus", { ...request, address: endpoint, config, configDigest }, semantic);
      await verifyBinding();
      qualificationEvidence = { intentDigest: qualification.intentDigest, boundaryBinding, configDigest,
        run: qualification.run, attempt: qualification.attempt, head: qualification.head,
        nativeRoutes: qualification.routes, nativeProbeRetirement: qualification.retirement,
        semantic, malformedJoin, cancelJoin, semanticJoin };
      await durableJson("/run/grimodex-native-b/bus-qualification.json", qualificationEvidence);
      assertOpen();
    })().catch(() => { const error = new Error("native B qualification failed; owner quarantined"); fail(error); throw error; });
    await qualificationPromise;
    await verifyBinding(); // Same live owner/config on configure/write/restart.
    return endpoint;
  }

  function retire() {
    closeAdmission();
    retirement ??= (async () => {
      let escalation;
      for (const probe of probes) stopProbe(probe);
      if (child && !done) {
        try { child.kill("SIGTERM"); } catch (error) { fail(error); }
        escalation = setTimeout(() => { if (!done) try { child.kill("SIGKILL"); } catch (error) { fail(error); } }, 500);
      }
      try {
        await bounded(qualificationPromise?.catch(() => undefined));
        await bounded(startPromise?.catch(() => undefined));
        for (const probe of probes) { await bounded(probe.closed); await bounded(probe.late); }
        if (child) await bounded(closedPromise);
      } finally { clearTimeout(escalation); }
      if (failure) throw new Error("native B daemon/client retirement failed; owner quarantined");
      if (directory) await rm(directory, { recursive: true, force: false });
      signal?.removeEventListener("abort", closeAdmission);
    })();
    return retirement;
  }
  return { start, qualify, retire, closeAdmission,
    evidence() { assertOpen(); if (!qualificationEvidence) throw new Error("native B qualification incomplete"); return structuredClone(qualificationEvidence); } };
}
