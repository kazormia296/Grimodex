/**
 * モデル能力の registry の写し：main の配線（PR-C2）。index.ts を小さく保つため、設定・cache・scheduler・
 * 読み取り専用の IPC をここで組み立て、index.ts は `create`・`start`・`dispose` と backend の差し替えだけを行う。
 * 設計の正本は docs/plans/model-capability-runtime-fetch-precheck.md の §7（Q2〜Q6・Q14・Q17）と §7.3。
 *
 * この module は electron を import しない（`app`・`process.resourcesPath` は呼び出し側が値で渡す）。
 */
import path from "node:path";

import type {
  CommandArgs,
  NapiBackendLike,
  ShellCommandHandlers,
} from "../shared/ipcContract.js";
import type {
  ModelEntry,
  Snapshot,
} from "../shared/modelCapabilityRegistry.js";
import {
  MODEL_CAPABILITY_SNAPSHOT_COMMAND,
  type ModelCapabilityOrigin,
  type ModelCapabilitySnapshotView,
} from "../shared/modelCapabilitySnapshotWire.js";
import type { ProfileEgressStatusView } from "../shared/profileEgressStatusWire.js";
import type {
  FetchLike,
  ModelCapabilityFetchTimers,
} from "./modelCapabilityFetch.js";
import {
  createModelCapabilityScheduler,
  type ModelCapabilitySchedule,
} from "./modelCapabilityScheduler.js";
import {
  createModelCapabilityStore,
  MODEL_CAPABILITY_BUNDLED_FILE,
} from "./modelCapabilityStore.js";
import {
  createModelInfoSetting,
  removeStaleModelInfoSettingTemporaryFiles,
  wrapBackendForModelInfoSetting,
} from "./modelInfoSetting.js";

/** 利用できる写しが無いときの error（renderer は自前の能力表へ落ちる）。 */
export const MODEL_CAPABILITY_SNAPSHOT_UNAVAILABLE =
  "MODEL_CAPABILITY_SNAPSHOT_UNAVAILABLE";

export interface BundledSnapshotResolution {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  /** main の bundle の directory（`<repo>/dist-electron`）。 */
  readonly mainDir: string;
}

/**
 * 同梱の写しの path。
 *   - packaged：electron-builder の extraResources が `resources/model-capabilities/` へ置く
 *     （`resolveSemanticResourceRoot` と同じ形）。
 *   - dev：repo の `electron/resources/`（master の raw 配信と同じ file）。
 */
export function resolveBundledSnapshotPath(
  resolution: BundledSnapshotResolution,
): string {
  if (resolution.isPackaged) {
    return path.join(
      resolution.resourcesPath,
      "resources",
      "model-capabilities",
      MODEL_CAPABILITY_BUNDLED_FILE,
    );
  }
  return path.join(
    resolution.mainDir,
    "..",
    "electron",
    "resources",
    MODEL_CAPABILITY_BUNDLED_FILE,
  );
}

export interface ModelCapabilityRuntimeOptions {
  /**
   * 取得の scheduler を start してよいか。呼び出し側は `app.isPackaged` を渡す（env や設定で上書きする
   * 入口は無い）。false（unpackaged の開発・CI・journey・評価の harness）では scheduler を作るだけで
   * start せず、通信は一度も起きない。IPC は同梱の写し（と、あれば cache）を読んで返す。
   */
  readonly isPackaged: boolean;
  readonly userDataDir: string;
  readonly bundledPath: string;
  readonly backend: NapiBackendLike | null;
  readonly profile: {
    statusView(): ProfileEgressStatusView;
    onStatusChange(
      listener: (view: ProfileEgressStatusView) => void,
    ): () => void;
  };
  /** 既定は Node の `globalThis.fetch`（Electron の `net.fetch` は使えない：Q15 の probe）。 */
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  readonly timers?: ModelCapabilityFetchTimers;
  readonly schedule?: Partial<ModelCapabilitySchedule>;
  readonly log?: (message: string) => void;
}

export interface ModelCapabilityRuntime {
  /** 「モデル情報の自動更新」を AiSettings の往復に載せた backend。registerIpcRouter へはこちらを渡す。 */
  readonly backend: NapiBackendLike | null;
  /** 読み取り専用の typed IPC（1 本）。取得を始める command は無い。 */
  readonly handlers: ShellCommandHandlers;
  start(): void;
  dispose(): Promise<void>;
  /** 採用済みの写し（cache、無ければ同梱）。IPC と試験の入口。 */
  readAdoptedSnapshot(): ModelCapabilitySnapshotView;
}

function toView(
  origin: ModelCapabilityOrigin,
  snapshot: Snapshot,
): ModelCapabilitySnapshotView {
  const models: Record<string, ModelEntry> = {};
  for (const [key, entry] of Object.entries(snapshot.models)) {
    models[key] = { ...entry };
  }
  return {
    origin,
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
    models,
  };
}

export function createModelCapabilityRuntime(
  options: ModelCapabilityRuntimeOptions,
): ModelCapabilityRuntime {
  const now = options.now ?? (() => Date.now());
  // 前回の crash・kill で残った自分の tmp を、書込みの前に片付ける（命名規則に完全一致するものだけ）。
  removeStaleModelInfoSettingTemporaryFiles(options.userDataDir);
  const setting = createModelInfoSetting(options.userDataDir, options.log);
  const store = createModelCapabilityStore({
    cacheDir: options.userDataDir,
    bundledPath: options.bundledPath,
  });
  store.removeStaleTemporaryFiles();

  // profile の状態は、通知された値を持つ（listener は stage 2 の `activating` でも呼ばれる）。
  let profileState = options.profile.statusView().state;
  const scheduler = createModelCapabilityScheduler({
    fetchImpl:
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
    store,
    now,
    isEnabled: () => setting.get(),
    isProfileOpen: () => profileState === "unrestricted",
    timers: options.timers,
    schedule: options.schedule,
    log: options.log,
  });
  setting.onChange(() => scheduler.onSettingChanged());
  options.profile.onStatusChange((view) => {
    profileState = view.state;
    scheduler.onProfileChanged();
  });

  const readAdoptedSnapshot = (): ModelCapabilitySnapshotView => {
    const nowMs = now();
    // 設定が無効の間は同梱の写しだけを使う（Q4。cache も削除済み）。restricted でも cache の読出しは可（Q2）。
    if (setting.get()) {
      const cache = store.readCache(nowMs);
      if (cache.ok) return toView("cache", cache.snapshot);
    }
    const bundled = store.loadBundled(nowMs);
    if (bundled.ok) return toView("bundled", bundled.snapshot);
    throw new Error(MODEL_CAPABILITY_SNAPSHOT_UNAVAILABLE);
  };

  const handlers: ShellCommandHandlers = {
    [MODEL_CAPABILITY_SNAPSHOT_COMMAND]: (args: CommandArgs) => {
      // 引数は受けない。renderer が値を送っても、取得先・path・cache の扱いには効かない。
      if (args !== undefined && args !== null && Object.keys(args).length > 0) {
        return Promise.reject(
          new Error(
            `${MODEL_CAPABILITY_SNAPSHOT_COMMAND} does not take arguments`,
          ),
        );
      }
      try {
        return Promise.resolve(readAdoptedSnapshot());
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };

  return {
    backend: wrapBackendForModelInfoSetting(options.backend, setting),
    handlers,
    start: () => {
      // unpackaged では start しない。scheduler は started でなければ admission を開かないので、
      // 設定の変更や profile の通知が来ても取得は始まらない。
      if (options.isPackaged) scheduler.start();
    },
    dispose: () => scheduler.dispose(),
    readAdoptedSnapshot,
  };
}
