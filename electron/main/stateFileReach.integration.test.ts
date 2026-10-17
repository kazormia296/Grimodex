/**
 * 状態ファイルへの到達の遮断（K3/2 Negative (25)、SF-1。DA-1）。
 *
 * K3/2「現状の 24」の攻撃を、そのまま入力にする回帰試験:
 * - 外部 folder の mount: `app.getPath("userData")` に見立てた一時 directory を root に
 *   登録し、中の `profile-egress.json` を `restricted:false` の正しい形で全置換する。
 *   `.md` でない `license.json` を読む。
 * - OS の保存 dialog: `export_save_text`／`export_save_bytes` に `suggestedName` として
 *   状態ファイルの path を渡し、dialog が既定のまま「保存」された結果を返す。
 *   dialog の中で利用者が profile data directory を選んだ結果を返す。
 *
 * この file は DA-1 の変更の前の commit で、攻撃が成立して失敗する回帰試験として
 * 先に置いた（Chromium の `<a download>` の攻撃は `downloadGuard.test.ts`）。
 * 実コード（ExternalMountManager、shellCommands、createProfileEgressGate）を使い、
 * electron は `app.getPath("userData")` と `dialog` だけを模す。
 * 拒否の前後で状態ファイルの bytes、mtime、inode が変わらないことを確かめる。
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandArgs } from "../shared/ipcContract.js";

// ── electron モック ─────────────────────────────────────────────────────────

let userDataDir = "";
const showSaveDialogMock = vi.fn();

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return userDataDir;
      return os.tmpdir();
    },
    getVersion: () => "1.0.0-test",
    getGPUFeatureStatus: () => ({ webgl2: "enabled" }),
  },
  dialog: { showSaveDialog: showSaveDialogMock, showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}));

const { ExternalMountManager } = await import("./externalMount.js");
const { buildShellCommandHandlers } = await import("./shellCommands.js");
const { createProfileEgressGate } = await import("./profileEgress.js");
const { handleWillDownload } = await import("./downloadGuard.js");
const { showSavePathDialog } = await import("./shellCommands.js");
const { getDefaultProfileDataGuard } =
  await import("./profileDataGuardDefault.js");

import type { ExternalMountManagerOptions } from "./externalMount.js";
import type { NapiBackendLike } from "../shared/ipcContract.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const FORGED_STATE = JSON.stringify({
  schemaVersion: 2,
  profileId: "forged-profile",
  callerEpoch: 0,
  restricted: false,
  handlesInvalidated: false,
  inFlightStopped: true,
});
const GENUINE_STATE = JSON.stringify({
  schemaVersion: 2,
  profileId: "profile-1",
  callerEpoch: 1,
  restricted: true,
  handlesInvalidated: true,
  inFlightStopped: true,
});

const created: string[] = [];
let base = "";
let documents = "";
let dialogCwd = "";

function snapshot(file: string) {
  const meta = statSync(file, { bigint: true });
  return {
    bytes: readFileSync(file).toString("base64"),
    mtimeNs: meta.mtimeNs,
    ino: meta.ino,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grim-sf1-")));
  created.push(base);
  userDataDir = path.join(base, "userData");
  documents = path.join(base, "documents");
  dialogCwd = path.join(base, "dialog-cwd");
  for (const dir of [userDataDir, documents, dialogCwd]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path.join(userDataDir, "profile-egress.json"), GENUINE_STATE);
  writeFileSync(path.join(userDataDir, "license.json"), '{"key":"secret"}');
  writeFileSync(path.join(userDataDir, "global-settings.json"), "{}");
  writeFileSync(path.join(documents, "note.md"), "# note\n");
  showSaveDialogMock.mockReset();
});

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

async function gateFor(mode: "unrestricted" | "restricted") {
  const restricted = mode === "restricted";
  const status = {
    profileId: "profile-1",
    callerEpoch: 1,
    restricted,
    handlesInvalidated: restricted,
    inFlightStopped: true,
    sqlPolicy: {
      version: 1,
      protectedTables: ["messages"],
      protectedColumns: [],
    },
  };
  return createProfileEgressGate({
    initializeProfileEgress: async () => JSON.stringify(status),
    registerProfileEgressCaller: vi.fn(),
    invalidateProfileEgressCallers: vi.fn(),
  } as unknown as NapiBackendLike);
}

/** gate を通してから handler を呼ぶ（renderer の invoke と同じ順序）。 */
function dispatch(
  gate: Awaited<ReturnType<typeof gateFor>>,
  handlers: Record<string, (args: CommandArgs) => Promise<unknown>>,
  command: string,
  args: CommandArgs,
): Promise<unknown> {
  gate.assertInvoke(command, args);
  return handlers[command](args);
}

function newManager(
  gate: Awaited<ReturnType<typeof gateFor>>,
): InstanceType<typeof ExternalMountManager> {
  // 製品の配線（index.ts）と同じ。DA-1 の変更の前は manager が読まない option。
  const options = {
    profileDataGuard: getDefaultProfileDataGuard(),
    watcherFactory: () => ({
      on: () => undefined,
      close: () => Promise.resolve(),
    }),
    isProfileRestricted: () => gate.restricted || gate.unavailable,
  };
  return new ExternalMountManager(
    () => {},
    options as unknown as ExternalMountManagerOptions,
  );
}

const MODES = ["unrestricted", "restricted"] as const;

describe.each(MODES)("状態ファイルへの到達の遮断（%s）", (mode) => {
  it("対照: profile data directory に重ならない folder の登録・読取・書込みは動く", async () => {
    const gate = await gateFor(mode);
    const manager = newManager(gate);
    const handlers = manager.buildHandlers() as unknown as Record<
      string,
      (args: CommandArgs) => Promise<unknown>
    >;
    await dispatch(gate, handlers, "external_mount_register", {
      rootId: "docs",
      path: documents,
      label: "docs",
    });
    expect(
      await dispatch(gate, handlers, "external_mount_read_file", {
        rootId: "docs",
        relPath: "note.md",
      }),
    ).toBe("# note\n");
    await dispatch(gate, handlers, "external_mount_write_file", {
      rootId: "docs",
      relPath: "note.md",
      content: "# changed\n",
    });
    expect(readFileSync(path.join(documents, "note.md"), "utf8")).toBe(
      "# changed\n",
    );
    await manager.disposeAll();
  });

  it("現状の 24: userData を root に登録して状態ファイルを restricted:false で全置換できない", async () => {
    const gate = await gateFor(mode);
    const manager = newManager(gate);
    const handlers = manager.buildHandlers() as unknown as Record<
      string,
      (args: CommandArgs) => Promise<unknown>
    >;
    const stateFile = path.join(userDataDir, "profile-egress.json");
    const before = snapshot(stateFile);

    const registered = await dispatch(
      gate,
      handlers,
      "external_mount_register",
      {
        rootId: "attack",
        path: userDataDir,
        label: "attack",
      },
    ).then(
      () => true,
      () => false,
    );
    const overwritten = await dispatch(
      gate,
      handlers,
      "external_mount_write_file",
      {
        rootId: "attack",
        relPath: "profile-egress.json",
        content: FORGED_STATE,
      },
    ).then(
      () => true,
      () => false,
    );

    expect(registered).toBe(false);
    expect(overwritten).toBe(false);
    expect(snapshot(stateFile)).toEqual(before);
    expect(readFileSync(stateFile, "utf8")).toBe(GENUINE_STATE);
    await manager.disposeAll();
  });

  it("逆向き: 偽造した restricted:true を状態ファイルへ書けない（Main の確認を経ない activation）", async () => {
    // 状態ファイルが無い（または unrestricted の）profile に restricted:true を書く攻撃。
    const stateFile = path.join(userDataDir, "profile-egress.json");
    writeFileSync(stateFile, FORGED_STATE);
    const forgedRestricted = JSON.stringify({
      schemaVersion: 2,
      profileId: "forged-profile",
      callerEpoch: 1,
      restricted: true,
      handlesInvalidated: true,
      inFlightStopped: true,
    });
    const gate = await gateFor(mode);
    const manager = newManager(gate);
    const handlers = manager.buildHandlers() as unknown as Record<
      string,
      (args: CommandArgs) => Promise<unknown>
    >;
    const before = snapshot(stateFile);
    await dispatch(gate, handlers, "external_mount_register", {
      rootId: "attack",
      path: userDataDir,
      label: "attack",
    }).catch(() => undefined);
    await dispatch(gate, handlers, "external_mount_write_file", {
      rootId: "attack",
      relPath: "profile-egress.json",
      content: forgedRestricted,
    }).catch(() => undefined);
    expect(snapshot(stateFile)).toEqual(before);
    expect(readFileSync(stateFile, "utf8")).toBe(FORGED_STATE);
    await manager.disposeAll();
  });

  it("現状の 24: .md でない license.json を userData の root から読めない", async () => {
    const gate = await gateFor(mode);
    const manager = newManager(gate);
    const handlers = manager.buildHandlers() as unknown as Record<
      string,
      (args: CommandArgs) => Promise<unknown>
    >;
    await dispatch(gate, handlers, "external_mount_register", {
      rootId: "attack",
      path: userDataDir,
      label: "attack",
    }).catch(() => undefined);
    await expect(
      dispatch(gate, handlers, "external_mount_read_file", {
        rootId: "attack",
        relPath: "license.json",
      }),
    ).rejects.toThrow();
    await manager.disposeAll();
  });

  it.each([
    ["userData を含む folder", () => base],
    ["userData の中の folder", () => path.join(userDataDir, "sub")],
    ["userData への symlink", () => path.join(base, "link-to-userdata")],
  ])("root に登録できない: %s", async (_label, rootOf) => {
    mkdirSync(path.join(userDataDir, "sub"), { recursive: true });
    symlinkSync(userDataDir, path.join(base, "link-to-userdata"), "dir");
    const gate = await gateFor(mode);
    const manager = newManager(gate);
    const handlers = manager.buildHandlers() as unknown as Record<
      string,
      (args: CommandArgs) => Promise<unknown>
    >;
    const stateFile = path.join(userDataDir, "profile-egress.json");
    const before = snapshot(stateFile);
    await expect(
      dispatch(gate, handlers, "external_mount_register", {
        rootId: "attack",
        path: rootOf(),
        label: "attack",
      }),
    ).rejects.toThrow();
    expect(snapshot(stateFile)).toEqual(before);
    await manager.disposeAll();
  });

  it.each([
    ["export_save_text", { contents: FORGED_STATE }],
    [
      "export_save_bytes",
      { contentsBase64: Buffer.from(FORGED_STATE).toString("base64") },
    ],
  ])(
    "現状の 24: %s の suggestedName に状態ファイルの path を渡し、dialog が既定のまま保存されても上書きされない",
    async (command, payload) => {
      const gate = await gateFor(mode);
      const handlers = buildShellCommandHandlers(null) as unknown as Record<
        string,
        (args: CommandArgs) => Promise<unknown>
      >;
      const stateFile = path.join(userDataDir, "profile-egress.json");
      const before = snapshot(stateFile);
      // 利用者が既定の「保存」を押した dialog: 初期値が絶対 path ならその path、
      // 相対の名前なら dialog の現在の directory に保存される。
      showSaveDialogMock.mockImplementation(
        async (...a: unknown[]): Promise<unknown> => {
          const options = a[a.length - 1] as { defaultPath?: string };
          return {
            canceled: false,
            filePath: path.resolve(dialogCwd, options.defaultPath ?? "x"),
          };
        },
      );
      const result = await dispatch(gate, handlers, command, {
        suggestedName: stateFile,
        filterName: "JSON",
        extensions: ["json"],
        ...payload,
      }).then(
        (v) => ({ ok: true as const, v }),
        () => ({ ok: false as const }),
      );
      expect(readFileSync(stateFile, "utf8")).toBe(GENUINE_STATE);
      expect(snapshot(stateFile)).toEqual(before);
      // dialog の初期値は単一のファイル名で、絶対 path を dialog に載せない。
      const options = showSaveDialogMock.mock.calls[0]?.at(-1) as
        | { defaultPath?: string }
        | undefined;
      if (options?.defaultPath !== undefined) {
        expect(path.isAbsolute(options.defaultPath)).toBe(false);
        expect(options.defaultPath).not.toMatch(/[\\/\0]/);
      }
      // 結果が成功でも、書かれた先は profile data directory の外。
      if (result.ok && typeof result.v === "string") {
        expect(path.dirname(result.v)).not.toBe(userDataDir);
      }
    },
  );

  it.each([
    ["export_save_text", { contents: FORGED_STATE }],
    [
      "export_save_bytes",
      { contentsBase64: Buffer.from(FORGED_STATE).toString("base64") },
    ],
  ])(
    "%s: dialog の中で利用者が profile data directory の状態ファイルを選んでも、書く前に拒否される",
    async (command, payload) => {
      const gate = await gateFor(mode);
      const handlers = buildShellCommandHandlers(null) as unknown as Record<
        string,
        (args: CommandArgs) => Promise<unknown>
      >;
      const stateFile = path.join(userDataDir, "profile-egress.json");
      const before = snapshot(stateFile);
      showSaveDialogMock.mockResolvedValue({
        canceled: false,
        filePath: stateFile,
      });
      await expect(
        dispatch(gate, handlers, command, {
          suggestedName: "export.json",
          filterName: "JSON",
          extensions: ["json"],
          ...payload,
        }),
      ).rejects.toThrow();
      expect(snapshot(stateFile)).toEqual(before);
    },
  );

  it("suggestedName は絶対 path・相対 path・drive・UNC・NUL・区切りを含んでも dialog に単一のファイル名で渡る", async () => {
    const gate = await gateFor(mode);
    const handlers = buildShellCommandHandlers(null) as unknown as Record<
      string,
      (args: CommandArgs) => Promise<unknown>
    >;
    const names = [
      path.join(userDataDir, "profile-egress.json"),
      "../../userData/profile-egress.json",
      "..\\..\\userData\\profile-egress.json",
      "C:\\Users\\x\\AppData\\Roaming\\Grimodex\\profile-egress.json",
      "\\\\server\\share\\profile-egress.json",
      "a\0b/../c.json",
      "..",
      ".",
      "",
    ];
    for (const suggestedName of names) {
      showSaveDialogMock.mockReset();
      showSaveDialogMock.mockResolvedValue({ canceled: true });
      await dispatch(gate, handlers, "export_save_text", {
        suggestedName,
        filterName: "JSON",
        extensions: ["json"],
        contents: "x",
      });
      const options = showSaveDialogMock.mock.calls[0]?.at(-1) as {
        defaultPath: string;
      };
      expect(options.defaultPath).not.toMatch(/[\\/\0]/);
      expect(options.defaultPath).not.toBe(".");
      expect(options.defaultPath).not.toBe("..");
      expect(options.defaultPath.length).toBeGreaterThan(0);
    }
  });
});

// ── Chromium の `<a download>`（現状の 24）──────────────────────────────────

describe.each(MODES)("状態ファイルへの到達の遮断: download（%s）", () => {
  it("renderer が download の名前を profile-egress.json にし、利用者の dialog が profile data directory を選んでも上書きされない", async () => {
    const stateFile = path.join(userDataDir, "profile-egress.json");
    const before = snapshot(stateFile);
    const guard = getDefaultProfileDataGuard();
    // 製品の配線（downloadGuardElectron.ts）と同じ: 保存先は Main の保存 dialog。
    showSaveDialogMock.mockResolvedValue({
      canceled: false,
      filePath: stateFile,
    });
    const notices: string[] = [];
    const item = Object.assign(new EventEmitter(), {
      savePath: null as string | null,
      cancelled: false,
      getFilename: () => "profile-egress.json",
      setSavePath(p: string) {
        this.savePath = p;
      },
      cancel() {
        this.cancelled = true;
      },
    });
    const webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
    });
    handleWillDownload(item, webContents, {
      guard,
      tmpdir: () => dialogCwd,
      pickSavePath: (_wc, options) => showSavePathDialog(null, options, guard),
      notify: (notice) => notices.push(notice),
    });
    // Chromium の保存先は profile data directory の外の temp。
    expect(item.savePath).not.toBeNull();
    expect(item.savePath!.startsWith(userDataDir)).toBe(false);
    writeFileSync(item.savePath!, FORGED_STATE);
    item.emit("done", {}, "completed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(snapshot(stateFile)).toEqual(before);
    expect(readFileSync(stateFile, "utf8")).toBe(GENUINE_STATE);
    expect(notices).toEqual(["rejected-destination"]);
  });
});
