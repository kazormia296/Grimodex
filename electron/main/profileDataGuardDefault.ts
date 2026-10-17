/**
 * 製品の既定の profile data directory の guard（K3/2 SF-1。DA-1）。
 *
 * 保護する directory は、Main が Native の `appDataDir` に渡す
 * `app.getPath("userData")`（backend.ts）と同じ値で、呼出しごとに解決する。
 * electron に依存するので、guard 本体（profileDataGuard.ts）とは分ける。
 */
import { app } from "electron";

import { createProfileDataGuard } from "./profileDataGuard.js";
import type { ProfileDataGuard } from "./profileDataGuard.js";

let defaultGuard: ProfileDataGuard | null = null;

export function getDefaultProfileDataGuard(): ProfileDataGuard {
  defaultGuard ??= createProfileDataGuard(() => app.getPath("userData"));
  return defaultGuard;
}
