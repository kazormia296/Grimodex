import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers";
import { makeKeyFifo, readKeyFromFifo, writeKeyToFifo } from "./fifo-key.mjs";

const VALUE = "sk-ant-test-0123456789abcdefghijklmnopqrstuvwxyz";

test("書き手が書いた値を読み手が 1 回だけ受け取る", async () => {
  const { fifo, cleanup } = makeKeyFifo(os.tmpdir());
  try {
    const reading = readKeyFromFifo(fifo, { timeoutMs: 5000 });
    await writeKeyToFifo(fifo, VALUE, { timeoutMs: 5000 });
    assert.equal(await reading, VALUE);
  } finally {
    cleanup();
  }
});

test("FIFO の dir は 0700、FIFO は 600", () => {
  const { dir, fifo, cleanup } = makeKeyFifo(os.tmpdir());
  try {
    assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    const info = lstatSync(fifo);
    assert.ok(info.isFIFO());
    assert.equal(info.mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test("書き手が来なければ、読み手は期限で失敗する（止まらない）", async () => {
  const { fifo, cleanup } = makeKeyFifo(os.tmpdir());
  try {
    await assert.rejects(
      readKeyFromFifo(fifo, { timeoutMs: 300 }),
      /届かない/u,
    );
  } finally {
    cleanup();
  }
});

test("書き手の失敗（signal）で、読み手は期限を待たずに止まる", async () => {
  const { fifo, cleanup } = makeKeyFifo(os.tmpdir());
  try {
    const abort = new globalThis.AbortController();
    setTimeout(() => abort.abort(), 50);
    const started = Date.now();
    await assert.rejects(
      readKeyFromFifo(fifo, { timeoutMs: 10000, signal: abort.signal }),
      /書き手が失敗/u,
    );
    assert.ok(Date.now() - started < 2000);
  } finally {
    cleanup();
  }
});

test("読み手が来なければ、書き手は期限で失敗する（止まらない）", async () => {
  const { fifo, cleanup } = makeKeyFifo(os.tmpdir());
  try {
    await assert.rejects(writeKeyToFifo(fifo, VALUE, { timeoutMs: 300 }), {
      code: "ENXIO",
    });
  } finally {
    cleanup();
  }
});

test("FIFO が通常の file に差し替わっていたら、書き手は書かない", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "key-fifo-"));
  chmodSync(dir, 0o700);
  const file = path.join(dir, "key.fifo");
  writeFileSync(file, "", { mode: 0o600 });
  try {
    await assert.rejects(
      writeKeyToFifo(file, VALUE, { timeoutMs: 300 }),
      /FIFO でない/u,
    );
    assert.equal(readFileSync(file, "utf8"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dir が 0700 でなければ、読み手も書き手も使わない", async () => {
  const { dir, fifo, cleanup } = makeKeyFifo(os.tmpdir());
  try {
    chmodSync(dir, 0o755);
    await assert.rejects(readKeyFromFifo(fifo, { timeoutMs: 300 }), /0700/u);
    await assert.rejects(
      writeKeyToFifo(fifo, VALUE, { timeoutMs: 300 }),
      /0700/u,
    );
  } finally {
    cleanup();
  }
});
