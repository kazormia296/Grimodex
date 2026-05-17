/**
 * Grid drag-and-drop diagnostic logger.
 *
 * Off by default. Toggle from the DevTools console:
 *
 *   gridDndLog.on()      // enable
 *   gridDndLog.off()     // disable
 *   gridDndLog.toggle()  // flip
 *   gridDndLog.status()  // -> boolean
 *
 * State is persisted in localStorage ("grimodex.gridDndLog"), so the setting
 * survives reloads. Output goes to the browser console — no DebugLogViewer
 * integration.
 *
 * Logging at call sites should funnel through `glog(area, message, data?)`,
 * which is a no-op when disabled (so leaving the calls in is essentially free).
 */

const STORAGE_KEY = "grimodex.gridDndLog";

function readInitial(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = readInitial();

function persist(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // localStorage unavailable (private mode, etc.) — keep in-memory only
  }
}

/** Log a Grid DnD diagnostic line. No-op when logging is disabled. */
export function glog(area: string, message: string, data?: unknown): void {
  if (!enabled) return;
  if (data === undefined) {
    console.log(`[GridDnD/${area}] ${message}`);
  } else {
    console.log(`[GridDnD/${area}] ${message}`, data);
  }
}

export const gridDndLogControl = {
  on(): void {
    enabled = true;
    persist();
    console.log("[GridDnD] logging ON");
  },
  off(): void {
    enabled = false;
    persist();
    console.log("[GridDnD] logging OFF");
  },
  toggle(): boolean {
    enabled = !enabled;
    persist();
    console.log(`[GridDnD] logging ${enabled ? "ON" : "OFF"}`);
    return enabled;
  },
  status(): boolean {
    return enabled;
  },
};

// Expose on window so users can type `gridDndLog.on()` in the DevTools console.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).gridDndLog = gridDndLogControl;
}
