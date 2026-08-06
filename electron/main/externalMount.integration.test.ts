/**
 * ExternalMountManager の **実 chokidar** 統合テスト（fake 注入なし）。
 *
 * 単体テスト（externalMount.test.ts）は FakeWatcher を注入するため、
 * defaultWatcherFactory の chokidar 設定（`ignoreInitial` / `followSymlinks` /
 * `atomic:false`）と add/change/unlink → channel 写像の**実挙動**が未検証だった
 * （敵対的レビュー指摘）。ここで実ファイル操作を駆動して gate する。
 *
 * ⚠ fs 監視はタイミング依存。ready 待ち + ポーリング + 余裕あるタイムアウトで
 * flakiness を抑える。rename の removed→added 順（FE の node-identity 保持が
 * 依存する不変条件）は **inotify(Linux) 固有**のため厳密順序 assert は linux 限定、
 * 他 OS では両イベントの到達のみ確認する（macOS/Windows は Phase 4 実機で検証）。
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExternalMountManager } from "./externalMount.js";

interface Captured {
  channel: string;
  payload: { rootId: string; relPath: string; oldRelPath: string | null };
}

const managers: ExternalMountManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const m of managers.splice(0)) await m.disposeAll();
  for (const d of dirs.splice(0)) {
    rmSync(d, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gmx-emint-"));
  dirs.push(dir);
  return dir;
}

/** predicate を満たす状態になるまでポーリング（fs 監視の非同期性を吸収）。 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 4000,
  stepMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!predicate()) throw new Error("waitUntil timed out");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("ExternalMountManager 実 chokidar 統合", () => {
  it("ignoreInitial: 既存 .md を added で洪水化しない / add・change・unlink を写像し rename は removed→added 順", async () => {
    const events: Captured[] = [];
    const manager = new ExternalMountManager(
      (channel, payload) =>
        events.push({ channel, payload: payload as Captured["payload"] }),
      { debounceMs: 40 },
    );
    managers.push(manager);

    const dir = tempDir();
    writeFileSync(path.join(dir, "existing.md"), "hi");

    const scan = await manager.register("r", dir, "R");
    expect(scan.files.map((f) => f.relPath)).toEqual(["existing.md"]);

    // ignoreInitial: 監視開始直後、既存ファイルの added が来ないこと。
    await sleep(500);
    expect(
      events.some((e) => e.channel === "external-mount://file-added"),
    ).toBe(false);

    // add
    writeFileSync(path.join(dir, "new.md"), "new");
    await waitUntil(() =>
      events.some(
        (e) =>
          e.channel === "external-mount://file-added" &&
          e.payload.relPath === "new.md",
      ),
    );

    // change
    writeFileSync(path.join(dir, "existing.md"), "changed");
    await waitUntil(() =>
      events.some(
        (e) =>
          e.channel === "external-mount://file-changed" &&
          e.payload.relPath === "existing.md",
      ),
    );

    // rename（別名）= chokidar は unlink+add で報告。
    const renameFrom = events.length;
    renameSync(path.join(dir, "new.md"), path.join(dir, "renamed.md"));
    await waitUntil(() =>
      events
        .slice(renameFrom)
        .some(
          (e) =>
            e.channel === "external-mount://file-added" &&
            e.payload.relPath === "renamed.md",
        ),
    );
    // debounce flush の残りも取り込む
    await sleep(150);

    const renameEvents = events
      .slice(renameFrom)
      .filter(
        (e) =>
          e.payload.relPath === "new.md" || e.payload.relPath === "renamed.md",
      );
    const removed = renameEvents.find(
      (e) => e.channel === "external-mount://file-removed",
    );
    const added = renameEvents.find(
      (e) => e.channel === "external-mount://file-added",
    );
    expect(removed?.payload.relPath).toBe("new.md");
    expect(added?.payload.relPath).toBe("renamed.md");

    if (process.platform === "linux") {
      // inotify 由来: removed(old) が added(new) より前 = FE rename 再構成の前提。
      const removedIdx = renameEvents.indexOf(removed!);
      const addedIdx = renameEvents.indexOf(added!);
      expect(removedIdx).toBeLessThan(addedIdx);
    }
  });

  it("readFile / writeFile が実ファイルへラウンドトリップ（CRLF→LF）", async () => {
    const manager = new ExternalMountManager(() => {}, { debounceMs: 40 });
    managers.push(manager);
    const dir = tempDir();
    writeFileSync(path.join(dir, "a.md"), "seed");
    await manager.register("r", dir, "R");

    await manager.writeFile("r", "a.md", "x\r\ny");
    expect(await manager.readFile("r", "a.md")).toBe("x\ny");
  });
});
