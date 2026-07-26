/**
 * ExternalMountManager の単体テスト（vitest node 環境）。
 * fs 側は実一時ディレクトリ、watcher 側は注入した fake で駆動する。
 * Tauri commands/external_mount.rs + watch.rs の registry / overlap / rollback /
 * debounce / broadcast parity を gate する。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExternalMountManager } from "./externalMount.js";
import type { MountWatcher, WatcherFactory } from "./externalMount.js";

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
    { watcherFactory: factory, debounceMs },
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
      { watcherFactory: boomFactory, debounceMs: 5 },
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
