/**
 * ExternalMountManager の単体テスト（vitest node 環境）。
 * fs 側は実一時ディレクトリ、watcher 側は注入した fake で駆動する。
 * Tauri commands/external_mount.rs + watch.rs の registry / overlap / rollback /
 * debounce / broadcast parity を gate する。
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXTERNAL_MOUNT_RESTRICTED_EXTENSION_CODE,
  ExternalMountManager,
} from "./externalMount.js";
import type { MountWatcher, WatcherFactory } from "./externalMount.js";
import {
  PROFILE_DATA_GUARD_ERROR_CODE,
  createProfileDataGuard,
} from "./profileDataGuard.js";

// ── fake watcher ──────────────────────────────────────────────────────────────

class FakeWatcher implements MountWatcher {
  readonly listeners: Record<string, Array<(a: unknown) => void>> = {};
  closed = false;
  constructor(readonly rootPath: string) {}
  on(event: string, listener: (a: never) => void): unknown {
    (this.listeners[event] ??= []).push(listener as (a: unknown) => void);
    return this;
  }
  emit(event: string, arg: unknown): void {
    for (const l of this.listeners[event] ?? []) l(arg);
  }
  /** root 直下の相対パスから watcher が報告する絶対パスを組む。 */
  fire(event: "add" | "change" | "unlink", rel: string): void {
    this.emit(event, path.join(this.rootPath, rel));
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function makeFactory(): { factory: WatcherFactory; watchers: FakeWatcher[] } {
  const watchers: FakeWatcher[] = [];
  const factory: WatcherFactory = (rootPath) => {
    const w = new FakeWatcher(rootPath);
    watchers.push(w);
    return w;
  };
  return { factory, watchers };
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const created: string[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `gmx-em-${name}-`));
  created.push(dir);
  return dir;
}

function withFiles(name: string): string {
  const dir = tempDir(name);
  writeFileSync(path.join(dir, "a.md"), "alpha");
  mkdirSync(path.join(dir, "chapter"));
  writeFileSync(path.join(dir, "chapter", "01.md"), "one");
  return dir;
}

/** root と重ならない profile data directory を指す guard（SF-1 の通常の構成）。 */
function guardOptions(): {
  profileDataGuard: ReturnType<typeof createProfileDataGuard>;
} {
  const profileDir = tempDir("profile");
  return { profileDataGuard: createProfileDataGuard(() => profileDir) };
}

const tick = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Captured {
  channel: string;
  payload: { rootId: string; relPath: string; oldRelPath: string | null };
}

function build(debounceMs = 5): {
  manager: ExternalMountManager;
  events: Captured[];
  watchers: FakeWatcher[];
} {
  const events: Captured[] = [];
  const { factory, watchers } = makeFactory();
  const manager = new ExternalMountManager(
    (channel, payload) =>
      events.push({ channel, payload: payload as Captured["payload"] }),
    { watcherFactory: factory, debounceMs, ...guardOptions() },
  );
  return { manager, events, watchers };
}

// ── registry / rollback ─────────────────────────────────────────────────────

describe("register", () => {
  it("root を登録して scan を返す", async () => {
    const { manager } = build();
    const dir = withFiles("reg");
    const scan = await manager.register("r1", dir, "Root 1");
    expect(scan.files.map((f) => f.relPath).sort()).toEqual([
      "a.md",
      "chapter/01.md",
    ]);
    expect(scan.dirs.some((d) => d.relPath === "chapter")).toBe(true);
  });

  it("重複（子）root を overlap で拒否（Rust try_register_rejects_child_of_existing）", async () => {
    const { manager } = build();
    const parent = tempDir("ov-parent");
    const child = path.join(parent, "sub");
    mkdirSync(child);
    await manager.register("parent", parent, "Parent");
    await expect(manager.register("child", child, "Child")).rejects.toThrow(
      /overlaps/,
    );
    // child は未登録 → scan は unknown root
    await expect(manager.scan("child")).rejects.toThrow(
      /unknown external root/,
    );
  });

  it("watcher 起動失敗時に root をロールバック（Rust register_with_rollback）", async () => {
    const events: Captured[] = [];
    const boomFactory: WatcherFactory = () => {
      throw new Error("watcher boom");
    };
    const manager = new ExternalMountManager(
      (c, p) => events.push({ channel: c, payload: p as Captured["payload"] }),
      { watcherFactory: boomFactory, debounceMs: 5, ...guardOptions() },
    );
    const dir = withFiles("rollback");
    await expect(manager.register("r", dir, "R")).rejects.toThrow(
      /watcher boom/,
    );
    // ロールバック済み = orphan mount なし
    await expect(manager.scan("r")).rejects.toThrow(/unknown external root/);
  });

  it("ディレクトリ以外を拒否", async () => {
    const { manager } = build();
    const dir = tempDir("notdir");
    const file = path.join(dir, "f.md");
    writeFileSync(file, "x");
    await expect(manager.register("r", file, "R")).rejects.toThrow(
      /not a directory/,
    );
  });

  it("相対パス（unsafe）を拒否", async () => {
    const { manager } = build();
    await expect(manager.register("r", "relative/dir", "R")).rejects.toThrow(
      /must be absolute/,
    );
  });
});

// ── read / write / mtime / scan ───────────────────────────────────────────────

describe("read / write / mtime", () => {
  it("write→read ラウンドトリップ + CRLF 正規化", async () => {
    const { manager } = build();
    const dir = withFiles("rw");
    await manager.register("r", dir, "R");
    await manager.writeFile("r", "a.md", "line1\r\nline2");
    expect(await manager.readFile("r", "a.md")).toBe("line1\nline2");
  });

  it("未知 root は unknown external root", async () => {
    const { manager } = build();
    await expect(manager.readFile("nope", "a.md")).rejects.toThrow(
      /unknown external root/,
    );
  });

  it("traversal を拒否", async () => {
    const { manager } = build();
    const dir = withFiles("trav");
    await manager.register("r", dir, "R");
    await expect(manager.readFile("r", "../escape.md")).rejects.toThrow(
      /traversal/,
    );
  });

  it("mtime を ISO で返す", async () => {
    const { manager } = build();
    const dir = withFiles("mt");
    await manager.register("r", dir, "R");
    const iso = await manager.fileMtime("r", "a.md");
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── watcher → broadcast ───────────────────────────────────────────────────────

describe("watcher broadcast", () => {
  it(".md の add を debounce 後に file-added として全窓 broadcast", async () => {
    const { manager, events, watchers } = build();
    const dir = withFiles("w-add");
    await manager.register("r", dir, "R");
    watchers[0].fire("add", "new.md");
    expect(events).toHaveLength(0); // debounce 前は未配信
    await tick();
    expect(events).toEqual([
      {
        channel: "external-mount://file-added",
        payload: { rootId: "r", relPath: "new.md", oldRelPath: null },
      },
    ]);
  });

  it("unlink+add を順序保持で配信（FE rename 再構成が removed→added 順に依存）", async () => {
    const { manager, events, watchers } = build();
    const dir = withFiles("w-rename");
    await manager.register("r", dir, "R");
    watchers[0].fire("unlink", "old.md");
    watchers[0].fire("add", "renamed.md");
    await tick();
    expect(events.map((e) => e.channel)).toEqual([
      "external-mount://file-removed",
      "external-mount://file-added",
    ]);
    expect(events[0].payload.relPath).toBe("old.md");
    expect(events[1].payload.relPath).toBe("renamed.md");
  });

  it("change を file-changed へ / ネストの relPath は forward slash", async () => {
    const { manager, events, watchers } = build();
    const dir = withFiles("w-change");
    await manager.register("r", dir, "R");
    watchers[0].fire("change", path.join("chapter", "01.md"));
    await tick();
    expect(events[0].channel).toBe("external-mount://file-changed");
    expect(events[0].payload.relPath).toBe("chapter/01.md");
  });

  it("非 .md イベントは無視", async () => {
    const { manager, events, watchers } = build();
    const dir = withFiles("w-nonmd");
    await manager.register("r", dir, "R");
    watchers[0].fire("add", "notes.txt");
    watchers[0].fire("change", "image.png");
    await tick();
    expect(events).toHaveLength(0);
  });

  it("debounce 内の連続イベントを 1 バッチに合流", async () => {
    const { manager, events, watchers } = build(30);
    const dir = withFiles("w-batch");
    await manager.register("r", dir, "R");
    watchers[0].fire("change", "a.md");
    await tick(10);
    watchers[0].fire("change", "a.md"); // deadline リセット
    await tick(10);
    expect(events).toHaveLength(0); // まだ deadline 前
    await tick(40);
    expect(events).toHaveLength(2); // 両方が 1 バッチで flush
  });
});

// ── unregister / dispose ──────────────────────────────────────────────────────

describe("unregister / disposeAll", () => {
  it("unregister が watcher を閉じ pending を破棄", async () => {
    const { manager, events, watchers } = build();
    const dir = withFiles("unreg");
    await manager.register("r", dir, "R");
    watchers[0].fire("add", "x.md");
    manager.unregister("r"); // debounce 発火前に unregister
    await tick();
    expect(watchers[0].closed).toBe(true);
    expect(events).toHaveLength(0); // pending 破棄で未配信
    await expect(manager.scan("r")).rejects.toThrow(/unknown external root/);
  });

  it("disposeAll が全 watcher を閉じる", async () => {
    const { manager, watchers } = build();
    const a = withFiles("d-a");
    const b = withFiles("d-b");
    await manager.register("a", a, "A");
    await manager.register("b", b, "B");
    await manager.disposeAll();
    expect(watchers.every((w) => w.closed)).toBe(true);
  });
});

// ── handlers ──────────────────────────────────────────────────────────────────

describe("buildHandlers", () => {
  it("6 コマンドを公開し register が ScanResult / unregister が null を返す", async () => {
    const { manager } = build();
    const handlers = manager.buildHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "external_mount_file_mtime",
      "external_mount_read_file",
      "external_mount_register",
      "external_mount_scan",
      "external_mount_unregister",
      "external_mount_write_file",
    ]);
    const dir = withFiles("h");
    const scan = (await handlers.external_mount_register({
      rootId: "r",
      path: dir,
      label: "R",
    })) as { files: unknown[] };
    expect(Array.isArray(scan.files)).toBe(true);
    expect(
      await handlers.external_mount_unregister({ rootId: "r" }),
    ).toBeNull();
  });

  it("引数型不正を拒否", async () => {
    const { manager } = build();
    const handlers = manager.buildHandlers();
    await expect(
      handlers.external_mount_read_file({ rootId: "r", relPath: 42 }),
    ).rejects.toThrow(/expected a string/);
  });
});

// ── SF-1: profile data directory の保護 ─────────────────────────────────────

function buildWithProfile(
  profileDir: string,
  isProfileRestricted?: () => boolean,
): ExternalMountManager {
  const { factory } = makeFactory();
  return new ExternalMountManager(() => {}, {
    watcherFactory: factory,
    debounceMs: 5,
    profileDataGuard: createProfileDataGuard(() => profileDir),
    isProfileRestricted,
  });
}

describe("SF-1: profile data directory に届かない", () => {
  it("等しい／含む／含まれる root は登録できず、registry と scan に残らない", async () => {
    const parent = tempDir("sf1-parent");
    const profile = path.join(parent, "userData");
    mkdirSync(path.join(profile, "sub"), { recursive: true });
    writeFileSync(path.join(profile, "profile-egress.json"), "{}");
    writeFileSync(path.join(profile, "note.md"), "# n");
    const manager = buildWithProfile(profile);
    for (const root of [profile, parent, path.join(profile, "sub")]) {
      await expect(manager.register("r", root, "R")).rejects.toThrow(
        new RegExp(PROFILE_DATA_GUARD_ERROR_CODE),
      );
      await expect(manager.scan("r")).rejects.toThrow(/unknown external root/);
    }
  });

  it("拒否の理由に path を含めない", async () => {
    const parent = tempDir("sf1-msg");
    const profile = path.join(parent, "userData-secret-name");
    mkdirSync(profile);
    const manager = buildWithProfile(profile);
    const error = await manager.register("r", profile, "R").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain(PROFILE_DATA_GUARD_ERROR_CODE);
    expect(error?.message).not.toContain("userData-secret-name");
    expect(error?.message).not.toContain(parent);
  });

  it("登録後に root の下の symlink で profile data directory へ抜けても read／write／mtime を拒否する", async () => {
    const parent = tempDir("sf1-late");
    const profile = path.join(parent, "userData");
    mkdirSync(profile);
    writeFileSync(path.join(profile, "profile-egress.json"), '{"a":1}');
    const root = path.join(parent, "root");
    mkdirSync(root);
    writeFileSync(path.join(root, "ok.md"), "ok");
    const manager = buildWithProfile(profile);
    await manager.register("r", root, "R");
    // 登録の後に root の下へ profile data directory への symlink が現れる。
    symlinkSync(profile, path.join(root, "link"), "dir");
    // 既存の包含検査が root の外への解決を拒否する。
    await expect(
      manager.readFile("r", "link/profile-egress.json"),
    ).rejects.toThrow();
    // 登録の後に root の下の .md が profile data directory の file への symlink になる。
    writeFileSync(path.join(profile, "danger.md"), "danger");
    symlinkSync(path.join(profile, "danger.md"), path.join(root, "evil.md"));
    await expect(manager.readFile("r", "evil.md")).rejects.toThrow();
    await expect(manager.writeFile("r", "evil.md", "x")).rejects.toThrow();
    await expect(manager.fileMtime("r", "evil.md")).rejects.toThrow();
    expect(readFileSync(path.join(profile, "danger.md"), "utf8")).toBe(
      "danger",
    );
  });

  it("scan は symlink を辿らず、profile data directory の中を読まない", async () => {
    const parent = tempDir("sf1-scan");
    const profile = path.join(parent, "userData");
    mkdirSync(profile);
    writeFileSync(path.join(profile, "secret.md"), "secret");
    const root = path.join(parent, "root");
    mkdirSync(root);
    writeFileSync(path.join(root, "ok.md"), "ok");
    symlinkSync(profile, path.join(root, "link"), "dir");
    symlinkSync(path.join(profile, "secret.md"), path.join(root, "s.md"));
    const manager = buildWithProfile(profile);
    const scan = await manager.register("r", root, "R");
    expect(scan.files.map((f) => f.relPath)).toEqual(["ok.md"]);
    expect(JSON.stringify(scan)).not.toContain("secret");
  });

  it("guard を構成しない manager は何も登録しない（fail closed）", async () => {
    const dir = withFiles("sf1-noguard");
    const manager = new ExternalMountManager(() => {}, {
      watcherFactory: makeFactory().factory,
    });
    await expect(manager.register("r", dir, "R")).rejects.toThrow(
      new RegExp(PROFILE_DATA_GUARD_ERROR_CODE),
    );
  });
});

// ── E-3: restricted の間は .md だけ ─────────────────────────────────────────

describe("E-3: restricted の間の read／write／mtime は .md に限る", () => {
  const FILES = [
    "noext",
    "a.json",
    "run.sh",
    "app.desktop",
    "UPPER.MD",
    "mixed.Md",
  ];

  async function prepared(restricted: () => boolean) {
    const profile = tempDir("e3-profile");
    const root = tempDir("e3-root");
    writeFileSync(path.join(root, "a.md"), "md");
    for (const name of FILES) writeFileSync(path.join(root, name), name);
    const manager = buildWithProfile(profile, restricted);
    await manager.register("r", root, "R");
    return { manager, root };
  }

  it.each(FILES)(
    "restricted: %s の read／write／mtime を typed に拒否する",
    async (name) => {
      const { manager, root } = await prepared(() => true);
      const pattern = new RegExp(EXTERNAL_MOUNT_RESTRICTED_EXTENSION_CODE);
      await expect(manager.readFile("r", name)).rejects.toThrow(pattern);
      await expect(manager.writeFile("r", name, "x")).rejects.toThrow(pattern);
      await expect(manager.fileMtime("r", name)).rejects.toThrow(pattern);
      expect(readFileSync(path.join(root, name), "utf8")).toBe(name);
    },
  );

  it("restricted: .md は read／write／mtime が通る", async () => {
    const { manager, root } = await prepared(() => true);
    expect(await manager.readFile("r", "a.md")).toBe("md");
    await manager.writeFile("r", "a.md", "changed");
    expect(readFileSync(path.join(root, "a.md"), "utf8")).toBe("changed");
    expect(await manager.fileMtime("r", "a.md")).toMatch(/^\d{4}-/);
  });

  it("restricted: 拒否の理由に file 名と path を含めない", async () => {
    const { manager, root } = await prepared(() => true);
    const error = await manager.readFile("r", "a.json").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).not.toContain("a.json");
    expect(error?.message).not.toContain(root);
  });

  it("restricted: 拡張子は解決した最終 path で見る（.md の名前の symlink が .json を指しても拒否）", async () => {
    const { manager, root } = await prepared(() => true);
    symlinkSync(path.join(root, "a.json"), path.join(root, "alias.md"));
    await expect(manager.readFile("r", "alias.md")).rejects.toThrow(
      new RegExp(EXTERNAL_MOUNT_RESTRICTED_EXTENSION_CODE),
    );
  });

  it("unrestricted: 拡張子を問わず通る（挙動を変えない）", async () => {
    const { manager, root } = await prepared(() => false);
    for (const name of FILES) {
      expect(await manager.readFile("r", name)).toBe(name);
      await manager.writeFile("r", name, `new-${name}`);
      expect(readFileSync(path.join(root, name), "utf8")).toBe(`new-${name}`);
      expect(await manager.fileMtime("r", name)).toMatch(/^\d{4}-/);
    }
  });

  it("gate の状態は呼出しごとに読む（unrestricted → restricted の切替が次の呼出しから効く）", async () => {
    let restricted = false;
    const { manager } = await prepared(() => restricted);
    expect(await manager.readFile("r", "a.json")).toBe("a.json");
    restricted = true;
    await expect(manager.readFile("r", "a.json")).rejects.toThrow(
      new RegExp(EXTERNAL_MOUNT_RESTRICTED_EXTENSION_CODE),
    );
  });

  it("restricted でも root の選択と登録時の scan は変わらない", async () => {
    const profile = tempDir("e3-profile2");
    const root = withFiles("e3-scan");
    writeFileSync(path.join(root, "x.json"), "{}");
    const manager = buildWithProfile(profile, () => true);
    const scan = await manager.register("r", root, "R");
    expect(scan.files.map((f) => f.relPath).sort()).toEqual([
      "a.md",
      "chapter/01.md",
    ]);
    expect((await manager.scan("r")).files).toHaveLength(2);
  });
});
