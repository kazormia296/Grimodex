import { readFileSync } from "node:fs";

/** Read a runtime credential from a pipe without placing it in argv or logs. */
export function readRuntimeKeyFromStdin() {
  return parseRuntimeKey(readFileSync(0, "utf8"));
}

export function parseRuntimeKey(input) {
  if (typeof input !== "string") throw new Error("LIVE_JUDGE_KEY_INVALID");
  const nul = input.indexOf("\0");
  const key = (nul >= 0 ? input.slice(0, nul) : input).trim();
  if (
    key.length < 8 ||
    key.length > 512 ||
    /[\u0000\r\n]/.test(key) ||
    !/^sk-[A-Za-z0-9._-]+$/.test(key)
  ) {
    throw new Error("LIVE_JUDGE_KEY_INVALID");
  }
  return key;
}

