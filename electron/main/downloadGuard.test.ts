/**
 * downloadGuard の単体テスト（K3/2 SF-1 の 8、Negative (25) の `<a download>` の攻撃。DA-1）。
 * fake の DownloadItem と実一時 directory で、保存先の確定前に profile data directory へ
 * 書かないこと、完了後に保存先を検査すること、temp を残さないことを固定する。
 */
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleWillDownload, installDownloadGuard } from "./downloadGuard.js";
import type {
  DownloadGuardDeps,
  DownloadItemLike,
  DownloadNotice,
  DownloadWebContentsLike,
} from "./downloadGuard.js";
import { createProfileDataGuard } from "./profileDataGuard.js";

class FakeItem extends EventEmitter implements DownloadItemLike {
  savePath: string | null = null;
  cancelled = false;
  constructor(
    private readonly filename: string,
    private readonly content = "downloaded",
  ) {
    super();
  }
  getFilename(): string {
    return this.filename;
  }
  setSavePath(savePath: string): void {
    this.savePath = savePath;
  }
  cancel(): void {
    this.cancelled = true;
  }
  /** Chromium が保存先に書いて完了する。 */
  finish(state: "completed" | "cancelled" | "interrupted"): void {
    if (state === "completed" && this.savePath) {
      writeFileSync(this.savePath, this.content);
    }
    this.emit("done", {}, state);
  }
}

class FakeWebContents extends EventEmitter implements DownloadWebContentsLike {
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

let base = "";
let tmp = "";
let profile = "";
let documents = "";

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grim-dl-")));
  tmp = path.join(base, "os-tmp");
  profile = path.join(base, "userData");
  documents = path.join(base, "documents");
  for (const dir of [tmp, profile, documents]) mkdirSync(dir);
  writeFileSync(path.join(profile, "profile-egress.json"), "genuine");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function makeDeps(
  pick: (name: string) => string | null,
  overrides: Partial<DownloadGuardDeps> = {},
): {
  deps: DownloadGuardDeps;
  notices: DownloadNotice[];
  picks: string[];
} {
  const notices: DownloadNotice[] = [];
  const picks: string[] = [];
  const deps: DownloadGuardDeps = {
    guard: createProfileDataGuard(() => profile),
    tmpdir: () => tmp,
    pickSavePath: async (_wc, options) => {
      picks.push(options.suggestedName);
      return pick(options.suggestedName);
    },
    notify: (notice) => notices.push(notice),
    ...overrides,
  };
  return { deps, notices, picks };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5));
};

// copy と temp 削除の完了は負荷で遅れる。固定待ちだけに頼らず、空になるまで待つ。
const expectEmptyDir = async (dir: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (readdirSync(dir).length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(readdirSync(dir)).toEqual([]);
};

describe("handleWillDownload", () => {
  it("保存先を同期に OS の temp の新規 directory へ向け、profile data directory に書かない", async () => {
    const { deps } = makeDeps(() => null);
    const item = new FakeItem("report.json");
    handleWillDownload(item, new FakeWebContents(), deps);
    // handler が戻った時点で保存先が決まっている（決まらないと既定の dialog が開く）。
    expect(item.savePath).not.toBeNull();
    expect(path.dirname(path.dirname(item.savePath!))).toBe(tmp);
    expect(item.savePath!.startsWith(profile)).toBe(false);
    await settle();
    expect(item.cancelled).toBe(false);
    item.finish("cancelled");
  });

  it("通常の保存先へ書き出せる: 完了後に利用者が選んだ保存先へ copy し、temp を削除する", async () => {
    const dest = path.join(documents, "report.json");
    const { deps, notices, picks } = makeDeps(() => dest);
    const item = new FakeItem("report.json", "BODY");
    handleWillDownload(item, new FakeWebContents(), deps);
    item.finish("completed");
    await settle();
    expect(picks).toEqual(["report.json"]);
    expect(readFileSync(dest, "utf8")).toBe("BODY");
    expect(notices).toEqual([]);
    await expectEmptyDir(tmp);
  });

  it("`<a download>` の攻撃: 名前を profile-egress.json にし、利用者の dialog が profile data directory を選んでも上書きされない", async () => {
    const state = path.join(profile, "profile-egress.json");
    const { deps, notices } = makeDeps(() => state);
    const item = new FakeItem("profile-egress.json", '{"restricted":false}');
    handleWillDownload(item, new FakeWebContents(), deps);
    item.finish("completed");
    await settle();
    expect(readFileSync(state, "utf8")).toBe("genuine");
    expect(notices).toEqual(["rejected-destination"]);
    await expectEmptyDir(tmp);
  });

  it("保存先が profile data directory の下の存在しない file でも拒否する", async () => {
    const target = path.join(profile, "bin", "grimodex-mcp");
    const { deps, notices } = makeDeps(() => target);
    const item = new FakeItem("grimodex-mcp");
    handleWillDownload(item, new FakeWebContents(), deps);
    item.finish("completed");
    await settle();
    expect(existsSync(target)).toBe(false);
    expect(notices).toEqual(["rejected-destination"]);
  });

  it("利用者が保存 dialog を取り消したら何も書かず、temp を削除する", async () => {
    const { deps, notices } = makeDeps(() => null);
    const item = new FakeItem("report.json");
    handleWillDownload(item, new FakeWebContents(), deps);
    item.finish("completed");
    await settle();
    expect(notices).toEqual([]);
    await expectEmptyDir(tmp);
    expect(readdirSync(documents)).toEqual([]);
  });

  it("取消（cancelled）は dialog を開かず、通知せず、temp を削除する", async () => {
    const { deps, notices, picks } = makeDeps(() => null);
    const item = new FakeItem("report.json");
    handleWillDownload(item, new FakeWebContents(), deps);
    item.finish("cancelled");
    await settle();
    expect(picks).toEqual([]);
    expect(notices).toEqual([]);
    await expectEmptyDir(tmp);
  });

  it("中断（interrupted）は dialog を開かず、failed を通知し、temp を削除する", async () => {
    const { deps, notices, picks } = makeDeps(() => null);
    const item = new FakeItem("report.json");
    handleWillDownload(item, new FakeWebContents(), deps);
    item.finish("interrupted");
    await settle();
    expect(picks).toEqual([]);
    expect(notices).toEqual(["failed"]);
    await expectEmptyDir(tmp);
  });

  it("窓（webContents）が閉じたら item を取り消し、完了の通知で temp を削除する", async () => {
    const { deps, picks } = makeDeps(() => path.join(documents, "x.json"));
    const item = new FakeItem("x.json");
    const wc = new FakeWebContents();
    handleWillDownload(item, wc, deps);
    wc.destroy();
    expect(item.cancelled).toBe(true);
    item.finish("cancelled");
    await settle();
    expect(picks).toEqual([]);
    await expectEmptyDir(tmp);
    // 閉じた窓の listener は残らない。
    expect(wc.listenerCount("destroyed")).toBe(0);
  });

  it("すでに閉じた窓の download は開始時に取り消す", () => {
    const { deps } = makeDeps(() => null);
    const item = new FakeItem("x.json");
    const wc = new FakeWebContents();
    wc.destroyed = true;
    handleWillDownload(item, wc, deps);
    expect(item.cancelled).toBe(true);
  });

  it("完了後は webContents の destroyed の listener を外す", async () => {
    const { deps } = makeDeps(() => null);
    const item = new FakeItem("x.json");
    const wc = new FakeWebContents();
    handleWillDownload(item, wc, deps);
    expect(wc.listenerCount("destroyed")).toBe(1);
    item.finish("completed");
    await settle();
    expect(wc.listenerCount("destroyed")).toBe(0);
  });

  it("temp directory が作れないときは download を取り消して failed を通知する", () => {
    const { deps, notices } = makeDeps(() => null, {
      tmpdir: () => path.join(base, "no-such-tmp"),
    });
    const item = new FakeItem("x.json");
    handleWillDownload(item, new FakeWebContents(), deps);
    expect(item.cancelled).toBe(true);
    expect(item.savePath).toBeNull();
    expect(notices).toEqual(["failed"]);
  });

  it("temp が profile data directory の中にある構成は download を取り消す（安全網）", async () => {
    const { deps, notices } = makeDeps(() => null, {
      tmpdir: () => path.join(profile, "bin"),
    });
    mkdirSync(path.join(profile, "bin"));
    const item = new FakeItem("x.json");
    handleWillDownload(item, new FakeWebContents(), deps);
    await settle();
    expect(item.cancelled).toBe(true);
    expect(notices).toEqual(["rejected-destination"]);
    await expectEmptyDir(path.join(profile, "bin"));
  });

  it("copy の失敗は failed を通知し、temp を削除する", async () => {
    const { deps, notices } = makeDeps(() =>
      path.join(documents, "missing-dir", "x.json"),
    );
    const item = new FakeItem("x.json");
    handleWillDownload(item, new FakeWebContents(), deps);
    item.finish("completed");
    await settle();
    expect(notices).toEqual(["failed"]);
    await expectEmptyDir(tmp);
  });

  it("download ごとに独立した temp directory を使う（再入）", async () => {
    const { deps } = makeDeps((name) => path.join(documents, name));
    const a = new FakeItem("a.txt", "A");
    const b = new FakeItem("b.txt", "B");
    handleWillDownload(a, new FakeWebContents(), deps);
    handleWillDownload(b, new FakeWebContents(), deps);
    expect(path.dirname(a.savePath!)).not.toBe(path.dirname(b.savePath!));
    a.finish("completed");
    b.finish("completed");
    await settle();
    expect(readFileSync(path.join(documents, "a.txt"), "utf8")).toBe("A");
    expect(readFileSync(path.join(documents, "b.txt"), "utf8")).toBe("B");
    await expectEmptyDir(tmp);
  });
});

describe("installDownloadGuard", () => {
  it("session の will-download に 1 回だけ付ける", () => {
    const on = vi.fn();
    const session = { on };
    const { deps } = makeDeps(() => null);
    installDownloadGuard(session, deps);
    installDownloadGuard(session, deps);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("will-download");
  });

  it("will-download の handler は item ごとに保存先を決める", () => {
    let handler: ((...args: never[]) => void) | undefined;
    const session = {
      on: (_event: string, listener: (...args: never[]) => void) => {
        handler = listener;
      },
    };
    const { deps } = makeDeps(() => null);
    installDownloadGuard(session, deps);
    const item = new FakeItem("x.json");
    (handler as unknown as (...a: unknown[]) => void)(
      {},
      item,
      new FakeWebContents(),
    );
    expect(item.savePath).not.toBeNull();
    item.finish("cancelled");
  });
});
