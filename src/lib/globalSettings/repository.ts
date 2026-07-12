import { invoke } from "@/lib/tauri";
import type { GlobalSettings } from "./GlobalSettings";
import type { GlobalSettingsRepository } from "./GlobalSettingsRepository";

/**
 * Serializes every global-settings read-modify-write operation in this
 * renderer. The Rust write lock protects one file write, not the read→write
 * interval, so keeping the chain here prevents stale slices from overwriting
 * each other across feature stores.
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = chain.then(operation);
  // Keep the queue usable after a failed operation. The caller still
  // receives the original rejection and decides how to surface it.
  chain = run.catch(() => {});
  return run;
}

export const globalSettingsRepository: GlobalSettingsRepository = {
  read: () => invoke<GlobalSettings>("get_global_settings"),

  patch(updater) {
    return enqueue(async () => {
      const current = await globalSettingsRepository.read();
      const next = updater(current);
      await invoke("save_global_settings", { settings: next });
      return next;
    });
  },

  write(settings) {
    return enqueue(async () => {
      await invoke("save_global_settings", { settings });
    });
  },

  async updateUserPreference(key, value) {
    await globalSettingsRepository.patch((current) => ({
      ...current,
      userPreferences: {
        ...(current.userPreferences ?? {}),
        [key]: value,
      },
    }));
  },
};

/**
 * Compatibility facade for existing feature persistence callers. New code
 * should depend on `globalSettingsRepository.patch` directly.
 */
export function patchGlobalSettings(
  updater: (current: GlobalSettings) => GlobalSettings,
): Promise<GlobalSettings> {
  return globalSettingsRepository.patch(updater);
}
