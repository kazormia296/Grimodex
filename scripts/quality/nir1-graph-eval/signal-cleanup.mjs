// CP-4 S1f レビュー P2-4 (d): the one SIGTERM／SIGINT handler of a harness
// process. The Xvfb wrapper cancels by SIGTERM and SIGKILL 500 ms later, so
// the handler kills synchronously, then exits: every registered hook
// (session.mjs: the live Electron sessions and the child Electron groups)
// and every live process group the harness spawned itself (keep-test.mjs:
// the vitest runner and its forks). It is installed before the first child
// is spawned, so a cancel during the keep test kills it too.

import process from "node:process";

const HOOKS = new Set();
const GROUPS = new Set();
let installed = false;

export function addCleanupHook(hook) {
  HOOKS.add(hook);
}

/** Registers a live process group (its leader's pid); returns the remover. */
export function registerLiveGroup(pgid) {
  GROUPS.add(pgid);
  return () => GROUPS.delete(pgid);
}

export function liveGroups() {
  return [...GROUPS];
}

export function killLiveGroupsSync({ kill = process.kill } = {}) {
  const killed = [];
  for (const pgid of GROUPS)
    try {
      kill(-pgid, "SIGKILL");
      killed.push(pgid);
    } catch {
      // the group is gone
    }
  return killed;
}

export function cleanupHandlersInstalled() {
  return installed;
}

export function installCleanupHandlers() {
  if (installed) return;
  installed = true;
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ])
    process.once(signal, () => {
      for (const hook of HOOKS)
        try {
          hook();
        } catch {
          // keep killing the rest
        }
      killLiveGroupsSync();
      process.exit(code);
    });
}
