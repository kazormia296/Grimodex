import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLocalCiCommand } from "./local-ci-process-supervisor.mjs";

const directory = ".artifacts/ci-os-suitability";
const executables = ["/usr/bin/env", "/usr/bin/unshare", "/usr/bin/python3"];
const namespaces = ["user", "mnt", "net", "pid"];

async function inspectExecutable(file) {
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) return { status: "unknown" };
    await access(file, constants.X_OK);
    return {
      status: "available", uid: metadata.uid, mode: metadata.mode & 0o7777,
      sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
    };
  } catch (error) {
    return { status: error.code === "ENOENT" ? "missing" : error.code === "EACCES" ? "denied" : "unknown" };
  }
}

async function parentNamespaces() {
  return Object.fromEntries(await Promise.all(namespaces.map(async (name) => {
    const identity = await readlink(`/proc/self/ns/${name}`);
    if (!new RegExp(`^${name}:\\[\\d+\\]$`, "u").test(identity)) throw new Error("unknown namespace identity");
    return [name, identity];
  })));
}

// This checks namespace permission only. It does NOT mask filesystem bus routes,
// establish bus authentication/activation policy, or admit a future B instance.
export async function checkExistingOsSuitability({
  root = process.cwd(), runCommand = runLocalCiCommand,
  inspect = inspectExecutable, readNamespaces = parentNamespaces, openFile = open,
} = {}) {
  const output = path.join(root, directory);
  await mkdir(path.join(root, ".artifacts"), { recursive: true });
  await mkdir(output, { mode: 0o700 }); // Exclusive claim: never replace an unresolved owner.
  const save = async (name, value, replace = false) => {
    const file = await openFile(path.join(output, name), replace ? "w" : "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    const directoryHandle = await open(output, "r");
    try { await directoryHandle.sync(); }
    finally { await directoryHandle.close(); }
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const facts = { executables: {}, status: "unknown" };
  try {
    for (const file of executables) facts.executables[file] = await inspect(file);
    if (Object.values(facts.executables).some(({ status }) => status !== "available")) {
      facts.status = "unsupported";
      await save("result.json", facts);
      return false;
    }
    if (controller.signal.aborted) throw new Error("cancelled before helper admission");
    const parent = await readNamespaces();
    const script = `import json, os\nparent = ${JSON.stringify(parent)}\nfacts = {name: os.readlink('/proc/self/ns/' + name) != identity for name, identity in parent.items()}\nfacts['pidOne'] = os.getpid() == 1\nwith open('/proc/net/dev') as source: interfaces = [line.split(':', 1)[0].strip() for line in source if ':' in line]\nfacts['loopbackOnly'] = interfaces == ['lo']\nchild = os.fork()\nif child == 0: os._exit(0)\nreaped, status = os.waitpid(child, 0)\nfacts['childReaped'] = reaped == child and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0\nprint(json.dumps(facts, sort_keys=True), flush=True)\nraise SystemExit(0 if all(facts.values()) else 1)\n`;
    await save("namespace-check-intent.json", { purpose: "existing-namespace-permission-only", taskId: "namespace-check", status: "possible-start", executables: facts.executables });
    // env -i removes inherited credentials/desktop endpoints without discovering them.
    const result = await runCommand({
      command: "/usr/bin/env",
      args: ["-i", "PATH=/usr/bin:/bin", "LANG=C", "/usr/bin/unshare", "--user", "--map-root-user", "--mount", "--net", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc", "/usr/bin/python3", "-I", "-c", script],
      timeoutMs: 10000,
    }, { root, logDirectory: directory, taskId: "namespace-check", signal: controller.signal, closeGraceMs: 2000 });
    facts.helper = result; // Existing supervisor result/log-identity format, not a capability certificate.
    const retired = result.closeObserved === true && result.cleanup?.complete === true &&
      result.cleanup.groupAlive === false && result.termination === "close-and-group-exit-observed" &&
      result.timedOut === false && result.interrupted === false && result.signal === null &&
      !result.error && !result.cleanupError && !result.cleanup.survivorDetected && !controller.signal.aborted;
    if (retired && result.exitCode === 0) {
      const stdout = path.join(output, "namespace-check.stdout.log");
      if ((await stat(stdout)).size > 4096) throw new Error("unexpected helper output size");
      const measured = JSON.parse(await readFile(stdout, "utf8"));
      const keys = [...namespaces, "pidOne", "loopbackOnly", "childReaped"];
      if (Object.keys(measured).length !== keys.length || !keys.every((key) => measured[key] === true)) throw new Error("unexpected helper facts");
      facts.namespaces = measured;
      facts.status = "supported";
    } else if (retired && Number.isSafeInteger(result.exitCode) && result.exitCode !== 0) {
      // No fallback or retry. A nonzero exit alone cannot distinguish EPERM from unsupported flags.
      facts.status = "denied-or-unsupported";
    }
    if (controller.signal.aborted) { facts.status = "unknown"; facts.cancelled = true; }
    await save("result.json", facts);
    // Cancellation can arrive during the awaited write/fsync/close. Keep this
    // same owner's evidence, but never return or persist supported after it.
    if (controller.signal.aborted && !facts.cancelled) {
      facts.status = "unknown";
      facts.cancelled = true;
      await save("result.json", facts, true);
    }
    return facts.status === "supported";
  } catch (error) {
    facts.status = "unknown";
    if (error.result) facts.helper = error.result;
    await save("result.json", facts);
    // Retain the same owner and original failure through late close; never turn it into success.
    if (error.lateClose) await save("late-close.json", await error.lateClose);
    return false;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    if (!await checkExistingOsSuitability()) process.exitCode = 1;
  } catch {
    console.error("[precheck] existing OS suitability owner/evidence unavailable; no replacement");
    process.exitCode = 1;
  }
}
