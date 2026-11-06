// 評価（試験の仕組み）専用。API key を名前付きパイプ（FIFO）で 1 回だけ受け渡す。平文を
// ディスクに残さないための経路で、key の値・長さは返り値以外に出さない。
//
// - FIFO は自分が所有する 0700 の dir の下に、権限 600 で作る（makeKeyFifo）。
// - 書き手（writeKeyToFifo）は O_CREAT を付けずに開き、開いた fd で FIFO・所有者・権限を
//   確かめてから書く（stat と open の間の差し替えで通常 file に書かない）。
// - 読み手（readKeyFromFifo）は期限つきで読む。書き手が来なければ止まらずに失敗する。
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertOwnedFifoFd(fd) {
  const info = fstatSync(fd);
  if (!info.isFIFO()) throw new Error("[key] FIFO でない");
  if (info.uid !== process.getuid())
    throw new Error("[key] FIFO の所有者が違う");
  if ((info.mode & 0o077) !== 0) throw new Error("[key] FIFO の権限は 600");
}

function assertPrivateParent(fifo) {
  const dir = lstatSync(path.dirname(fifo));
  if (
    !dir.isDirectory() ||
    dir.uid !== process.getuid() ||
    (dir.mode & 0o077) !== 0
  )
    throw new Error("[key] FIFO の dir は自分の所有で 0700");
}

/** 自分の所有の 0700 の dir の下に、権限 600 の FIFO を作る。 */
export function makeKeyFifo(parent) {
  const dir = mkdtempSync(path.join(parent, "key-fifo-"));
  const fifo = path.join(dir, "key.fifo");
  execFileSync("mkfifo", ["-m", "600", fifo]);
  assertPrivateParent(fifo);
  return {
    dir,
    fifo,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 読み手として先に開いておき、期限まで key を待つ。書き手が全部を書いて閉じたら返す。
 * 何も来ないまま期限が来たら失敗する（書き手が起動前に落ちても止まらない）。
 */
export async function readKeyFromFifo(
  fifo,
  { timeoutMs = 120000, signal } = {},
) {
  assertPrivateParent(fifo);
  const fd = openSync(
    fifo,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    assertOwnedFifoFd(fd);
    const chunks = [];
    const buffer = Buffer.alloc(4096);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // 書き手が失敗して終わったら、期限を待たずに止める。
      if (signal?.aborted) throw new Error("[key] 書き手が失敗した");
      let n;
      try {
        n = readSync(fd, buffer, 0, buffer.length, null);
      } catch (error) {
        if (error?.code !== "EAGAIN") throw error;
        n = -1;
      }
      if (n > 0) chunks.push(Buffer.from(buffer.subarray(0, n)));
      // 書き手が居ない間の read は 0 を返す。受け取った後の 0 は書き手が閉じた印。
      else if (n === 0 && chunks.length > 0) break;
      else await sleep(100);
    }
    if (chunks.length === 0) throw new Error("[key] 期限までに key が届かない");
    return Buffer.concat(chunks).toString("utf8").trim();
  } finally {
    closeSync(fd);
  }
}

/** 書き手。読み手が FIFO を開くまで期限つきで待ち、1 回だけ書いて閉じる。 */
export async function writeKeyToFifo(fifo, value, { timeoutMs = 60000 } = {}) {
  assertPrivateParent(fifo);
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(
        fifo,
        constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
    } catch (error) {
      // ENXIO：読み手がまだ居ない。
      if (error?.code !== "ENXIO" || Date.now() >= deadline) throw error;
      await sleep(100);
    }
  }
  try {
    assertOwnedFifoFd(fd);
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > 4096) throw new Error("[key] 値が長すぎる");
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}
