/**
 * Electron の userData 配置を ready / single-instance lock より前に確定する。
 * 本番だけ既存 Tauri (`com.miyakey.grimodex`) と同じ data_dir を使い、
 * development は引き続き専用ディレクトリへ隔離する。
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEVELOPMENT_APP_NAME = "GrimodexElectronDev";
export const PRODUCTION_APP_NAME = "Grimodex";
const LEGACY_TAURI_DIRECTORY = "com.miyakey.grimodex";

type SupportedPlatform = "linux" | "darwin" | "win32";

export interface UserDataResolutionOptions {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  /** Electron `app.getPath("appData")`; development uses this base. */
  appDataDir: string;
}

export interface UserDataConfiguration {
  appName: string;
  userDataDir: string;
}

function pathApiFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function requireAbsolute(
  value: string,
  label: string,
  platform: NodeJS.Platform,
): string {
  if (!pathApiFor(platform).isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path: ${value}`);
  }
  return value;
}

function packagedDataBase(options: UserDataResolutionOptions): string {
  const { platform, env, homeDir, appDataDir } = options;
  switch (platform as SupportedPlatform) {
    case "linux": {
      const xdgDataHome = env.XDG_DATA_HOME;
      if (xdgDataHome && path.posix.isAbsolute(xdgDataHome)) {
        return xdgDataHome;
      }
      return path.posix.join(
        requireAbsolute(homeDir, "home directory", platform),
        ".local",
        "share",
      );
    }
    case "darwin":
      return path.posix.join(
        requireAbsolute(homeDir, "home directory", platform),
        "Library",
        "Application Support",
      );
    case "win32":
      return requireAbsolute(env.APPDATA ?? appDataDir, "APPDATA", platform);
    default:
      throw new Error(`Unsupported Electron platform: ${platform}`);
  }
}

/** Pure path decision used by both startup and unit tests. */
export function resolveUserDataConfiguration(
  options: UserDataResolutionOptions,
): UserDataConfiguration {
  const { isPackaged, platform, env, appDataDir } = options;
  const appName = isPackaged ? PRODUCTION_APP_NAME : DEVELOPMENT_APP_NAME;
  const override = env.GRIMODEX_USER_DATA_DIR;
  if (override !== undefined) {
    return {
      appName,
      userDataDir: requireAbsolute(
        override,
        "GRIMODEX_USER_DATA_DIR",
        platform,
      ),
    };
  }

  const pathApi = pathApiFor(platform);
  const base = isPackaged
    ? packagedDataBase(options)
    : requireAbsolute(appDataDir, "Electron appData directory", platform);
  return {
    appName,
    userDataDir: pathApi.join(
      base,
      isPackaged ? LEGACY_TAURI_DIRECTORY : DEVELOPMENT_APP_NAME,
    ),
  };
}

export interface ElectronAppPathController {
  readonly isPackaged: boolean;
  setName(name: string): void;
  setPath(name: "userData", value: string): void;
  getPath(name: "appData" | "userData"): string;
}

export interface ConfigureUserDataOptions {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  ensureDirectory?: (directory: string) => void;
}

/**
 * Configure and create userData synchronously. Call this before
 * `requestSingleInstanceLock()` because both the lock and all native storage
 * must observe one directory for the entire process lifetime.
 */
export function configureAppUserData(
  app: ElectronAppPathController,
  options: ConfigureUserDataOptions = {},
): string {
  const appName = app.isPackaged ? PRODUCTION_APP_NAME : DEVELOPMENT_APP_NAME;
  app.setName(appName);

  const configuration = resolveUserDataConfiguration({
    isPackaged: app.isPackaged,
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? homedir(),
    appDataDir: app.getPath("appData"),
  });
  app.setPath("userData", configuration.userDataDir);
  (
    options.ensureDirectory ??
    ((directory) => mkdirSync(directory, { recursive: true }))
  )(configuration.userDataDir);
  return configuration.userDataDir;
}
