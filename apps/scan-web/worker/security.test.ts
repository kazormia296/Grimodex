import { describe, expect, it } from "vitest";
import { sha256Hex, sha256HexBytes } from "./security";

const ABC_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("worker security", () => {
  it("runs in the worker test environment without DOM globals", () => {
    expect("document" in globalThis).toBe(false);
  });

  it("hashes strings and byte buffers with Web Crypto", async () => {
    const bytes = new TextEncoder().encode("abc");

    await expect(sha256Hex("abc")).resolves.toBe(ABC_SHA256);
    await expect(sha256HexBytes(bytes.buffer)).resolves.toBe(ABC_SHA256);
  });
});
