import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

const BOUNDED_READ_CHUNK_BYTES = 64 * 1024;

type ReadableFileHandle = Pick<FileHandle, "read" | "stat">;

export interface BoundedUtf8HandleReadOptions {
  maxBytes: number;
  notFileError?: () => Error;
  tooLargeError?: (observedBytes: number) => Error;
}

export interface BoundedUtf8FileReadOptions extends BoundedUtf8HandleReadOptions {
  flags?: string | number;
}

function assertValidMaxBytes(maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
}

function defaultNotFileError(): Error {
  return new Error("selected path is not a regular file");
}

function defaultTooLargeError(observedBytes: number, maxBytes: number): Error {
  return new Error(
    `file is too large (${observedBytes} bytes, limit ${maxBytes} bytes)`,
  );
}

/**
 * Read UTF-8 from an already-open file handle without ever materializing more
 * than `maxBytes`. The stat check is only an early rejection; the authoritative
 * limit is enforced while reading `maxBytes + 1` bytes from the same handle.
 */
export async function readUtf8FileHandleWithLimit(
  handle: ReadableFileHandle,
  options: BoundedUtf8HandleReadOptions,
): Promise<string> {
  const { maxBytes } = options;
  assertValidMaxBytes(maxBytes);

  const stats = await handle.stat();
  if (!stats.isFile()) {
    throw (options.notFileError ?? defaultNotFileError)();
  }
  const tooLarge = (observedBytes: number): Error =>
    options.tooLargeError?.(observedBytes) ??
    defaultTooLargeError(observedBytes, maxBytes);
  if (stats.size > maxBytes) {
    throw tooLarge(stats.size);
  }

  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  const buffer = Buffer.allocUnsafe(BOUNDED_READ_CHUNK_BYTES);
  let position = 0;
  let totalBytes = 0;

  while (true) {
    const bytesToRead = Math.min(buffer.byteLength, maxBytes - totalBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      throw tooLarge(totalBytes);
    }
    chunks.push(
      decoder.decode(buffer.subarray(0, bytesRead), { stream: true }),
    );
    position += bytesRead;
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

/** Open, bounded-read, and close a UTF-8 file. */
export async function readUtf8FileWithLimit(
  filePath: string,
  options: BoundedUtf8FileReadOptions,
): Promise<string> {
  const handle = await open(filePath, options.flags ?? "r");
  try {
    return await readUtf8FileHandleWithLimit(handle, options);
  } finally {
    await handle.close();
  }
}
