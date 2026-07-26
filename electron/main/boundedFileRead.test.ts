import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readUtf8FileHandleWithLimit } from "./boundedFileRead.js";

type ReadableFileHandle = Pick<FileHandle, "read" | "stat">;

function fakeHandle(
  declaredSize: number,
  content: Buffer,
  maxChunkBytes = content.byteLength,
): ReadableFileHandle {
  return {
    stat: vi.fn(async () => ({
      isFile: () => true,
      size: declaredSize,
    })) as never,
    read: vi.fn(
      async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const bytesRead = Math.min(
          length,
          maxChunkBytes,
          Math.max(0, content.byteLength - position),
        );
        if (bytesRead > 0) {
          content.copy(buffer, offset, position, position + bytesRead);
        }
        return { bytesRead, buffer };
      },
    ) as never,
  };
}

describe("readUtf8FileHandleWithLimit", () => {
  it("stat 後に追記された maxBytes + 1 byte を観測して拒否する", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "grimodex-bounded-read-"));
    const file = path.join(dir, "append-after-stat.txt");
    await writeFile(file, "abcd", "utf8");
    const handle = await open(file, "r");
    const appendAfterStatHandle = {
      stat: async () => {
        const stats = await handle.stat();
        await appendFile(file, "ef", "utf8");
        return stats;
      },
      read: handle.read.bind(handle),
    } as ReadableFileHandle;

    try {
      await expect(
        readUtf8FileHandleWithLimit(appendAfterStatHandle, {
          maxBytes: 5,
          tooLargeError: (observed) => new Error(`too-large:${observed}`),
        }),
      ).rejects.toThrow("too-large:6");
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("chunk 境界を跨ぐ UTF-8 を上限ちょうどまで復号する", async () => {
    const content = Buffer.from("あいう", "utf8");
    const handle = fakeHandle(content.byteLength, content, 1);

    await expect(
      readUtf8FileHandleWithLimit(handle, {
        maxBytes: content.byteLength,
      }),
    ).resolves.toBe("あいう");
  });

  it("通常ファイル以外を読まない", async () => {
    const handle = {
      stat: vi.fn(async () => ({ isFile: () => false, size: 0 })),
      read: vi.fn(),
    } as unknown as ReadableFileHandle;

    await expect(
      readUtf8FileHandleWithLimit(handle, {
        maxBytes: 1,
        notFileError: () => new Error("not-a-file"),
      }),
    ).rejects.toThrow("not-a-file");
    expect(handle.read).not.toHaveBeenCalled();
  });
});
