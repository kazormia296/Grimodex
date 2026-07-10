/**
 * CLI AI (Claude Code / Codex / OpenCode) の Electron main 実装。
 *
 * renderer からは既存 Tauri command 互換の5コマンドだけを受け、実行ファイル・argv・
 * process tree・NDJSON を main が管理する。prompt や model を shell 文字列へ連結しない。
 */
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import crossSpawn from "cross-spawn";

import type {
  CommandArgs,
  ShellCommandHandlers,
} from "../shared/ipcContract.js";
import { createCliLineAdapter, type CliKind } from "./cliAdapters.js";

export const MAX_CLI_LINE_BYTES = 1024 * 1024;
export const MAX_CLI_STREAM_BYTES = 64 * 1024 * 1024;
export const MAX_CLI_STREAM_LINES = 10_000;
export const MAX_CLI_EMITTED_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const DETECT_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_FORCE_KILL_AFTER_MS = 2_000;
const DEFAULT_STREAM_TIMEOUT_MS = 290_000;

const CLI_KINDS = new Set<CliKind>(["claude", "codex", "opencode"]);

const OPENCODE_PERMISSION = JSON.stringify({
  permission: {
    read: "deny",
    edit: "deny",
    glob: "deny",
    grep: "deny",
    bash: "deny",
    task: "deny",
    skill: "deny",
    lsp: "deny",
    question: "deny",
    webfetch: "deny",
    websearch: "deny",
    external_directory: "deny",
  },
});

const CLAUDE_MODELS = [
  { id: "opus", name: "Opus (latest alias)" },
  { id: "sonnet", name: "Sonnet (latest alias)" },
  { id: "haiku", name: "Haiku (latest alias)" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
  { id: "claude-3-5-haiku-20241022", name: "Claude Haiku 3.5" },
] as const;

export interface CliCommandSpec {
  executable: string;
  args: string[];
  /** process.env に重ねる追加環境変数。 */
  env?: NodeJS.ProcessEnv;
}

export interface CliProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunningCliProcess {
  pid: number | null;
  stdout: Readable;
  stderr: Readable;
  completion: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>;
  terminate(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface CliProcessRunner {
  run(
    spec: CliCommandSpec,
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<CliProcessResult>;
  start(spec: CliCommandSpec): RunningCliProcess;
  /** Electron終了時に、このrunnerが起動した全childを同期的に停止する。 */
  disposeAll?(): void;
}

interface CliDetectDependencies {
  runner: CliProcessRunner;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  isFile(candidate: string): Promise<boolean>;
  readDir?(candidate: string): Promise<Dirent[]>;
}

interface CliAiDependencies {
  runner?: CliProcessRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  isFile?: (candidate: string) => Promise<boolean>;
  realPath?: (candidate: string) => Promise<string>;
  readDir?: (candidate: string) => Promise<Dirent[]>;
  detectBinary?: (kind: CliKind) => Promise<string | null>;
  authorizeExecutable?: (kind: CliKind, executable: string) => Promise<boolean>;
  forceKillAfterMs?: number;
  streamTimeoutMs?: number;
  maxStreamBytes?: number;
  maxStreamLines?: number;
  maxEmittedBytes?: number;
}

interface ActiveRun {
  process: RunningCliProcess;
  aborted: boolean;
  timedOut: boolean;
  completed: boolean;
  forceKillTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
}

export interface CliAiManager {
  handlers: ShellCommandHandlers;
  disposeAll(): void;
}

type Broadcast = (channel: string, payload: unknown) => void;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid args \`${name}\`: expected an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  name: string,
  allowEmpty = true,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`invalid args \`${name}\`: expected a string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, name);
}

function parseCliKind(value: unknown): CliKind {
  if (typeof value !== "string" || !CLI_KINDS.has(value as CliKind)) {
    throw new Error(`invalid CLI kind: ${String(value)}`);
  }
  return value as CliKind;
}

function mergedEnv(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return extra ? { ...process.env, ...extra } : { ...process.env };
}

function terminateChildTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  signal: "SIGTERM" | "SIGKILL",
): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill(signal);
    return;
  }

  if (platform === "win32") {
    // Windows には process group signal が無いため、固定 executable + argv で
    // 子孫を含めて終了する。shell は使わない。
    const killer = crossSpawn(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      },
    );
    killer.on("error", () => {
      child.kill("SIGKILL");
    });
    return;
  }

  try {
    // stream child は detached=true なので pgid == pid。
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * app終了時用。detached childを残さないため、Unixはgroupへ同期的にKILLを送り、
 * Windowsはtaskkillの完了を待つ。通常abortの猶予付きTERMとは分ける。
 */
function forceTerminateChildTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }

  if (platform === "win32") {
    const result = crossSpawn.sync(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0) {
      child.kill("SIGKILL");
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function createNodeCliProcessRunner(
  platform: NodeJS.Platform = process.platform,
): CliProcessRunner {
  const children = new Set<ChildProcess>();
  let disposed = false;
  const track = (child: ChildProcess): void => {
    children.add(child);
    const forget = (): void => {
      children.delete(child);
    };
    child.once("close", forget);
    child.once("error", forget);
  };

  return {
    run(spec, options) {
      if (disposed) {
        return Promise.reject(new Error("CLI process runner is disposed"));
      }
      return new Promise<CliProcessResult>((resolve, reject) => {
        let child: ChildProcess;
        try {
          child = crossSpawn(spec.executable, spec.args, {
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
            detached: platform !== "win32",
            env: mergedEnv(spec.env),
          });
        } catch (cause) {
          reject(toError(cause));
          return;
        }
        track(child);

        let settled = false;
        let totalBytes = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        const finishReject = (cause: unknown): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          terminateChildTree(child, platform, "SIGKILL");
          reject(toError(cause));
        };
        const append = (target: Buffer[], chunk: Buffer | string): void => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > options.maxOutputBytes) {
            finishReject(new Error("CLI command output exceeds limit"));
            return;
          }
          target.push(buffer);
        };

        child.stdout?.on("data", (chunk: Buffer | string) => {
          append(stdout, chunk);
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          append(stderr, chunk);
        });
        child.once("error", finishReject);
        child.once("close", (exitCode, signal) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({
            exitCode,
            signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });

        timer = setTimeout(() => {
          finishReject(
            new Error(`CLI command timed out after ${options.timeoutMs}ms`),
          );
        }, options.timeoutMs);
        timer.unref();
      });
    },

    start(spec) {
      if (disposed) throw new Error("CLI process runner is disposed");
      const child = crossSpawn(spec.executable, spec.args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: platform !== "win32",
        env: mergedEnv(spec.env),
      });
      track(child);
      if (!child.stdout || !child.stderr) {
        child.kill("SIGKILL");
        throw new Error("CLI child stdio missing");
      }

      const completion = new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        let settled = false;
        child.once("error", (cause) => {
          if (settled) return;
          settled = true;
          reject(cause);
        });
        child.once("close", (exitCode, signal) => {
          if (settled) return;
          settled = true;
          resolve({ exitCode, signal });
        });
      });

      return {
        pid: child.pid ?? null,
        stdout: child.stdout,
        stderr: child.stderr,
        completion,
        terminate: (signal) => terminateChildTree(child, platform, signal),
      };
    },

    disposeAll() {
      if (disposed) return;
      disposed = true;
      for (const child of [...children]) {
        forceTerminateChildTree(child, platform);
      }
      children.clear();
    },
  };
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function isAbsoluteForPlatform(
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  return pathApi(platform).isAbsolute(candidate);
}

function allowedLeafNames(kind: CliKind, platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? [kind, `${kind}.exe`, `${kind}.cmd`, `${kind}.bat`]
    : [kind];
}

function cliKindFromExecutable(
  raw: unknown,
  platform: NodeJS.Platform,
): CliKind {
  const executable = requireString(raw, "binaryPath", false).trim();
  const leaf = pathApi(platform).basename(executable).toLowerCase();
  for (const kind of CLI_KINDS) {
    if (allowedLeafNames(kind, platform).includes(leaf)) return kind;
  }
  throw new Error(
    "CLI executable must be claude, codex, or opencode (including native Windows shims)",
  );
}

function isWindowsNetworkPath(candidate: string): boolean {
  return candidate.replaceAll("/", "\\").startsWith("\\\\");
}

interface ValidatedCliExecutable {
  /** rendererへ返す／ユーザー設定に保存する、CLI名を保ったpath。 */
  requestedPath: string;
  /** symlinkを解決した、実際にspawn・authorizationするpath。 */
  executable: string;
}

async function validateCliExecutable(
  raw: unknown,
  kind: CliKind | null,
  platform: NodeJS.Platform,
  isFile: (candidate: string) => Promise<boolean>,
  resolveRealPath: (candidate: string) => Promise<string>,
): Promise<ValidatedCliExecutable> {
  const executable = requireString(raw, "binaryPath", false).trim();
  if (executable.includes("\0")) {
    throw new Error("CLI executable contains a NUL byte");
  }

  const api = pathApi(platform);
  const leaf = api.basename(executable).toLowerCase();
  const allowed = kind
    ? allowedLeafNames(kind, platform)
    : (["claude", "codex", "opencode"] as CliKind[]).flatMap((item) =>
        allowedLeafNames(item, platform),
      );
  if (!allowed.includes(leaf)) {
    if (kind) {
      throw new Error(
        `CLI executable \`${leaf}\` does not match CLI kind \`${kind}\``,
      );
    }
    throw new Error(
      "CLI executable must be claude, codex, or opencode (including native Windows shims)",
    );
  }

  const containsSeparator =
    executable.includes("/") || executable.includes("\\");
  if (!containsSeparator) {
    return { requestedPath: executable, executable };
  }
  if (!isAbsoluteForPlatform(executable, platform)) {
    throw new Error("CLI executable path must be absolute");
  }
  if (platform === "win32" && isWindowsNetworkPath(executable)) {
    throw new Error("CLI executable cannot be loaded from a network path");
  }
  let canonical: string;
  try {
    canonical = await resolveRealPath(executable);
  } catch (cause) {
    throw new Error(`Failed to resolve CLI executable: ${executable}`, {
      cause,
    });
  }
  if (platform === "win32" && isWindowsNetworkPath(canonical)) {
    throw new Error("CLI executable cannot resolve to a network path");
  }
  if (!(await isFile(canonical))) {
    throw new Error(`CLI executable is not a regular file: ${canonical}`);
  }
  return { requestedPath: executable, executable: canonical };
}

export function buildCliInvocation(
  kind: CliKind,
  executable: string,
  options: { model?: string | null; prompt: string },
): CliCommandSpec {
  const model = options.model;
  switch (kind) {
    case "claude": {
      const args = [
        "-p",
        options.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowed-tools",
        "",
        "--permission-mode",
        "default",
      ];
      if (model) args.push("--model", model);
      return { executable, args };
    }
    case "codex": {
      const args = ["exec", "--json", "--sandbox", "read-only"];
      if (model) args.push("--model", model);
      args.push(options.prompt);
      return { executable, args };
    }
    case "opencode": {
      const args = ["--print-logs", "run", "--format", "json"];
      if (model) args.push("--model", model);
      args.push(options.prompt);
      return {
        executable,
        args,
        env: { OPENCODE_PERMISSION },
      };
    }
    default:
      throw new Error(`invalid CLI kind: ${String(kind)}`);
  }
}

async function defaultIsFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function defaultRealPath(candidate: string): Promise<string> {
  return realpath(candidate);
}

async function defaultReadDir(candidate: string): Promise<Dirent[]> {
  try {
    return await readdir(candidate, { withFileTypes: true });
  } catch {
    return [];
  }
}

function firstOutputLine(stdout: string): string | null {
  const first = stdout.split(/\r?\n/u)[0]?.trim();
  return first ? first.replace(/^"|"$/gu, "") : null;
}

async function captureFirstLineForDetect(
  deps: CliDetectDependencies,
  spec: CliCommandSpec,
): Promise<string | null> {
  try {
    const result = await deps.runner.run(spec, {
      timeoutMs: DETECT_PROBE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) return null;
    return firstOutputLine(result.stdout);
  } catch {
    // detection は fail-soft。次の候補へ進む。
  }
  return null;
}

async function captureForDetect(
  deps: CliDetectDependencies,
  spec: CliCommandSpec,
): Promise<string | null> {
  const candidate = await captureFirstLineForDetect(deps, spec);
  return candidate && (await deps.isFile(candidate)) ? candidate : null;
}

async function findInPath(
  name: string,
  deps: CliDetectDependencies,
): Promise<string | null> {
  const delimiter = deps.platform === "win32" ? ";" : ":";
  const extensions =
    deps.platform === "win32"
      ? (deps.env.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .filter(Boolean)
          .map((ext) => ext.toLowerCase())
      : [""];
  const api = pathApi(deps.platform);
  for (const dir of (deps.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = api.join(dir, `${name}${extension}`);
      if (await deps.isFile(candidate)) return candidate;
    }
  }
  return null;
}

async function findFileBfs(
  root: string,
  leaves: readonly string[],
  maxDepth: number,
  deps: CliDetectDependencies,
): Promise<string | null> {
  const readDir = deps.readDir ?? defaultReadDir;
  const api = pathApi(deps.platform);
  const wanted = new Set(
    leaves.map((leaf) =>
      deps.platform === "win32" ? leaf.toLowerCase() : leaf,
    ),
  );
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  let visited = 0;
  while (queue.length > 0 && visited < 10_000) {
    const current = queue.shift();
    if (!current) break;
    visited += 1;
    for (const entry of await readDir(current.dir)) {
      const entryName =
        deps.platform === "win32" ? entry.name.toLowerCase() : entry.name;
      const full = api.join(current.dir, entry.name);
      if (entry.isFile() && wanted.has(entryName)) return full;
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function unixKnownCandidates(kind: CliKind, home: string): string[] {
  return [
    path.posix.join(home, ".local", "bin", kind),
    path.posix.join(home, ".volta", "bin", kind),
    path.posix.join(home, ".local", "share", "pnpm", kind),
    path.posix.join(home, "Library", "pnpm", kind),
    path.posix.join(home, ".nix-profile", "bin", kind),
    path.posix.join(home, ".asdf", "shims", kind),
    path.posix.join(home, ".local", "share", "mise", "shims", kind),
    path.posix.join(home, ".local", "share", "flatpak", "exports", "bin", kind),
    path.posix.join("/snap/bin", kind),
    path.posix.join("/var/lib/flatpak/exports/bin", kind),
    path.posix.join("/opt/homebrew/bin", kind),
    path.posix.join("/usr/local/bin", kind),
    path.posix.join("/usr/bin", kind),
    path.posix.join("/bin", kind),
  ];
}

async function detectUnixBinary(
  kind: CliKind,
  deps: CliDetectDependencies,
): Promise<string | null> {
  const fixedLookup = `command -v ${kind}`;
  const probes: CliCommandSpec[] = [
    { executable: "bash", args: ["-lc", fixedLookup] },
    { executable: "bash", args: ["-ilc", fixedLookup] },
    {
      executable: "bash",
      args: [
        "-lc",
        [
          'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
          '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null || true',
          'export PATH="$HOME/.local/share/fnm:$HOME/.volta/bin:$HOME/.local/share/pnpm:$PATH"',
          'command -v fnm >/dev/null 2>&1 && eval "$(fnm env --shell bash 2>/dev/null)" || true',
          '[ -f "$HOME/.asdf/asdf.sh" ] && . "$HOME/.asdf/asdf.sh" 2>/dev/null || true',
          fixedLookup,
        ].join("\n"),
      ],
    },
    {
      executable: "zsh",
      args: [
        "-ilc",
        `test -r "$HOME/.zprofile" && . "$HOME/.zprofile" 2>/dev/null || true\n${fixedLookup}`,
      ],
    },
  ];
  for (const probe of probes) {
    const found = await captureForDetect(deps, probe);
    if (found) return found;
  }

  const inPath = await findInPath(kind, deps);
  if (inPath) return inPath;
  for (const candidate of unixKnownCandidates(kind, deps.homeDir)) {
    if (await deps.isFile(candidate)) return candidate;
  }

  const versionRoots = [
    path.posix.join(deps.homeDir, ".nvm", "versions", "node"),
    path.posix.join(deps.homeDir, ".local", "share", "fnm", "node-versions"),
    path.posix.join(deps.homeDir, ".asdf", "installs", "nodejs"),
    path.posix.join(
      deps.homeDir,
      ".local",
      "share",
      "mise",
      "installs",
      "node",
    ),
  ];
  for (const root of versionRoots) {
    const found = await findFileBfs(root, [kind], 5, deps);
    if (found) return found;
  }

  if (deps.platform === "darwin") {
    const appNames: Record<CliKind, string[]> = {
      claude: ["Claude", "Claude Code"],
      codex: ["Codex", "OpenAI Codex"],
      opencode: ["OpenCode", "opencode"],
    };
    for (const appsRoot of [
      "/Applications",
      path.posix.join(deps.homeDir, "Applications"),
    ]) {
      for (const appName of appNames[kind]) {
        const candidate = path.posix.join(
          appsRoot,
          `${appName}.app`,
          "Contents",
          "MacOS",
          kind,
        );
        if (await deps.isFile(candidate)) return candidate;
      }
    }
    const vendors: Record<CliKind, string[]> = {
      claude: ["Anthropic", "anthropic", "Claude", "claude"],
      codex: ["OpenAI", "openai", "Codex", "codex"],
      opencode: ["OpenCode", "opencode", "sst.opencode", "ai.opencode"],
    };
    for (const vendor of vendors[kind]) {
      const root = path.posix.join(
        deps.homeDir,
        "Library",
        "Application Support",
        vendor,
      );
      const found = await findFileBfs(root, [kind], 10, deps);
      if (found) return found;
    }
  }

  const npmPrefix = await captureFirstLineForDetect(deps, {
    executable: "npm",
    args: ["config", "get", "prefix"],
  });
  if (npmPrefix) {
    for (const candidate of [
      path.posix.join(npmPrefix, "bin", kind),
      path.posix.join(npmPrefix, kind),
    ]) {
      if (await deps.isFile(candidate)) return candidate;
    }
  }
  return null;
}

async function detectWindowsBinary(
  kind: CliKind,
  deps: CliDetectDependencies,
): Promise<string | null> {
  const fromWhere = await captureForDetect(deps, {
    executable: "where.exe",
    args: [kind],
  });
  if (fromWhere) return fromWhere;

  const fromPath = await findInPath(kind, deps);
  if (fromPath) return fromPath;

  const local = deps.env.LOCALAPPDATA ?? "";
  const roaming = deps.env.APPDATA ?? "";
  const api = path.win32;
  const leaves = [`${kind}.exe`, `${kind}.cmd`, kind];
  const direct = [
    api.join(deps.homeDir, ".local", "bin", `${kind}.exe`),
    api.join(deps.homeDir, ".local", "bin", kind),
    api.join(deps.homeDir, "scoop", "shims", `${kind}.exe`),
    local ? api.join(local, "Microsoft", "WindowsApps", `${kind}.exe`) : "",
    roaming ? api.join(roaming, "npm", `${kind}.cmd`) : "",
  ].filter(Boolean);
  for (const candidate of direct) {
    if (await deps.isFile(candidate)) return candidate;
  }

  if (local) {
    const vendorRoots: Record<CliKind, string[]> = {
      claude: ["Anthropic", "anthropic", "Claude", "claude"],
      codex: ["OpenAI", "openai", "Codex", "codex"],
      opencode: ["OpenCode", "opencode", "sst", "anomalyco"],
    };
    for (const rootName of vendorRoots[kind]) {
      const found = await findFileBfs(
        api.join(local, rootName),
        leaves,
        12,
        deps,
      );
      if (found) return found;
    }
    const programs = await findFileBfs(
      api.join(local, "Programs"),
      leaves,
      3,
      deps,
    );
    if (programs) return programs;
  }

  const escapedKind = kind.replaceAll("'", "''");
  const fromPowershell = await captureForDetect(deps, {
    executable: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $s=(Get-Command '${escapedKind}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source); if(-not $s){exit 1}; [Console]::Out.Write($s)`,
    ],
  });
  if (fromPowershell) return fromPowershell;

  const npmPrefix = await captureFirstLineForDetect(deps, {
    executable: "npm",
    args: ["config", "get", "prefix"],
  });
  if (npmPrefix) {
    for (const leaf of leaves) {
      for (const candidate of [
        api.join(npmPrefix, leaf),
        api.join(npmPrefix, "bin", leaf),
      ]) {
        if (await deps.isFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

export async function detectCliBinaryMain(
  kindValue: CliKind,
  partialDeps: CliDetectDependencies,
): Promise<string | null> {
  const kind = parseCliKind(kindValue);
  return partialDeps.platform === "win32"
    ? detectWindowsBinary(kind, partialDeps)
    : detectUnixBinary(kind, partialDeps);
}

function parseCodexModels(raw: string): Array<{ id: string; name: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim()) as unknown;
  } catch (cause) {
    throw new Error("Failed to parse Codex models JSON", { cause });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { models?: unknown }).models)
  ) {
    throw new Error("Failed to parse Codex models JSON: missing models array");
  }
  return (parsed as { models: unknown[] }).models.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const model = entry as Record<string, unknown>;
    if (typeof model.slug !== "string") return [];
    if (typeof model.visibility === "string" && model.visibility !== "list") {
      return [];
    }
    return [
      {
        id: model.slug,
        name:
          typeof model.display_name === "string"
            ? model.display_name
            : model.slug,
      },
    ];
  });
}

function parseOpenCodeModels(raw: string): Array<{ id: string; name: string }> {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.includes("/"))
    .map((id) => ({ id, name: id.split("/").at(-1) ?? id }));
}

async function collectStderrTail(
  stream: Readable,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let tail = Buffer.alloc(0);
    stream.on("data", (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      tail = Buffer.concat([tail, next]);
      if (tail.length > maxBytes) tail = tail.subarray(tail.length - maxBytes);
    });
    stream.once("end", () => resolve(tail.toString("utf8")));
    stream.once("error", reject);
  });
}

async function consumeLines(
  stream: Readable,
  onLine: (line: string) => void,
  maxLineBytes: number,
  maxTotalBytes: number,
  maxLines: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let totalBytes = 0;
    let lineCount = 0;
    let settled = false;

    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const fail = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(toError(cause));
    };
    const deliver = (line: string): void => {
      lineCount += 1;
      if (lineCount > maxLines) {
        throw new Error("CLI stdout exceeds line limit");
      }
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (Buffer.byteLength(normalized, "utf8") > maxLineBytes) {
        throw new Error("CLI stdout line exceeds limit");
      }
      if (normalized.length > 0) onLine(normalized);
    };
    const drain = (final: boolean): void => {
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        deliver(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending, "utf8") > maxLineBytes) {
        throw new Error("CLI stdout line exceeds limit");
      }
      if (final && pending.length > 0) {
        deliver(pending);
        pending = "";
      }
    };
    function onData(chunk: Buffer | string): void {
      try {
        const chunkBytes = Buffer.isBuffer(chunk)
          ? chunk.length
          : Buffer.byteLength(chunk, "utf8");
        totalBytes += chunkBytes;
        if (totalBytes > maxTotalBytes) {
          throw new Error("CLI stdout exceeds total byte limit");
        }
        pending += Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk;
        drain(false);
      } catch (cause) {
        fail(cause);
      }
    }
    function onEnd(): void {
      if (settled) return;
      try {
        pending += decoder.end();
        drain(true);
        settled = true;
        cleanup();
        resolve();
      } catch (cause) {
        fail(cause);
      }
    }
    function onError(cause: unknown): void {
      fail(cause);
    }

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function runErrorMessage(
  executable: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const leaf = path.basename(executable);
  const status =
    exitCode !== null
      ? `exited with code ${exitCode}`
      : `terminated by signal ${signal ?? "unknown"}`;
  const detail = stderr.trim();
  return `CLI \`${leaf}\` ${status}${detail ? `: ${detail}` : ""}`;
}

async function runCapturedChecked(
  runner: CliProcessRunner,
  spec: CliCommandSpec,
): Promise<CliProcessResult> {
  let result: CliProcessResult;
  try {
    result = await runner.run(spec, {
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_CAPTURE_OUTPUT_BYTES,
    });
  } catch (cause) {
    throw new Error(`Failed to spawn CLI command: ${toError(cause).message}`, {
      cause,
    });
  }
  if (result.exitCode !== 0) {
    throw new Error(
      runErrorMessage(
        spec.executable,
        result.exitCode,
        result.signal,
        result.stderr.slice(-MAX_STDERR_TAIL_BYTES),
      ),
    );
  }
  return result;
}

export function createCliAiManager(
  broadcast: Broadcast,
  supplied: CliAiDependencies = {},
): CliAiManager {
  const platform = supplied.platform ?? process.platform;
  const env = supplied.env ?? process.env;
  const homeDir = supplied.homeDir ?? os.homedir();
  const isFile = supplied.isFile ?? defaultIsFile;
  const resolveRealPath = supplied.realPath ?? defaultRealPath;
  const readDir = supplied.readDir ?? defaultReadDir;
  const runner = supplied.runner ?? createNodeCliProcessRunner(platform);
  const detectBinary =
    supplied.detectBinary ??
    ((kind: CliKind) =>
      detectCliBinaryMain(kind, {
        runner,
        platform,
        env,
        homeDir,
        isFile,
        readDir,
      }));
  const forceKillAfterMs =
    supplied.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS;
  const streamTimeoutMs = supplied.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  const maxStreamBytes = supplied.maxStreamBytes ?? MAX_CLI_STREAM_BYTES;
  const maxStreamLines = supplied.maxStreamLines ?? MAX_CLI_STREAM_LINES;
  const maxEmittedBytes = supplied.maxEmittedBytes ?? MAX_CLI_EMITTED_BYTES;
  const authorizeExecutable =
    supplied.authorizeExecutable ?? (async () => false);
  for (const [name, value] of [
    ["forceKillAfterMs", forceKillAfterMs],
    ["streamTimeoutMs", streamTimeoutMs],
    ["maxStreamBytes", maxStreamBytes],
    ["maxStreamLines", maxStreamLines],
    ["maxEmittedBytes", maxEmittedBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }

  let disposed = false;
  const ensureNotDisposed = (): void => {
    if (disposed) throw new Error("CLI manager is disposed");
  };

  // rendererは任意pathを信頼済みにできない。mainが検出したpathか、Electronの
  // native確認を通ったpathだけを、このmanagerのlifetime中allowlistする。
  const authorizedExecutables = new Map<CliKind, Set<string>>();
  const detectedExecutables = new Map<CliKind, ValidatedCliExecutable>();
  const detectionGenerations = new Map<CliKind, number>();
  const trustAuthorizedExecutable = (
    kind: CliKind,
    executable: string,
  ): void => {
    const trusted = authorizedExecutables.get(kind) ?? new Set<string>();
    // Windowsでもcase-sensitive directoryを有効化できるためlowercaseしない。
    trusted.add(executable);
    authorizedExecutables.set(kind, trusted);
  };
  const isTrustedExecutable = (kind: CliKind, executable: string): boolean =>
    detectedExecutables.get(kind)?.executable === executable ||
    (authorizedExecutables.get(kind)?.has(executable) ?? false);
  const detectAndTrust = async (
    kind: CliKind,
    refresh = false,
  ): Promise<ValidatedCliExecutable | null> => {
    ensureNotDisposed();
    if (!refresh) {
      const cached = detectedExecutables.get(kind);
      if (cached) return cached;
    }
    const generation = (detectionGenerations.get(kind) ?? 0) + 1;
    detectionGenerations.set(kind, generation);
    if (refresh) detectedExecutables.delete(kind);
    const latestResult = (): ValidatedCliExecutable | null =>
      detectedExecutables.get(kind) ?? null;
    const isLatest = (): boolean =>
      detectionGenerations.get(kind) === generation;

    const found = await detectBinary(kind);
    ensureNotDisposed();
    if (!isLatest()) return latestResult();
    if (!found) {
      detectedExecutables.delete(kind);
      return null;
    }
    const validated = await validateCliExecutable(
      found,
      kind,
      platform,
      isFile,
      resolveRealPath,
    );
    ensureNotDisposed();
    if (!isLatest()) return latestResult();
    detectedExecutables.set(kind, validated);
    return validated;
  };
  const resolveExecutable = async (
    kind: CliKind,
    raw: unknown,
  ): Promise<string> => {
    ensureNotDisposed();
    const candidate = requireString(raw, "binaryPath", false).trim();
    const containsSeparator =
      candidate.includes("/") || candidate.includes("\\");
    if (!containsSeparator) {
      const candidateKind = cliKindFromExecutable(candidate, platform);
      if (candidateKind !== kind) {
        throw new Error(`CLI executable does not match CLI kind \`${kind}\``);
      }
      const detected = await detectAndTrust(kind);
      ensureNotDisposed();
      if (!detected) throw new Error(`CLI executable not found: ${kind}`);
      return detected.executable;
    }

    const validated = await validateCliExecutable(
      candidate,
      kind,
      platform,
      isFile,
      resolveRealPath,
    );
    ensureNotDisposed();
    if (isTrustedExecutable(kind, validated.executable)) {
      return validated.executable;
    }
    if (!(await authorizeExecutable(kind, validated.executable))) {
      throw new Error(
        `CLI executable was not authorized: ${validated.executable}`,
      );
    }
    ensureNotDisposed();
    trustAuthorizedExecutable(kind, validated.executable);
    return validated.executable;
  };

  let active: ActiveRun | null = null;
  let busy = false;
  let abortBeforeSpawn = false;

  const emitError = (error: Error): void => {
    broadcast("cli:stream-error", { message: error.message });
  };
  const requestStop = (run: ActiveRun, aborted: boolean): void => {
    if (aborted) run.aborted = true;
    if (run.completed) return;
    run.process.terminate("SIGTERM");
    if (run.forceKillTimer === null) {
      run.forceKillTimer = setTimeout(() => {
        run.process.terminate("SIGKILL");
      }, forceKillAfterMs);
      run.forceKillTimer.unref();
    }
  };
  const clearStopTimer = (run: ActiveRun): void => {
    if (run.forceKillTimer !== null) {
      clearTimeout(run.forceKillTimer);
      run.forceKillTimer = null;
    }
  };
  const clearDeadlineTimer = (run: ActiveRun): void => {
    if (run.deadlineTimer !== null) {
      clearTimeout(run.deadlineTimer);
      run.deadlineTimer = null;
    }
  };
  const clearRunTimers = (run: ActiveRun): void => {
    clearStopTimer(run);
    clearDeadlineTimer(run);
  };
  const waitForStopped = async (run: ActiveRun): Promise<void> => {
    if (run.completed) return;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      run.process.completion.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        fallback = setTimeout(resolve, forceKillAfterMs + 250);
        fallback.unref();
      }),
    ]);
    if (fallback) clearTimeout(fallback);
  };

  const sendCliStream = async (args: CommandArgs): Promise<null> => {
    if (disposed) throw new Error("CLI manager is disposed");
    if (busy) throw new Error("CLI stream is already running");
    busy = true;
    abortBeforeSpawn = false;
    let run: ActiveRun | null = null;
    let deadlineExpired = false;
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      if (!run || run.completed) return;
      run.timedOut = true;
      requestStop(run, false);
    }, streamTimeoutMs);
    deadlineTimer.unref();

    try {
      const payload = requireRecord(args.payload, "payload");
      const kind = parseCliKind(payload.cli);
      const prompt = requireString(payload.prompt, "payload.prompt");
      const model = optionalString(payload.model, "payload.model");
      const rawBinary =
        optionalString(payload.binaryPath, "payload.binaryPath") ?? kind;
      const executable = await resolveExecutable(kind, rawBinary);
      if (disposed) throw new Error("CLI manager is disposed");
      if (deadlineExpired) {
        throw new Error(`CLI stream timed out after ${streamTimeoutMs}ms`);
      }
      if (abortBeforeSpawn) {
        broadcast("cli:stream-done", {
          stop_reason: "stopped",
          input_tokens: null,
          output_tokens: null,
        });
        return null;
      }
      const spec = buildCliInvocation(kind, executable, { model, prompt });

      let running: RunningCliProcess;
      try {
        running = runner.start(spec);
      } catch (cause) {
        const error = new Error(
          `Failed to spawn CLI: ${toError(cause).message}`,
          { cause },
        );
        emitError(error);
        throw error;
      }
      run = {
        process: running,
        aborted: false,
        timedOut: false,
        completed: false,
        forceKillTimer: null,
        deadlineTimer,
      };
      active = run;
      void running.completion.then(
        () => {
          if (run) {
            run.completed = true;
            clearRunTimers(run);
          }
        },
        () => {
          if (run) {
            run.completed = true;
            clearRunTimers(run);
          }
        },
      );

      const adapter = createCliLineAdapter(kind);
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let stopReason = "end_turn";
      let emittedBytes = 0;

      const stdoutDone = consumeLines(
        running.stdout,
        (line) => {
          if (run?.aborted || run?.timedOut) return;
          for (const event of adapter.parseLine(line)) {
            if (event.type === "done") {
              if (event.inputTokens !== null) inputTokens = event.inputTokens;
              if (event.outputTokens !== null)
                outputTokens = event.outputTokens;
              if (event.stopReason) stopReason = event.stopReason;
              continue;
            }
            emittedBytes += Buffer.byteLength(event.delta, "utf8");
            if (emittedBytes > maxEmittedBytes) {
              throw new Error("CLI stream exceeds emitted byte limit");
            }
            const blockType = event.type === "thinking" ? "thinking" : "text";
            broadcast("cli:stream-chunk", {
              delta: event.delta,
              block_type: blockType,
            });
          }
        },
        MAX_CLI_LINE_BYTES,
        maxStreamBytes,
        maxStreamLines,
      );
      const stderrDone = collectStderrTail(
        running.stderr,
        MAX_STDERR_TAIL_BYTES,
      );

      try {
        const [result, , stderr] = await Promise.all([
          running.completion,
          stdoutDone,
          stderrDone,
        ]);
        clearRunTimers(run);
        if (run.timedOut) {
          throw new Error(`CLI stream timed out after ${streamTimeoutMs}ms`);
        }
        if (run.aborted) {
          broadcast("cli:stream-done", {
            stop_reason: "stopped",
            input_tokens: null,
            output_tokens: null,
          });
          return null;
        }
        if (result.exitCode !== 0 && stopReason !== "error") {
          throw new Error(
            runErrorMessage(
              spec.executable,
              result.exitCode,
              result.signal,
              stderr,
            ),
          );
        }
        broadcast("cli:stream-done", {
          stop_reason: stopReason,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        });
        return null;
      } catch (cause) {
        if (run.aborted && !run.timedOut) {
          broadcast("cli:stream-done", {
            stop_reason: "stopped",
            input_tokens: null,
            output_tokens: null,
          });
          return null;
        }
        requestStop(run, false);
        await waitForStopped(run);
        const error = toError(cause);
        emitError(error);
        throw error;
      }
    } finally {
      if (run) {
        clearRunTimers(run);
      } else {
        clearTimeout(deadlineTimer);
      }
      if (active === run) active = null;
      abortBeforeSpawn = false;
      busy = false;
    }
  };

  const handlers: ShellCommandHandlers = {
    detect_cli_binary: async (args) => {
      ensureNotDisposed();
      const kind = parseCliKind(args.cli);
      const detected = await detectAndTrust(kind, true);
      return detected?.requestedPath ?? null;
    },

    test_cli_connection: async (args) => {
      ensureNotDisposed();
      const kind = cliKindFromExecutable(args.binaryPath, platform);
      const executable = await resolveExecutable(kind, args.binaryPath);
      const result = await runCapturedChecked(runner, {
        executable,
        args: ["--version"],
      });
      return result.stdout.trim();
    },

    list_cli_models: async (args) => {
      ensureNotDisposed();
      const kind = parseCliKind(args.cli);
      if (kind === "claude") {
        return CLAUDE_MODELS.map((model) => ({ ...model }));
      }
      const rawBinary = optionalString(args.binaryPath, "binaryPath") ?? kind;
      const executable = await resolveExecutable(kind, rawBinary);
      const spec: CliCommandSpec = {
        executable,
        args: kind === "codex" ? ["debug", "models", "--bundled"] : ["models"],
      };
      const result = await runCapturedChecked(runner, spec);
      return kind === "codex"
        ? parseCodexModels(result.stdout)
        : parseOpenCodeModels(result.stdout);
    },

    send_cli_chat_stream: sendCliStream,

    abort_cli_chat_stream: async () => {
      ensureNotDisposed();
      if (active) {
        requestStop(active, true);
      } else if (busy) {
        abortBeforeSpawn = true;
      }
      return null;
    },
  };

  return {
    handlers,
    disposeAll() {
      disposed = true;
      abortBeforeSpawn = true;
      if (active && !active.completed) {
        active.aborted = true;
        active.process.terminate("SIGTERM");
        active.process.terminate("SIGKILL");
        clearRunTimers(active);
      }
      runner.disposeAll?.();
    },
  };
}
