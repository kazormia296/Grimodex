import type { GlobalSettings } from "./GlobalSettings";

export interface GlobalSettingsRepository {
  read(): Promise<GlobalSettings>;
  write(settings: GlobalSettings): Promise<void>;
  /**
   * Update an immutable snapshot. Returning `current` unchanged is an explicit
   * no-op and skips persistence.
   */
  patch(
    updater: (current: GlobalSettings) => GlobalSettings,
  ): Promise<GlobalSettings>;
  updateUserPreference(key: string, value: string): Promise<void>;
}
