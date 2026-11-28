# 起動の掃除 — 判断の記録（DR-SC）

旗を開ける前に起動時の JS を減らす作業の判断を残す。担当の割り当てと条件は、ユーザーの決定（contracts `user-confirmation-2026-11-26-integrator-s11-leftovers.md` の問 33〜35）による。上限は緩めず、上限の行は書き換えず、画面の挙動は変えない。

## 判断

- **DR-SC-1（desktop の renderer の build で temporal-polyfill を標準の Temporal にする、2026-11-28）**：`temporal-polyfill` 1.0.1 の入口は `globalThis.Temporal || polyfill` で、標準の実装がある環境では polyfill の本体を使わない。Electron 43.8.3 の renderer（Chromium 150.0.7871.250）に標準の `Temporal` があることを画面なしの起動で確かめた（試験で使う Playwright の Chromium 148 にもある）。そこで vite の alias で `temporal-polyfill` を `src/lib/nativeTemporalShim.ts` に置き換え、使われない本体を build から外す。置き換える条件は `build` であること、mode が `web-editor` でないこと、`TAURI_ENV_PLATFORM` が無いことの 3 つ（`vite.config.ts`。`src/lib/nativeTemporalShim.test.ts` が vite の設定を読み込んで 4 通りを固定する。条件を別の `src/` の file に分けると、node 設定の project への登録が要り、root の型検査が落ちる）。Web Editor は利用者の browser で動き、凍結中の Tauri shell は同じ `dist/` を WebView で読むので、どちらも polyfill のまま（Tauri の schema は beforeBuildCommand に `TAURI_ENV_PLATFORM` を立てると定める）。shim は標準が無い環境では読み込みの時点で例外にする。共有の `electron/shared/readDomain/lib/temporal.ts`、Electron main、standalone MCP、Node の試験は変えない。実測は master `066395c20` に対して起動時の JS が raw −56,381 byte／gzip −18,683 byte。
- 既存の事実として記録（この判断では変えない）：製品の renderer は標準の `Temporal`、Node の試験と CED/1 の Rust 側の並びの実測表は polyfill 1.0.1 を基準にしている。
- 残る制限（独立レビュー、2026-11-28。code は変えない）：desktop の build の `dist/` を標準の `Temporal` の無い browser で開くと、shim が読み込みで例外にし、起動の画面のまま止まる。製品の Electron は当たらず、当たりうるのは開発者の `pnpm preview` などの経路。Electron の build の環境に `TAURI_ENV_PLATFORM` が残っていると置き換えが外れるが、削減が失われるだけで挙動は変わらない。

## 信頼境界

- build の設定だけの変更で、送信・保存・認可・IPC は変えない。
- 製品の画面が実行時に使う Temporal の実装は変わらない。
