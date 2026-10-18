// NIR-1 DA-1 (K3/2 Positive (7)): 通常の経路（FE の external mount の処理、通常の
// 保存先への書出し、sample の世代の作成と open_workspace）が、SF-1 の guard と
// E-3 の `.md` 限定の後も、実 router + 実 gate + 実 Native + 実 ExternalMountManager を
// 通して unrestricted と restricted の両方で動くことを固定する。あわせて SF-1 の拒否
// （profile data directory を root／保存先にする）を同じ経路で固定する。
//
// 実 Native の addon が要るので `vitest.electron-native.config.ts` だけが拾う。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userData: "",
  saveDialogResult: { canceled: true } as {
    canceled: boolean;
    filePath?: string;
  },
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
    getPath: (name: string) =>
      name === "userData" ? mocks.userData : os.tmpdir(),
    getGPUFeatureStatus: () => ({}),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: async () => mocks.saveDialogResult,
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
    on: vi.fn(),
  },
}));
vi.mock("./windows.js", () => ({
  focusPanelWindow: () => false,
  hasPanelWindow: () => false,
  openPanelWindow: () => undefined,
}));

const ROOT = path.resolve(__dirname, "..", "..");
const ADDON = path.join(
  ROOT,
  "electron",
  "native",
  "grimodex-node",
  "grimodex-node.node",
);
const require = createRequire(import.meta.url);
type NativeBackendInstance = NapiBackendLike & Record<string, any>;
const { Backend: NativeBackend } = require(ADDON) as {
  Backend: new (appData: string) => NativeBackendInstance;
};
/** Every Backend a test makes, so afterAll can prove Closed before deleting. */
const backends: NativeBackendInstance[] = [];
function newBackend(appData: string): NativeBackendInstance {
  const backend = new NativeBackend(appData);
  backends.push(backend);
  return backend;
}

/**
 * `open_workspace` spawns the detached workspace maintenance worker (auto
 * backup: `backups/*.db.gz.sqlite.tmp` -> `*.db.gz`). Deleting the root while
 * it still writes fails with ENOTEMPTY (seen on hosted CI), so join it through
 * the Native lifecycle shutdown, the same as the native node tests.
 */
async function closeBackends(): Promise<void> {
  for (const backend of backends) {
    const wire = await backend.shutdownWorkspaceLifecycle!();
    expect(JSON.parse(wire).status).toBe("closed");
  }
}

const GUARD_CODE = "PROFILE_DATA_DIR_REJECTED";
const EXTENSION_CODE = "EXTERNAL_MOUNT_RESTRICTED_EXTENSION";
const roots: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const dispose of disposers) await dispose();
  await closeBackends();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Rig {
  gate: Awaited<
    ReturnType<(typeof import("./profileEgress.js"))["createProfileEgressGate"]>
  >;
  route: (cmd: string, args?: Record<string, unknown>) => Promise<Envelope>;
  readonly restricted: boolean;
  appData: string;
}

/** A fresh module graph and router on `appData`, as a Main process would start. */
async function startMain(appData: string): Promise<Rig> {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.userData = appData;

  const backend = newBackend(appData);
  const { createProfileEgressGate } = await import("./profileEgress.js");
  const { registerEventBus } = await import("./events.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { createExternalMountManager } = await import("./externalMount.js");
  const { getDefaultProfileDataGuard } =
    await import("./profileDataGuardDefault.js");
  const { IPC } = await import("../shared/ipcContract.js");

  const gate = await createProfileEgressGate(backend);
  registerEventBus(backend, undefined, gate);
  // The same wiring as index.ts: the real manager, the real default guard,
  // and the gate's restricted/unavailable view for E-3.
  const mount = createExternalMountManager(() => undefined, {
    profileDataGuard: getDefaultProfileDataGuard(),
    isProfileRestricted: () => gate.restricted || gate.unavailable,
  });
  disposers.push(() => mount.disposeAll());
  registerIpcRouter(
    backend,
    mount.handlers as never,
    undefined,
    undefined,
    {
      active: false,
    } as never,
    gate,
  );

  const routerHandler = mocks.handlers.get(IPC.invoke) as (
    event: unknown,
    cmd: unknown,
    args: unknown,
  ) => Promise<Envelope>;
  const event = {
    sender: { id: 7, isDestroyed: () => false, once: () => undefined },
  };
  return {
    appData,
    gate,
    get restricted() {
      return gate.restricted;
    },
    route: (cmd, args) => routerHandler(event, cmd, args ?? {}),
  };
}

function newProfile(label: string): { appData: string; external: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), `grimodex-own-${label}-`));
  roots.push(root);
  // realpath: the guard compares canonical paths (/tmp may be a symlink).
  const real = realpathSync(root);
  const appData = path.join(real, "app-data");
  const external = path.join(real, "novel-folder");
  mkdirSync(appData, { recursive: true });
  mkdirSync(external, { recursive: true });
  // A stand-in for the state file: any file inside the profile data directory.
  writeFileSync(path.join(appData, "sentinel.json"), '{"restricted":true}');
  writeFileSync(path.join(external, "note.md"), "# 第一章\n\n本文\n");
  writeFileSync(path.join(external, "memo.txt"), "plain text");
  return { appData, external };
}

function ok<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

function failureOf(envelope: Envelope): string {
  expect(envelope.ok).toBe(false);
  return envelope.ok ? "" : envelope.error;
}

interface Scan {
  files: Array<{ relPath: string; content: string; mtime: string }>;
}

/**
 * The FE's mount handling (mountManager / writeBack) as the commands it sends:
 * register, read, mtime-guarded write-back, conflict detection by mtime, and a
 * re-registration on the next start.
 */
async function exerciseMount(
  rig: Rig,
  external: string,
  options: { restricted: boolean },
): Promise<void> {
  const note = path.join(external, "note.md");

  const first = ok<Scan>(
    await rig.route("external_mount_register", {
      rootId: "root-1",
      path: external,
      label: "novel",
    }),
  );
  expect(first.files.map((file) => file.relPath)).toEqual(["note.md"]);
  expect(first.files[0].content).toBe("# 第一章\n\n本文\n");

  expect(
    ok<string>(
      await rig.route("external_mount_read_file", {
        rootId: "root-1",
        relPath: "note.md",
      }),
    ),
  ).toBe("# 第一章\n\n本文\n");

  // write-back: mtime before, write, mtime after, and the bytes on disk.
  const before = ok<string>(
    await rig.route("external_mount_file_mtime", {
      rootId: "root-1",
      relPath: "note.md",
    }),
  );
  ok(
    await rig.route("external_mount_write_file", {
      rootId: "root-1",
      relPath: "note.md",
      content: "# 第一章\n\n編集後\n",
    }),
  );
  expect(readFileSync(note, "utf8")).toBe("# 第一章\n\n編集後\n");
  const after = ok<string>(
    await rig.route("external_mount_file_mtime", {
      rootId: "root-1",
      relPath: "note.md",
    }),
  );
  expect(typeof after).toBe("string");
  expect(after >= before).toBe(true);

  // conflict: an outside edit moves the mtime; the FE re-reads the file and
  // then writes its resolution back.
  writeFileSync(note, "# 第一章\n\n外部の編集\n");
  const future = new Date(Date.now() + 60_000);
  utimesSync(note, future, future);
  const conflicted = ok<string>(
    await rig.route("external_mount_file_mtime", {
      rootId: "root-1",
      relPath: "note.md",
    }),
  );
  expect(conflicted).not.toBe(after);
  expect(
    ok<string>(
      await rig.route("external_mount_read_file", {
        rootId: "root-1",
        relPath: "note.md",
      }),
    ),
  ).toBe("# 第一章\n\n外部の編集\n");
  ok(
    await rig.route("external_mount_write_file", {
      rootId: "root-1",
      relPath: "note.md",
      content: "# 第一章\n\n解決後\n",
    }),
  );
  expect(readFileSync(note, "utf8")).toBe("# 第一章\n\n解決後\n");

  // a new file made outside is found by scan.
  writeFileSync(path.join(external, "ch2.md"), "# 第二章\n");
  const scanned = ok<Scan>(
    await rig.route("external_mount_scan", { rootId: "root-1" }),
  );
  expect(scanned.files.map((file) => file.relPath).sort()).toEqual([
    "ch2.md",
    "note.md",
  ]);
  expect(
    scanned.files.find((file) => file.relPath === "note.md")?.content,
  ).toBe("# 第一章\n\n解決後\n");

  // E-3: only the restricted profile is limited to `.md`.
  const txt = await rig.route("external_mount_read_file", {
    rootId: "root-1",
    relPath: "memo.txt",
  });
  if (options.restricted) {
    expect(failureOf(txt)).toContain(EXTENSION_CODE);
    const write = await rig.route("external_mount_write_file", {
      rootId: "root-1",
      relPath: "memo.txt",
      content: "overwritten",
    });
    expect(failureOf(write)).toContain(EXTENSION_CODE);
    expect(readFileSync(path.join(external, "memo.txt"), "utf8")).toBe(
      "plain text",
    );
  } else {
    expect(ok<string>(txt)).toBe("plain text");
  }

  ok(await rig.route("external_mount_unregister", { rootId: "root-1" }));
  // Leave the folder as it was found so a later start can do the same.
  rmSync(path.join(external, "ch2.md"));
  writeFileSync(note, "# 第一章\n\n本文\n");
}

/** SF-1 through the real router: the profile data directory is not a root. */
async function assertProfileDataIsNotReachable(rig: Rig): Promise<void> {
  const state = path.join(rig.appData, "sentinel.json");
  const stateBefore = readFileSync(state, "utf8");
  for (const root of [rig.appData, path.dirname(rig.appData)]) {
    const rejected = await rig.route("external_mount_register", {
      rootId: "forbidden",
      path: root,
      label: "profile",
    });
    expect(failureOf(rejected)).toContain(GUARD_CODE);
  }
  expect(readFileSync(state, "utf8")).toBe(stateBefore);
}

/** The normal save destination works; a destination inside the profile does not. */
async function exerciseExport(rig: Rig, external: string): Promise<void> {
  const target = path.join(external, "export.md");
  mocks.saveDialogResult = { canceled: false, filePath: target };
  expect(
    ok<string>(
      await rig.route("export_save_text", {
        contents: "# export\n",
        suggestedName: "export.md",
        filterName: "Markdown",
        extensions: ["md"],
      }),
    ),
  ).toBe(target);
  expect(readFileSync(target, "utf8")).toBe("# export\n");

  const inside = path.join(rig.appData, "sentinel.json");
  const stateBefore = readFileSync(inside, "utf8");
  mocks.saveDialogResult = { canceled: false, filePath: inside };
  const refused = await rig.route("export_save_text", {
    contents: "{}",
    suggestedName: "x.md",
    filterName: "Markdown",
    extensions: ["md"],
  });
  expect(failureOf(refused)).toContain(GUARD_CODE);
  expect(readFileSync(inside, "utf8")).toBe(stateBefore);
  mocks.saveDialogResult = { canceled: true };
  rmSync(target);
}

/** seedAndOpenSample's two commands: a new generation under userData, then open. */
async function exerciseSample(rig: Rig): Promise<void> {
  const seeded = ok<{ path: string; projectId: string }>(
    await rig.route("seed_sample_workspace", {
      language: "ja",
      aiPolicy: '{"preset":"full"}',
    }),
  );
  expect(path.basename(seeded.path)).toMatch(/^sample-workspace-/);
  expect(realpathSync(path.dirname(seeded.path))).toBe(rig.appData);
  expect(existsSync(path.join(seeded.path, "grimodex.db"))).toBe(true);
  expect(seeded.projectId.length).toBeGreaterThan(0);
  ok(await rig.route("open_workspace", { path: seeded.path }));
}

describe("own-data paths keep working under the SF-1 guard and E-3 (real router + gate + Native + mount manager)", () => {
  it("unrestricted profile", async () => {
    const { appData, external } = newProfile("open");
    const rig = await startMain(appData);
    expect(rig.restricted).toBe(false);
    await assertProfileDataIsNotReachable(rig);
    await exerciseMount(rig, external, { restricted: false });
    await exerciseExport(rig, external);
    await exerciseSample(rig);
  });

  it("restricted profile, restarted (re-registration on every start)", async () => {
    const { appData, external } = newProfile("restricted");
    // Process 1 activates the first restricted publication and exits.
    const first = newBackend(appData);
    await first.initializeProfileEgress!();
    const activated = JSON.parse(await first.activateProfileEgress!()) as {
      restricted: boolean;
    };
    expect(activated.restricted).toBe(true);

    const rig = await startMain(appData);
    expect(rig.restricted).toBe(true);
    expect(existsSync(path.join(appData, "profile-egress.json"))).toBe(true);
    await assertProfileDataIsNotReachable(rig);
    await exerciseMount(rig, external, { restricted: true });
    // A second start registers the same folder again and gets the same result.
    const restarted = await startMain(appData);
    expect(restarted.restricted).toBe(true);
    await exerciseMount(restarted, external, { restricted: true });
    await assertProfileDataIsNotReachable(restarted);
    await exerciseExport(restarted, external);
    await exerciseSample(restarted);
  });

  it("an activation in the same process keeps the mount and the sample working", async () => {
    const { appData, external } = newProfile("activated");
    const rig = await startMain(appData);
    expect(rig.restricted).toBe(false);
    await exerciseMount(rig, external, { restricted: false });
    // The one-way transition, through the real gate and the real Native; the
    // manager reads the gate live, so the same objects now apply E-3.
    await rig.gate.activateFirstRestrictedPublication!();
    expect(rig.restricted).toBe(true);
    await assertProfileDataIsNotReachable(rig);
    await exerciseMount(rig, external, { restricted: true });
    await exerciseExport(rig, external);
    await exerciseSample(rig);
  });
});
