import { describe, it, expect } from "vitest";
import { bytesToBase64 } from "./exportFile";

function decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

describe("bytesToBase64", () => {
  it("round-trips small byte sequences including 0x00 / 0xff", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 65, 66, 0]);
    expect(decode(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("round-trips across the 32 KiB chunk boundary (spans 3 chunks)", () => {
    const n = 0x8000 * 2 + 123;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
    const b64 = bytesToBase64(bytes);
    const decoded = decode(b64);
    expect(decoded.length).toBe(n);
    expect(decoded).toEqual(bytes);
  });

  it("encodes empty input to an empty string", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });
});
