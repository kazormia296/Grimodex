import type { GlobalSettings } from "./GlobalSettings";

export interface GlobalSettingsRepository {
  read(): Promise<GlobalSettings>;
  write(settings: GlobalSettings): Promise<void>;
  patch(
    updater: (current: GlobalSettings) => GlobalSettings,
  ): Promise<GlobalSettings>;
  updateUserPreference(key: string, value: string): Promise<void>;
}
